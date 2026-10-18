import SERVICES from "./services.js";
import { buildMessages, extractIntent, resolveSetWatch, describeConfig } from "./nl.js";
import { REMINDERS, dueSlots, inAnyWindow, buildMessage, DEADLINES, dueDeadlines, inDeadlineWindow, deadlineMessage } from "./reminders.js";

const NL_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const NL_DAILY_CAP = 40;

const API_V2 = "https://api.shore.com/v2";
const API_V3 = "https://api.shore.com/v3";
const SHORE_HEADERS = {
  "Content-Type": "application/json",
  "X-Shore-Origin": "booking-widget",
};

const RESOURCES = [
  { id: "", name: "상관없음 (가장 빠른 직원)" },
  { id: "88ae1994-dd27-4819-9f7b-fad4abf80d74", name: "Leehyun" },
  { id: "5f919e8d-2846-4891-80b0-bfc5987e1e99", name: "An" },
];

export default {
  async scheduled(event, env, ctx) {
    // Cron min granularity is 1min — run N sub-polls spaced 20s inside one
    // invocation for ~20s effective latency. Waiting costs no CPU time.
    const iterations = Math.max(1, Math.min(3, int(env.POLL_ITERATIONS, 3)));
    // Reminders run on their own so they work while auto-booking is off.
    ctx.waitUntil(runReminders(env).catch(() => {}));
    ctx.waitUntil((async () => {
      for (let i = 0; i < iterations; i++) {
        try {
          const r = await tick(env, { dryRun: false });
          if (r && r.status === "disabled") break;
        } catch {}
        if (i < iterations - 1) await scheduler.wait(20000);
      }
    })());
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const authed = !env.ADMIN_KEY || url.searchParams.get("key") === env.ADMIN_KEY;

    try {
      switch (url.pathname) {
        case "/":
          if (!authed) return new Response("forbidden", { status: 403 });
          return new Response(settingsPage(env), { headers: { "Content-Type": "text/html; charset=utf-8" } });
        case "/config": {
          if (!authed) return new Response("forbidden", { status: 403 });
          if (request.method === "GET") return json(await getConfig(env));
          const body = await request.json();
          const cfg = validateConfig(body);
          const prev = await getConfig(env);
          await env.STATE.put("config", JSON.stringify(cfg));
          if (prev.enabled !== cfg.enabled) {
            await notify(env, cfg.enabled
              ? `자동 예약을 켰어요. ${cfg.dateFrom} ~ ${cfg.dateTo} 범위에서 빈자리를 찾아요.`
              : "자동 예약을 껐어요. 지금은 빈자리를 조회하지 않아요.");
          }
          return json({ ok: true, config: cfg });
        }
        case "/notify-test":
          if (!authed) return new Response("forbidden", { status: 403 });
          return json({ sent: await notify(env, "알림 테스트예요. 이 메시지가 보이면 연결이 정상이에요.") });
        case "/status": {
          if (!authed) return new Response("forbidden", { status: 403 });
          const [config, booked, lastTick] = await Promise.all([
            getConfig(env),
            env.STATE.get("booked", { type: "json" }),
            env.STATE.get("lastTick", { type: "json" }),
          ]);
          return json({ config, booked, lastTick });
        }
        case "/check":
          if (!authed) return new Response("forbidden", { status: 403 });
          return json(await tick(env, { dryRun: true }));
        case "/book-now":
          if (!authed) return new Response("forbidden", { status: 403 });
          return json(await tick(env, { dryRun: false }));
        case "/reset":
          if (!authed) return new Response("forbidden", { status: 403 });
          await Promise.all([
            env.STATE.delete("booked"),
            env.STATE.delete("pendingConfirm"),
            env.STATE.delete("confirmed"),
          ]);
          return new Response("state cleared");
        case "/telegram":
          return handleTelegram(request, env, ctx);
        case "/reminder-test": {
          if (!authed) return new Response("forbidden", { status: 403 });
          const id = url.searchParams.get("id") || "face";
          const dl = DEADLINES.find((x) => x.id === id);
          if (dl) {
            const b = berlinParts(new Date());
            const today = `${b.year}-${pad(b.month)}-${pad(b.day)}`;
            const days = Math.round((Date.parse(dl.date) - Date.parse(today)) / 86400000);
            return json({ sent: Boolean(await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: deadlineMessage(dl, Math.max(days, 0)) })) });
          }
          const r = REMINDERS.find((x) => x.id === id);
          if (!r) return json({ error: "unknown reminder" }, 404);
          return json({ sent: Boolean(await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: buildMessage(r) })) });
        }
        case "/nl-test": {
          if (!authed) return new Response("forbidden", { status: 403 });
          const q = url.searchParams.get("q") || "";
          const t0 = Date.now();
          const r = await nlParse(env, q, url.searchParams.get("model") || undefined);
          return json({ ...r, ms: Date.now() - t0 });
        }
        case "/debug-raw": {
          if (!authed) return new Response("forbidden", { status: 403 });
          const raw = await env.STATE.get("debug:lastRaw");
          return new Response(raw || "no raw stored");
        }
        default:
          return new Response("shore-sniper ok");
      }
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

async function tick(env, { dryRun }) {
  const config = await getConfig(env);
  const booked = await env.STATE.get("booked", { type: "json" });
  if (booked) {
    await saveLastTick(env, { result: "already_booked" });
    return { status: "already_booked", booked };
  }
  if (!config.enabled && !dryRun) {
    await saveLastTick(env, { result: "disabled" });
    return { status: "disabled" };
  }

  const all = [];
  let sawTimes = false;
  const fetchErrors = [];
  const rawSample = [];
  for (const w of config.watches) {
    let days;
    try {
      days = await fetchAvailability(env, w, config);
    } catch (e) {
      fetchErrors.push(e.message);
      continue;
    }
    for (const day of days) {
      for (const t of day.times || []) {
        sawTimes = true;
        const wall = parseSlotWallTime(day.date, t);
        if (wall) {
          if (slotAllowed(w.windows, wall)) all.push({ wall, watch: w });
        } else if (rawSample.length < 3) {
          rawSample.push(t);
        }
      }
    }
  }
  all.sort((a, b) => a.wall.key - b.wall.key);
  if (fetchErrors.length) {
    if (!dryRun) await saveLastTick(env, { result: "fetch_error", error: fetchErrors[0] });
    if (!all.length && fetchErrors.length === config.watches.length) {
      if (!dryRun) await alertOnce(env, "fetch_error", `Shore 조회에 계속 실패하고 있어요. ${fetchErrors[0].slice(0, 200)}`);
      return { status: "fetch_error", error: fetchErrors[0] };
    }
  }
  const matches = all;

  if (matches.length === 0) {
    if (rawSample.length) {
      await env.STATE.put("debug:lastRaw", JSON.stringify(rawSample).slice(0, 8000), { expirationTtl: 86400 });
    }
    const out = { status: "none", sawTimes };
    if (!dryRun) await saveLastTick(env, { result: "none" });
    return out;
  }
  if (dryRun) {
    return {
      status: "found",
      count: matches.length,
      slots: matches.slice(0, 40).map((m) => `${m.wall.label} (${svcName(m.watch.serviceId)})`),
    };
  }

  let lastErr = null;
  for (const target of matches.slice(0, 3)) {
    try {
      const res = await book(env, target.watch, target.wall);
      await env.STATE.put("booked", JSON.stringify({
        label: target.wall.label,
        service: svcName(target.watch.serviceId),
        datetime: target.wall.iso,
        response: res,
        at: new Date().toISOString(),
      }));
      config.enabled = false;
      await env.STATE.put("config", JSON.stringify(config));
      await saveLastTick(env, { result: "booked", slot: target.wall.label, service: svcName(target.watch.serviceId) });
      await notify(env, `예약이 잡혔어요. ${target.wall.label} ${svcName(target.watch.serviceId)}. 자동 예약은 꺼졌어요. Shore 확인 메일을 확인해 주세요.`);
      return { status: "booked", slot: target.wall.label, response: res };
    } catch (e) {
      lastErr = e;
      if (!e.slotTaken) break;
    }
  }
  await saveLastTick(env, { result: "book_error", error: lastErr.message });
  if (!lastErr.slotTaken) await alertOnce(env, "book_error", `예약 시도가 실패했어요. ${lastErr.message.slice(0, 200)}`);
  return {
    status: lastErr.slotTaken ? "slot_taken" : "book_error",
    error: lastErr.message,
  };
}

async function getConfig(env) {
  const c = await env.STATE.get("config", { type: "json" });
  if (c && c.watches) return normalizeConfig(c);
  if (c) return normalizeConfig(legacyToV2(c));
  const from = berlinParts(new Date());
  const to = berlinParts(new Date(Date.now() + 14 * 86400000));
  const d = (p) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return {
    enabled: false,
    dateFrom: d(from),
    dateTo: d(to),
    watches: [{
      serviceId: env.SERVICE_ID || SERVICES[0].id,
      resourceId: env.RESOURCE_ID || "",
      windows: { 1: ["16:00", "21:50"], 2: ["16:00", "21:50"], 3: ["16:00", "21:50"], 4: ["16:00", "21:50"], 5: ["16:00", "21:50"] },
    }],
  };
}

// Windows are stored as ["HH:MM", "HH:MM"], both ends inclusive. Older configs
// stored whole hours [minH, maxH) as numbers, converted here on read.
function normalizeConfig(c) {
  const watches = (c.watches || []).map((w) => {
    const windows = {};
    for (const [d, r] of Object.entries(w.windows || {})) {
      if (!Array.isArray(r)) continue;
      const legacy = typeof r[0] === "number" && typeof r[1] === "number";
      const a = toMin(r[0]);
      const z = legacy ? toMin(r[1]) - 10 : toMin(r[1]);
      if (Number.isFinite(a) && Number.isFinite(z)) windows[d] = [fmtMin(a), fmtMin(Math.max(a, z))];
    }
    return { ...w, windows };
  });
  return { ...c, watches };
}

function toMin(v) {
  if (typeof v === "number") return Math.round(v * 60);
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

const fmtMin = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;

function legacyToV2(c) {
  const windows = {};
  for (const d of c.dow || []) windows[d] = [c.minHour ?? 0, c.maxHour ?? 24];
  return {
    enabled: Boolean(c.enabled),
    dateFrom: c.dateFrom,
    dateTo: c.dateTo,
    watches: [{ serviceId: c.serviceId, resourceId: c.resourceId || "", windows }],
  };
}

function validateConfig(b) {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(b.dateFrom) || !dateRe.test(b.dateTo)) throw new Error("bad dates");
  if (b.dateFrom > b.dateTo) throw new Error("dateFrom > dateTo");
  if (!Array.isArray(b.watches) || b.watches.length < 1 || b.watches.length > 4) {
    throw new Error("watches: need 1-4");
  }
  const watches = b.watches.map((w, i) => {
    if (!SERVICES.some((s) => s.id === w.serviceId)) throw new Error(`watch ${i + 1}: unknown serviceId`);
    if (!RESOURCES.some((r) => r.id === (w.resourceId || ""))) throw new Error(`watch ${i + 1}: unknown resourceId`);
    const windows = {};
    for (const [d, r] of Object.entries(w.windows || {})) {
      const dd = Number(d);
      if (!(dd >= 1 && dd <= 7) || !Array.isArray(r)) continue;
      const a = toMin(r[0]), z = toMin(r[1]);
      if (!(a >= 0 && z <= 24 * 60 - 1 && a <= z)) throw new Error(`watch ${i + 1} ${dd}요일: bad time range`);
      windows[dd] = [fmtMin(a), fmtMin(z)];
    }
    if (!Object.keys(windows).length) throw new Error(`watch ${i + 1}: no days selected`);
    return { serviceId: w.serviceId, resourceId: w.resourceId || "", windows };
  });
  return { enabled: Boolean(b.enabled), dateFrom: b.dateFrom, dateTo: b.dateTo, watches };
}

async function fetchAvailability(env, watch, config) {
  const [fy, fm, fd] = config.dateFrom.split("-").map(Number);
  const [ty, tm, td] = config.dateTo.split("-").map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  const todayMs = Date.UTC(...ymd(berlinParts(new Date())));
  const startMs = Math.max(fromMs, todayMs);

  const days = [];
  for (let ms = startMs; ms <= toMs; ms += 5 * 86400000) {
    const chunkEnd = Math.min(ms + 4 * 86400000, toMs);
    const body = {
      merchant_id: env.MERCHANT_ID,
      timezone: env.MERCHANT_TZ,
      starts_at: `${dateStr(new Date(ms))} 00:00:00`,
      ends_at: `${dateStr(new Date(chunkEnd))} 23:59:59`,
      search_weeks_range: 0,
      required_capacity: "1",
      services_resources: [
        watch.resourceId
          ? { service_id: watch.serviceId, resource_id: watch.resourceId }
          : { service_id: watch.serviceId },
      ],
    };
    const res = await fetch(`${API_V2}/availability/calculate_slots`, {
      method: "POST",
      headers: SHORE_HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`availability ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    days.push(...(data.slots || []));
  }
  return days;
}

async function book(env, watch, wall) {
  const service = {
    requirements: [],
    uuid: watch.serviceId,
    employee_selected_by: watch.resourceId ? "not_defined" : "auto",
  };
  if (watch.resourceId) service.resource_uuid = watch.resourceId;

  const customer = {
    first_name: env.CUSTOMER_FIRST_NAME,
    last_name: env.CUSTOMER_LAST_NAME,
    email: env.CUSTOMER_EMAIL,
    mobile: env.CUSTOMER_MOBILE || undefined,
    locale: env.BOOKING_LOCALE || "en",
    opt_in: false,
  };
  if (env.CUSTOMER_GENDER) customer.gender = env.CUSTOMER_GENDER;

  const body = {
    appointment: {
      customer,
      customer_custom_attributes: [],
      datetime: wall.iso,
      file_upload: null,
      merchant_id: env.MERCHANT_ID,
      origin: env.BOOKING_ORIGIN || "https://connect.shore.com",
      reason_for_booking: null,
      reference_id: null,
      required_capacity: 1,
      services: [service],
      special_wishes: env.SPECIAL_WISHES || "",
    },
  };

  const res = await fetch(`${API_V3}/bookings`, {
    method: "POST",
    headers: SHORE_HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`bookings ${res.status}: ${text.slice(0, 400)}`);
    if (res.status === 409 || /taken|unavailable|slot/i.test(text)) err.slotTaken = true;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

// ---- slot parsing / filters ----

function parseSlotWallTime(dayDate, t) {
  const s = typeof t === "string" ? t : t && (t.date || t.time || t.starts_at);
  if (!s) return null;
  let y, mo, d, h, mi;
  let m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (m) {
    [, y, mo, d, h, mi] = m.map(Number);
  } else {
    m = String(s).match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    [y, mo, d] = dayDate.split("-").map(Number);
    [, h, mi] = m.map(Number);
  }
  return {
    y, mo, d, h, mi,
    iso: berlinToISO(y, mo, d, h, mi),
    key: Date.UTC(y, mo - 1, d, h, mi),
    label: `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}`,
  };
}

function slotAllowed(windows, wall) {
  const dow = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d)).getUTCDay() || 7;
  const w = windows[dow];
  if (!w) return false;
  const t = wall.h * 60 + wall.mi;
  return t >= toMin(w[0]) && t <= toMin(w[1]);
}

const svcName = (id) => (SERVICES.find((s) => s.id === id) || {}).name || id;

// ---- Berlin timezone helpers ----

const berlinFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});

function berlinParts(date) {
  const o = {};
  for (const p of berlinFmt.formatToParts(date)) {
    if (p.type !== "literal") o[p.type] = Number(p.value);
  }
  if (o.hour === 24) o.hour = 0;
  return o;
}

function berlinOffsetMs(utcMs) {
  const p = berlinParts(new Date(utcMs));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - utcMs;
}

function berlinToISO(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  return new Date(guess - berlinOffsetMs(guess)).toISOString();
}

const ymd = (p) => [p.year, p.month - 1, p.day];
const dateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const pad = (n) => String(n).padStart(2, "0");
const int = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const json = (o, status = 200) => Response.json(o, { status });

// ---- Telegram notifications ----

async function tg(env, method, body) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch {
    return null;
  }
}

async function notify(env, text) {
  if (!env.TELEGRAM_CHAT_ID) return false;
  const r = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true });
  return Boolean(r && r.ok);
}

// Errors repeat every poll, so alert at most once per kind per 6 hours.
async function alertOnce(env, kind, text) {
  const k = `alert:${kind}`;
  if (await env.STATE.get(k)) return;
  await env.STATE.put(k, "1", { expirationTtl: 6 * 3600 });
  await notify(env, text);
}

// ---- Reminders ----

async function runReminders(env) {
  if (!env.TELEGRAM_CHAT_ID) return;
  const b = berlinParts(new Date());
  const now = { dow: new Date(Date.UTC(b.year, b.month - 1, b.day)).getUTCDay() || 7, hour: b.hour, minute: b.minute };
  const date = `${b.year}-${pad(b.month)}-${pad(b.day)}`;
  for (const r of REMINDERS) {
    if (!inAnyWindow(r, now)) continue;
    const key = `rem:${r.id}:${date}`;
    const sent = (await env.STATE.get(key, { type: "json" })) || [];
    for (const slot of dueSlots(r, now, sent)) {
      // Mark first. A rare lost message is better than sending it twice.
      sent.push(slot.at);
      await env.STATE.put(key, JSON.stringify(sent), { expirationTtl: 172800 });
      await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: buildMessage(r) });
    }
  }

  const nowMin = now.hour * 60 + now.minute;
  if (inDeadlineWindow(nowMin)) {
    const key = `rem:deadlines:${date}`;
    const sent = (await env.STATE.get(key, { type: "json" })) || [];
    for (const d of dueDeadlines(date, nowMin, sent)) {
      sent.push(d.slot);
      await env.STATE.put(key, JSON.stringify(sent), { expirationTtl: 172800 });
      await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: d.text });
    }
  }
}

// ---- Telegram bot (two-way) ----

const HELP = `쓰는 방법이에요.
- 자연어로 보내면 설정을 바꿔요. 예: Mon-Thu from 15:00 iron perm, Friday from 1, next week
- status 또는 상태: 지금 설정 보기
- on / off: 자동 예약 켜기 / 끄기
- check: 지금 빈자리 확인
- reset: 예약 기록 지우기
설정을 바꾸기 전에는 항상 확인 버튼이 나와요.`;

const COMMANDS = {
  help: ["start", "help", "도움말", "?"],
  status: ["status", "상태"],
  on: ["on", "켜", "켜줘", "시작"],
  off: ["off", "꺼", "꺼줘", "중지"],
  check: ["check", "빈자리", "확인"],
  reset: ["reset", "리셋"],
};

async function handleTelegram(request, env, ctx) {
  if (request.method !== "POST") return new Response("ok");
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json();
  // Answer Telegram right away. The AI call can take a few seconds.
  ctx.waitUntil(processUpdate(env, update).catch((e) => notify(env, `처리 중 오류가 났어요. ${String(e.message).slice(0, 200)}`)));
  return new Response("ok");
}

async function processUpdate(env, u) {
  const owner = String(env.TELEGRAM_CHAT_ID);
  if (u.callback_query) {
    const cq = u.callback_query;
    if (String(cq.from && cq.from.id) !== owner || String(cq.message && cq.message.chat.id) !== owner) return;
    return handleCallback(env, cq);
  }
  const m = u.message;
  if (!m || !m.text) return;
  if (String(m.chat && m.chat.id) !== owner || String(m.from && m.from.id) !== owner) return;
  return handleText(env, m.text.trim());
}

const reply = (env, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true, ...extra });

async function handleText(env, text) {
  const key = text.toLowerCase().replace(/^\//, "").replace(/@\w+$/, "").trim();
  const cmd = Object.keys(COMMANDS).find((c) => COMMANDS[c].includes(key));
  if (cmd === "help") return reply(env, HELP);
  if (cmd === "status") return reply(env, await statusText(env));
  if (cmd === "on") return reply(env, await setEnabled(env, true));
  if (cmd === "off") return reply(env, await setEnabled(env, false));
  if (cmd === "check") return reply(env, await checkText(env));
  if (cmd === "reset") {
    return reply(env, "예약 기록을 지울까요? 기록이 없어지면 자동 예약이 켜져 있을 때 다시 예약을 잡아요.", {
      reply_markup: { inline_keyboard: [[{ text: "지우기", callback_data: "rs:y" }, { text: "취소", callback_data: "rs:n" }]] },
    });
  }
  return handleNL(env, text);
}

async function statusText(env) {
  const [config, booked] = await Promise.all([getConfig(env), env.STATE.get("booked", { type: "json" })]);
  const state = booked ? `예약 기록이 있어서 봇이 멈춰 있어요 (${booked.label})` : config.enabled ? "자동 예약 켜짐, 약 20초마다 조회 중" : "자동 예약 꺼짐, 조회 안 함";
  return `${state}\n${describeConfig(config, SERVICES, RESOURCES)}`;
}

async function setEnabled(env, enabled) {
  const [cfg, booked] = await Promise.all([getConfig(env), env.STATE.get("booked", { type: "json" })]);
  if (cfg.enabled === enabled) return `이미 ${enabled ? "켜져" : "꺼져"} 있어요.`;
  cfg.enabled = enabled;
  await env.STATE.put("config", JSON.stringify(cfg));
  if (!enabled) return "자동 예약을 껐어요. 지금은 빈자리를 조회하지 않아요.";
  return booked ? "자동 예약을 켰어요. 다만 예약 기록이 남아 있어서 봇은 멈춰 있어요. reset으로 지우면 다시 찾아요." : "자동 예약을 켰어요.";
}

async function checkText(env) {
  const r = await tick(env, { dryRun: true });
  if (r.status === "found") return `조건에 맞는 빈자리가 ${r.count}개 있어요. 자동 예약이 켜져 있으면 곧 잡혀요.\n${r.slots.slice(0, 8).join("\n")}`;
  if (r.status === "none") return "조건에 맞는 빈자리는 지금 없어요.";
  if (r.status === "already_booked") return "예약 기록이 있어서 조회하지 않았어요.";
  return `조회 결과 ${r.status}${r.error ? `, ${String(r.error).slice(0, 150)}` : ""}`;
}

async function takeNlQuota(env) {
  const k = `nlq:${new Date().toISOString().slice(0, 10)}`;
  const n = Number(await env.STATE.get(k)) || 0;
  if (n >= NL_DAILY_CAP) return false;
  await env.STATE.put(k, String(n + 1), { expirationTtl: 172800 });
  return true;
}

async function nlParse(env, text, model) {
  const b = berlinParts(new Date());
  const today = { y: b.year, m: b.month, d: b.day };
  const out = await env.AI.run(model || env.NL_MODEL || NL_MODEL, {
    messages: buildMessages(text, { today }),
    max_tokens: 500,
    temperature: 0,
  });
  const intent = extractIntent(out);
  if (!intent) return { intent: null, raw: JSON.stringify(out).slice(0, 400) };
  if (intent.intent !== "set_watch") return { intent };
  const current = await getConfig(env);
  const r = resolveSetWatch(intent, { today, services: SERVICES, resources: RESOURCES, current });
  return { intent, ...r };
}

async function handleNL(env, text) {
  if (!env.AI) return reply(env, "AI 설정이 없어요. status, on, off, check 같은 명령은 쓸 수 있어요.");
  if (!(await takeNlQuota(env))) return reply(env, "오늘 해석 횟수를 다 썼어요. status, on, off, check는 계속 쓸 수 있어요.");
  const r = await nlParse(env, text);
  const i = r.intent && r.intent.intent;
  if (i === "enable") return reply(env, await setEnabled(env, true));
  if (i === "disable") return reply(env, await setEnabled(env, false));
  if (i === "status") return reply(env, await statusText(env));
  if (i === "check") return reply(env, await checkText(env));
  if (i !== "set_watch") return reply(env, `잘 이해하지 못했어요. 예: Mon-Thu from 15:00 iron perm, Friday from 1, next week\n\n${HELP}`);
  if (r.ask) return reply(env, r.ask);
  const cfg = validateConfig(r.config);
  const id = crypto.randomUUID().slice(0, 8);
  await env.STATE.put(`pending:${id}`, JSON.stringify(cfg), { expirationTtl: 600 });
  return reply(env, `이렇게 이해했어요.\n${r.summary}\n\n적용하면 자동 예약이 켜져요.`, {
    reply_markup: { inline_keyboard: [[{ text: "적용", callback_data: `ok:${id}` }, { text: "취소", callback_data: `no:${id}` }]] },
  });
}

async function handleCallback(env, cq) {
  const [kind, arg] = String(cq.data || "").split(":");
  const chat_id = cq.message.chat.id, message_id = cq.message.message_id;
  const edit = (text) => tg(env, "editMessageText", { chat_id, message_id, text });
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });

  if (kind === "no") {
    await env.STATE.delete(`pending:${arg}`);
    return edit("취소했어요.");
  }
  if (kind === "rs") {
    if (arg !== "y") return edit("취소했어요.");
    await Promise.all([env.STATE.delete("booked"), env.STATE.delete("pendingConfirm"), env.STATE.delete("confirmed")]);
    return edit("예약 기록을 지웠어요.");
  }
  if (kind === "ok") {
    const raw = await env.STATE.get(`pending:${arg}`, { type: "json" });
    if (!raw) return edit("시간이 지나 만료됐어요. 다시 보내 주세요.");
    const cfg = validateConfig(raw);
    await env.STATE.put("config", JSON.stringify(cfg));
    await env.STATE.delete(`pending:${arg}`);
    const booked = await env.STATE.get("booked", { type: "json" });
    const found = booked ? "예약 기록이 남아 있어서 봇은 멈춰 있어요. reset으로 지우면 다시 찾아요." : await checkText(env);
    return edit(`적용했어요. 자동 예약이 켜졌어요.\n${describeConfig(cfg, SERVICES, RESOURCES)}\n\n${found}`);
  }
}

async function saveLastTick(env, obj) {
  const significant = obj.result !== "none" && obj.result !== "disabled" && obj.result !== "already_booked";
  if (!significant) {
    if (obj.result !== "none") return;
    const prev = await env.STATE.get("lastTick", { type: "json" });
    if (prev && Date.now() - new Date(prev.at).getTime() < 600000) return;
  }
  await env.STATE.put("lastTick", JSON.stringify({ ...obj, at: new Date().toISOString() }));
}

// ---- settings page ----

function settingsPage(env) {
  const serviceOpts = SERVICES.map(
    (s) => `<option value="${s.id}">${esc(s.name)} (${s.dur}min)</option>`,
  ).join("");
  const resourceOpts = RESOURCES.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  const key = env.ADMIN_KEY ? `?key=${encodeURIComponent(env.ADMIN_KEY)}` : "";
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>shore-sniper · le vivant</title>
<style>
:root{--accent:#fd3356;--bg:#f2f3f7;--ink:#1c1e26;--mut:#6f7482;--line:#e1e4ec}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;margin:0;background:var(--bg);color:var(--ink)}
.wrap{max-width:820px;margin:0 auto;padding:20px 16px 64px}
header{display:flex;align-items:center;gap:14px;padding:18px 4px 24px}
.dot{width:14px;height:14px;border-radius:50%;background:#bbb;flex:none;transition:background .3s}
.dot.on{background:var(--accent);box-shadow:0 0 0 5px #fd335522;animation:pulse 2s infinite}
@keyframes pulse{50%{box-shadow:0 0 0 10px #fd335500}}
h1{font-size:24px;margin:0;font-weight:700}
.sub{font-size:14px;color:var(--mut);margin-top:3px}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:22px;margin-bottom:18px;box-shadow:0 1px 3px #00000008}
.card h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:0 0 16px}
.stateRow{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.badge{font-size:17px;font-weight:700;padding:8px 16px;border-radius:999px;white-space:nowrap}
.b-gray{background:#eef0f4;color:#5a5f6d}.b-green{background:#dcf7e8;color:#0d7a3f}
.b-pink{background:#ffe1e8;color:var(--accent)}.b-amber{background:#fff3d6;color:#9a6a00}.b-red{background:#ffe0e0;color:#c22}
.tickTime{font-size:14px;color:var(--mut)}
.warn{margin-top:14px;border-radius:12px;padding:14px 16px;font-size:15px;line-height:1.6;background:#fff3d6;color:#7a5500}
.sect{margin-top:18px;font-size:13px;letter-spacing:.06em;color:var(--mut);font-weight:700}
.cond{margin-top:8px}
.wsum{padding:14px 16px;margin-top:10px;border:1px solid var(--line);border-radius:14px;background:#fbfbfd}
.wsum.off{opacity:.55}
.ws-t{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;font-size:17px}
.ws-t>span{color:var(--mut);font-size:14px}
.ws-d{margin-top:6px;font-size:16px;color:#2c2f38}
.ws-d b{display:inline-block;min-width:66px}
.ws-r{margin-top:8px;font-size:14px;color:var(--mut)}
.eventBox{margin-top:14px;border-radius:12px;padding:14px 16px;font-size:15.5px;line-height:1.6}
.ev-ok{background:#dcf7e8;color:#0d7a3f}.ev-info{background:#eef0f4;color:#3a3d47}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
label{display:block;font-size:14px;color:var(--mut);margin:14px 0 6px}
select,input[type=date]{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:12px;font-size:16px;background:#fff;outline:none;transition:border-color .15s;color:var(--ink)}
select:focus,input:focus{border-color:var(--accent)}
select:disabled{opacity:.35}
.switch{display:flex;align-items:center;gap:12px;font-size:17px;font-weight:600;color:var(--ink);cursor:pointer;margin:0 0 4px}
.switch input{width:22px;height:22px;accent-color:var(--accent)}
.row{display:flex;gap:12px}.row>div{flex:1}
.btns{display:flex;gap:10px;margin-top:22px;flex-wrap:wrap}
button{border:0;border-radius:12px;padding:14px 22px;font-size:16px;font-weight:600;cursor:pointer;transition:filter .15s}
button:hover{filter:brightness(.93)}
.primary{background:var(--accent);color:#fff}
.ghost{background:#eef0f4;color:#3a3d47}
.danger{background:transparent;color:#c22;border:1px solid #f3caca}
.big{padding:16px 28px;font-size:18px}
#checkResult{margin-top:16px;display:none}
.slots{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.slots span{font-size:14px;font-family:ui-monospace,monospace;background:#eef0f4;border-radius:9px;padding:6px 11px}
.slots span:first-child{background:#ffe1e8;color:var(--accent);font-weight:700}
#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(90px);background:#1c1e26;color:#fff;font-size:15px;padding:12px 22px;border-radius:999px;opacity:0;transition:all .3s;pointer-events:none;max-width:90vw}
#toast.show{transform:translateX(-50%) translateY(0);opacity:1}
.watch{border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-top:16px;background:#fbfbfd}
.whead{display:flex;justify-content:space-between;align-items:center}
.wt{font-size:13px;font-weight:700;color:var(--mut);letter-spacing:.06em}
.wrm{background:none;border:0;color:#c22;font-size:14px;cursor:pointer;padding:4px 6px}
.hint{font-size:13px;color:var(--mut);margin:0 0 4px}
.days{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.dayrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dayrow label{margin:0}
.dayrow input[type=checkbox]{display:none}
.dchip{display:inline-block;width:52px;text-align:center;padding:10px 0;border:1px solid var(--line);border-radius:10px;font-size:15px;color:var(--mut);cursor:pointer;background:#fff}
.dayrow input[type=checkbox]:checked+.dchip{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}
.dayrow select{width:68px;padding:10px 8px;font-size:16px}
.sep{color:var(--mut);font-size:15px}
.wsame{margin-top:12px;padding:10px 16px;font-size:14px}
#addWatch{margin-top:16px;width:100%}
</style></head><body>
<div class="wrap">
<header>
<div class="dot" id="liveDot"></div>
<div><h1>shore-sniper</h1><div class="sub">le vivant · Kurfüstenstrasse 30, Düsseldorf</div></div>
</header>

<div class="card">
<h2>Status</h2>
<div class="stateRow"><span class="badge b-gray" id="stateBadge">…</span><button type="button" class="primary big" id="toggleBtn">…</button></div>
<div class="tickTime" id="tickTime" style="margin-top:10px"></div>
<p class="hint" style="margin-top:8px">켜면 약 20초마다 빈자리를 찾고, 조건에 맞는 슬롯이 나오면 바로 예약해요. 1건 잡으면 자동으로 꺼져요.</p>
<div class="warn" id="warn" hidden></div>
<div class="sect">자동 예약 대상</div>
<div class="cond" id="cond"></div>
<div id="events"></div>
<div class="btns"><button type="button" class="ghost" id="checkBtn">지금 빈자리 확인</button></div>
<div id="checkResult"></div>
</div>

<div class="card">
<h2>대상 설정</h2>
<form id="f">
<div class="row">
<div><label>시작일</label><input type="date" id="dateFrom"></div>
<div><label>종료일</label><input type="date" id="dateTo"></div>
</div>
<div id="watches"></div>
<button type="button" class="ghost" id="addWatch">+ 대상 추가</button>
<div class="btns">
<button type="submit" class="primary big">저장</button>
<button type="button" class="danger" id="resetBtn">예약 기록 리셋</button>
</div>
</form>
</div>
</div>
<div id="toast"></div>
<script>
const KEY=${JSON.stringify(key)};
const SVC=${JSON.stringify(SERVICES.map(s=>({id:s.id,name:s.name,dur:s.dur})))};
const RES=${JSON.stringify(RESOURCES)};
const SVC_OPTS=${JSON.stringify(serviceOpts)};
const RES_OPTS=${JSON.stringify(resourceOpts)};
const $=id=>document.getElementById(id);
const p2=n=>String(n).padStart(2,"0");
const MINS=[0,10,20,30,40,50];
const ERR={
slot_taken:{t:"슬롯 선점 실패 · 계속 조회",c:"b-amber"},
book_error:{t:"예약 실패",c:"b-red"},
fetch_error:{t:"조회 에러",c:"b-red"}};
const DOW=["","월","화","수","목","금","토","일"];
let CUR=null,dirty=false;
function ago(iso){
  const s=(Date.now()-new Date(iso))/1000;
  if(s<60)return"방금";if(s<3600)return Math.floor(s/60)+"분 전";
  if(s<86400)return Math.floor(s/3600)+"시간 전";return Math.floor(s/86400)+"일 전";
}
function toast(m){const t=$("toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2400)}
function korDate(s){const a=s.split("-");return Number(a[1])+"월 "+Number(a[2])+"일"}
function dayLabel(ds){
  ds=ds.slice().sort((a,b)=>a-b);
  if(ds.length===1)return DOW[ds[0]]+"요일";
  if(ds.every((d,i)=>i===0||d===ds[i-1]+1))return DOW[ds[0]]+"–"+DOW[ds[ds.length-1]];
  return ds.map(d=>DOW[d]).join("·");
}
function watchLines(w){
  const g={};
  for(const[d,r]of Object.entries(w.windows||{})){(g[r.join("-")] ||= []).push(Number(d))}
  return Object.entries(g).sort((a,b)=>Math.min(...a[1])-Math.min(...b[1])).map(([k,ds])=>
    '<div class="ws-d"><b>'+dayLabel(ds)+'</b> <span class="mono">'+k.split("-").join(" ~ ")+'</span></div>').join("");
}
function tsel(c,v){
  const hm=(v||"10:00").split(":"),h=Number(hm[0]),m=Number(hm[1]);
  let o='<select class="'+c+'h">';
  for(let i=0;i<24;i++)o+='<option value="'+i+'"'+(i===h?" selected":"")+'>'+p2(i)+'</option>';
  o+='</select><span class="sep">:</span><select class="'+c+'m">';
  const ms=MINS.indexOf(m)<0?MINS.concat([m]).sort((a,b)=>a-b):MINS;
  ms.forEach(x=>{o+='<option value="'+x+'"'+(x===m?" selected":"")+'>'+p2(x)+'</option>'});
  return o+"</select>";
}
function watchEl(w,i){
  const div=document.createElement("div");div.className="watch";
  div.innerHTML='<div class="whead"><span class="wt">대상 '+(i+1)+'</span><button type="button" class="wrm">삭제</button></div>'+
    '<label>서비스</label><select class="ws">'+SVC_OPTS+'</select>'+
    '<label>직원</label><select class="wr">'+RES_OPTS+'</select>'+
    '<label>요일 · 시간 (베를린, 10분 단위)</label>'+
    '<p class="hint">시작 시각과 끝 시각 모두 포함돼요. 예: 15:10 ~ 15:10 은 15:10 슬롯 하나만 노려요.</p>'+
    '<div class="days">'+
    [1,2,3,4,5,6].map(d=>{
      const r=(w&&w.windows&&w.windows[d]);
      return '<div class="dayrow"><label><input type="checkbox" class="don" data-d="'+d+'"'+(r?" checked":"")+
        '><span class="dchip">'+DOW[d]+'</span></label>'+
        tsel("f",r?r[0]:"10:00")+'<span class="sep">~</span>'+tsel("t",r?r[1]:"19:00")+'</div>';
    }).join("")+'</div>'+
    '<button type="button" class="ghost wsame">첫 선택 요일 시간을 나머지 선택 요일에 적용</button>';
  div.querySelectorAll(".dayrow").forEach(row=>{
    const on=row.querySelector(".don").checked;
    row.querySelectorAll("select").forEach(s=>s.disabled=!on);
  });
  div.querySelector(".ws").value=w?w.serviceId:SVC[0].id;
  div.querySelector(".wr").value=w?(w.resourceId||""):"";
  div.querySelector(".wrm").onclick=()=>{if(document.querySelectorAll(".watch").length>1){div.remove();dirty=true}};
  div.querySelectorAll(".don").forEach(cb=>cb.onchange=()=>{
    cb.closest(".dayrow").querySelectorAll("select").forEach(s=>s.disabled=!cb.checked);
  });
  div.querySelector(".wsame").onclick=()=>{
    const rows=[...div.querySelectorAll(".dayrow")].filter(r=>r.querySelector(".don").checked);
    if(rows.length<2)return;
    rows.slice(1).forEach(r=>["fh","fm","th","tm"].forEach(c=>{r.querySelector("."+c).value=rows[0].querySelector("."+c).value}));
    dirty=true;toast("시간을 적용했어요");
  };
  return div;
}
function renderWatches(watches){
  const box=$("watches");box.innerHTML="";
  (watches.length?watches:[null]).forEach((w,i)=>box.appendChild(watchEl(w,i)));
}
function readWatches(){
  const out=[];
  document.querySelectorAll(".watch").forEach(el=>{
    const windows={};
    el.querySelectorAll(".don:checked").forEach(cb=>{
      const row=cb.closest(".dayrow");
      const g=c=>p2(row.querySelector("."+c+"h").value)+":"+p2(row.querySelector("."+c+"m").value);
      windows[cb.dataset.d]=[g("f"),g("t")];
    });
    if(Object.keys(windows).length){
      out.push({serviceId:el.querySelector(".ws").value,resourceId:el.querySelector(".wr").value,windows});
    }
  });
  return out;
}
function render(s){
  const c=s.config,lt=s.lastTick||{};CUR=c;
  const live=c.enabled&&!s.booked;
  $("liveDot").className="dot"+(live?" on":"");
  let st;
  if(s.booked)st={t:"예약 완료 · 자동 예약 멈춤",c:"b-green"};
  else if(!c.enabled)st={t:"자동 예약 꺼짐 · 조회 안 함",c:"b-gray"};
  else if(ERR[lt.result])st=ERR[lt.result];
  else st={t:"자동 예약 켜짐 · 조회 중",c:"b-pink"};
  $("stateBadge").className="badge "+st.c;$("stateBadge").textContent=st.t;
  const tb=$("toggleBtn");
  tb.hidden=Boolean(s.booked);
  tb.textContent=c.enabled?"자동 예약 끄기":"자동 예약 켜기";
  tb.className=(c.enabled?"ghost":"primary")+" big";
  $("tickTime").textContent=(lt.at?"마지막 기록 "+ago(lt.at):"")+(live?" · 약 20초 간격으로 조회 중":"");
  const w=$("warn");
  if(s.booked){w.hidden=false;w.textContent="예약 기록이 남아 있어서 봇이 멈춰 있어요. 다시 돌리려면 아래 '예약 기록 리셋'을 누른 뒤 자동 예약을 켜세요."}
  else if(!c.enabled){w.hidden=false;w.textContent="지금은 빈자리를 조회하지 않아요. 아래 대상은 '자동 예약 켜기'를 눌러야 찾기 시작해요."}
  else w.hidden=true;
  $("cond").innerHTML=(c.watches||[]).map(x=>{
    const svc=SVC.find(y=>y.id===x.serviceId)||{name:x.serviceId,dur:0};
    const res=(RES.find(y=>y.id===(x.resourceId||""))||{}).name||x.resourceId;
    return '<div class="wsum'+(live?"":" off")+'"><div class="ws-t"><b>'+svc.name+(svc.dur?" ("+svc.dur+"분)":"")+'</b><span>'+res+'</span></div>'+
      watchLines(x)+
      '<div class="ws-r">'+korDate(c.dateFrom)+" ~ "+korDate(c.dateTo)+(live?"":" · 꺼짐")+'</div></div>';
  }).join("");
  let ev="";
  if(s.booked)ev='<div class="eventBox ev-ok">예약 접수됨 — <b class="mono">'+(s.booked.label||"")+'</b>'+(s.booked.service?" ("+s.booked.service+")":"")+" · "+ago(s.booked.at)+'에 잡힘</div>';
  else if(lt.result==="booked"&&lt.slot)ev='<div class="eventBox ev-info">최근 예약 접수 — <b class="mono">'+lt.slot+'</b>'+(lt.service?" ("+lt.service+")":"")+" · "+ago(lt.at)+'</div>';
  $("events").innerHTML=ev;
}
async function save(body){
  const res=await fetch("/config"+KEY,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  return res.json();
}
async function load(){
  const s=await (await fetch("/status"+KEY)).json();
  if(!dirty){
    const c=s.config;
    $("dateFrom").value=c.dateFrom;$("dateTo").value=c.dateTo;
    renderWatches(c.watches||[]);
  }
  render(s);
}
async function runCheck(){
  const box=$("checkResult");box.style.display="block";box.innerHTML='<div class="eventBox ev-info">조회 중…</div>';
  const r=await (await fetch("/check"+KEY)).json();
  if(r.status==="found"){
    box.innerHTML='<div class="eventBox ev-info"><b>'+r.count+'개 빈자리</b> (조건에 맞음 · 확인만 하고 예약은 안 해요)<div class="slots">'+r.slots.map(x=>"<span>"+x+"</span>").join("")+"</div></div>";
  }else if(r.status==="none"){
    box.innerHTML='<div class="eventBox ev-info">설정한 날짜·요일·시간에 맞는 빈자리가 지금은 없어요.</div>';
  }else{
    box.innerHTML='<div class="eventBox ev-info">'+r.status+(r.error?" — "+r.error:"")+"</div>";
  }
}
$("f").addEventListener("input",()=>{dirty=true});
$("addWatch").onclick=()=>{$("watches").appendChild(watchEl(null,document.querySelectorAll(".watch").length));dirty=true};
$("f").onsubmit=async e=>{
  e.preventDefault();
  const body={enabled:CUR?CUR.enabled:false,dateFrom:$("dateFrom").value,dateTo:$("dateTo").value,watches:readWatches()};
  const r=await save(body);
  toast(r.ok?(body.enabled?"저장됨 · 자동 예약 켜짐":"저장됨 · 자동 예약은 꺼져 있어요"):("오류: "+(r.error||"")));
  if(r.ok)dirty=false;
  load();
};
$("toggleBtn").onclick=async()=>{
  if(!CUR)return;
  const r=await save(Object.assign({},CUR,{enabled:!CUR.enabled}));
  toast(r.ok?(r.config.enabled?"자동 예약 켜짐":"자동 예약 꺼짐"):("오류: "+(r.error||"")));
  load();
};
$("checkBtn").onclick=runCheck;
$("resetBtn").onclick=async()=>{
  if($("resetBtn").dataset.arm!=="1"){
    $("resetBtn").dataset.arm="1";$("resetBtn").textContent="한 번 더 누르면 예약 기록을 지워요";
    setTimeout(()=>{$("resetBtn").dataset.arm="";$("resetBtn").textContent="예약 기록 리셋"},4000);return;
  }
  $("resetBtn").dataset.arm="";$("resetBtn").textContent="예약 기록 리셋";
  await fetch("/reset"+KEY);toast("리셋됨");load();
};
load().then(runCheck);setInterval(load,15000);
</script></body></html>`;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
