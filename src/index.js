import SERVICES from "./services.js";

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

  async fetch(request, env) {
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
          await env.STATE.put("config", JSON.stringify(cfg));
          return json({ ok: true, config: cfg });
        }
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
    await saveLastTick(env, { result: "fetch_error", error: fetchErrors[0] });
    if (!all.length && fetchErrors.length === config.watches.length) {
      return { status: "fetch_error", error: fetchErrors[0] };
    }
  }
  const matches = all;

  if (matches.length === 0) {
    if (rawSample.length) {
      await env.STATE.put("debug:lastRaw", JSON.stringify(rawSample).slice(0, 8000), { expirationTtl: 86400 });
    }
    const out = { status: "none", sawTimes };
    await saveLastTick(env, { result: "none" });
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
      await saveLastTick(env, { result: "booked", slot: target.wall.label });
      return { status: "booked", slot: target.wall.label, response: res };
    } catch (e) {
      lastErr = e;
      if (!e.slotTaken) break;
    }
  }
  await saveLastTick(env, { result: "book_error", error: lastErr.message });
  return {
    status: lastErr.slotTaken ? "slot_taken" : "book_error",
    error: lastErr.message,
  };
}

async function getConfig(env) {
  const c = await env.STATE.get("config", { type: "json" });
  if (c && c.watches) return c;
  if (c) return legacyToV2(c);
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
      windows: { 1: [16, 22], 2: [16, 22], 3: [16, 22], 4: [16, 22], 5: [16, 22] },
    }],
  };
}

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
      const a = int(r[0], -1), z = int(r[1], -1);
      if (a < 0 || a > 23 || z < 1 || z > 24 || a >= z) throw new Error(`watch ${i + 1} ${dd}요일: bad hours`);
      windows[dd] = [a, z];
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
  return wall.h >= w[0] && wall.h < w[1];
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

async function saveLastTick(env, obj) {
  const significant = obj.result !== "none" && obj.result !== "disabled" && obj.result !== "already_booked";
  if (!significant) {
    const prev = await env.STATE.get("lastTick", { type: "json" });
    if (prev && Date.now() - new Date(prev.at).getTime() < 120000) return;
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
:root{--accent:#fd3356;--bg:#f2f3f7;--ink:#1c1e26;--mut:#7a7f8c;--line:#e6e8ef}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:var(--bg);color:var(--ink)}
.wrap{max-width:560px;margin:0 auto;padding:20px 16px 48px}
header{display:flex;align-items:center;gap:12px;padding:18px 4px 22px}
.dot{width:11px;height:11px;border-radius:50%;background:#bbb;flex:none;transition:background .3s}
.dot.on{background:var(--accent);box-shadow:0 0 0 4px #fd335522;animation:pulse 2s infinite}
@keyframes pulse{50%{box-shadow:0 0 0 8px #fd335500}}
h1{font-size:19px;margin:0;font-weight:700}
.sub{font-size:12.5px;color:var(--mut);margin-top:2px}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:16px;box-shadow:0 1px 3px #00000008}
.card h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:0 0 14px}
.stateRow{display:flex;align-items:center;justify-content:space-between;gap:10px}
.badge{font-size:13px;font-weight:700;padding:5px 12px;border-radius:999px;white-space:nowrap}
.b-gray{background:#eef0f4;color:#5a5f6d}.b-green{background:#dcf7e8;color:#0d7a3f}
.b-pink{background:#ffe1e8;color:var(--accent)}.b-amber{background:#fff3d6;color:#9a6a00}.b-red{background:#ffe0e0;color:#c22}
.tickTime{font-size:12.5px;color:var(--mut);text-align:right}
.cond{margin-top:12px;font-size:13.5px;color:#3a3d47;background:var(--bg);border-radius:10px;padding:10px 12px;line-height:1.6}
.cond b{color:var(--ink)}
.wsum{padding:10px 0;border-bottom:1px dashed var(--line)}
.wsum:first-child{padding-top:0}
.wsum:last-child{border-bottom:0;padding-bottom:2px}
.ws-t{display:flex;justify-content:space-between;align-items:baseline;font-size:13.5px}
.ws-t>span{color:var(--mut);font-size:12.5px}
.ws-d{margin-top:3px;font-size:13px;color:#3a3d47}
.ws-r{margin-top:2px;font-size:12px;color:var(--mut)}
.eventBox{margin-top:12px;border-radius:10px;padding:11px 12px;font-size:13.5px;line-height:1.6}
.ev-ok{background:#dcf7e8;color:#0d7a3f}.ev-wait{background:#fff3d6;color:#8a6200}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
label{display:block;font-size:12.5px;color:var(--mut);margin:12px 0 5px}
select,input[type=date],input[type=number]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font-size:14px;background:#fff;outline:none;transition:border-color .15s}
select:focus,input:focus{border-color:var(--accent)}
.switch{display:flex;align-items:center;gap:10px;font-size:14.5px;font-weight:600;color:var(--ink);cursor:pointer;margin:0 0 4px}
.switch input{width:18px;height:18px;accent-color:var(--accent)}
.dow{display:flex;gap:6px;flex-wrap:wrap}
.dow label{margin:0}
.dow input{display:none}
.dow span{display:inline-block;padding:8px 0;width:44px;text-align:center;border:1px solid var(--line);border-radius:10px;font-size:13.5px;color:var(--mut);cursor:pointer;transition:all .15s}
.dow input:checked+span{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}
.row{display:flex;gap:10px}.row>div{flex:1}
.btns{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}
button{border:0;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:600;cursor:pointer;transition:filter .15s}
button:hover{filter:brightness(.93)}
.primary{background:var(--accent);color:#fff}
.ghost{background:#eef0f4;color:#3a3d47}
.danger{background:transparent;color:#c22;border:1px solid #f3caca}
#checkResult{margin-top:14px;display:none}
.slots{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.slots span{font-size:12px;font-family:ui-monospace,monospace;background:#eef0f4;border-radius:8px;padding:4px 9px}
.slots span:first-child{background:#ffe1e8;color:var(--accent);font-weight:700}
#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(80px);background:#1c1e26;color:#fff;font-size:13.5px;padding:10px 18px;border-radius:999px;opacity:0;transition:all .3s;pointer-events:none}
#toast.show{transform:translateX(-50%) translateY(0);opacity:1}
.watch{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-top:14px;background:#fbfbfd}
.whead{display:flex;justify-content:space-between;align-items:center}
.wt{font-size:11.5px;font-weight:700;color:var(--mut);letter-spacing:.06em}
.wrm{background:none;border:0;color:#c22;font-size:12.5px;cursor:pointer;padding:2px 4px}
.days{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.dayrow{display:flex;align-items:center;gap:8px}
.dayrow label{margin:0}
.dayrow input[type=checkbox]{display:none}
.dchip{display:inline-block;width:40px;text-align:center;padding:6px 0;border:1px solid var(--line);border-radius:8px;font-size:12.5px;color:var(--mut);cursor:pointer;background:#fff}
.dayrow input[type=checkbox]:checked+.dchip{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}
.dayrow input[type=number]{width:54px;padding:6px 8px;font-size:13px}
.dayrow input[type=number]:disabled{opacity:.35}
.sep{color:var(--mut);font-size:13px}
#addWatch{margin-top:14px;width:100%}
</style></head><body>
<div class="wrap">
<header>
<div class="dot" id="liveDot"></div>
<div><h1>shore-sniper</h1><div class="sub">le vivant · Kurfüstenstrasse 30, Düsseldorf</div></div>
</header>

<div class="card">
<h2>Status</h2>
<div class="stateRow"><span class="badge b-gray" id="stateBadge">…</span><span class="tickTime" id="tickTime"></span></div>
<div class="cond" id="cond"></div>
<div id="events"></div>
</div>

<div class="card">
<h2>Watch settings</h2>
<form id="f">
<label class="switch"><input type="checkbox" id="enabled"> 감시 활성화</label>
<div class="row">
<div><label>시작일</label><input type="date" id="dateFrom"></div>
<div><label>종료일</label><input type="date" id="dateTo"></div>
</div>
<div id="watches"></div>
<button type="button" class="ghost" id="addWatch">+ 감시 추가</button>
<div class="btns">
<button type="submit" class="primary">저장</button>
<button type="button" class="ghost" id="checkBtn">지금 빈자리 확인</button>
<button type="button" class="danger" id="resetBtn">상태 리셋</button>
</div>
<div id="checkResult"></div>
</form>
</div>
</div>
<div id="toast"></div>
<script>
const KEY=${JSON.stringify(key)};
const SVC=${JSON.stringify(SERVICES.map(s=>({id:s.id,name:s.name})))};
const RES=${JSON.stringify(RESOURCES)};
const SVC_OPTS=${JSON.stringify(serviceOpts)};
const RES_OPTS=${JSON.stringify(resourceOpts)};
const $=id=>document.getElementById(id);
const RESULT={
none:{t:"감시 중 — 빈자리 없음",c:"b-gray"},
disabled:{t:"감시 꺼짐",c:"b-gray"},
already_booked:{t:"예약 완료 (감시 종료)",c:"b-green"},
booked:{t:"예약 접수됨!",c:"b-pink"},
slot_taken:{t:"슬롯 선점 실패 — 계속 감시",c:"b-amber"},
book_error:{t:"예약 실패",c:"b-red"},
fetch_error:{t:"조회 에러",c:"b-red"},
found:{t:"빈자리 발견",c:"b-pink"}};
const DOW=["","월","화","수","목","금","토","일"];
function ago(iso){
  const s=(Date.now()-new Date(iso))/1000;
  if(s<60)return"방금";if(s<3600)return Math.floor(s/60)+"분 전";
  if(s<86400)return Math.floor(s/3600)+"시간 전";return Math.floor(s/86400)+"일 전";
}
function toast(m){const t=$("toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),1800)}
function korDate(s){const[y,m,d]=s.split("-");return Number(m)+"월 "+Number(d)+"일"}
function dayLabel(ds){
  ds=ds.slice().sort((a,b)=>a-b);
  if(ds.length===1)return DOW[ds[0]]+"요일";
  if(ds.every((d,i)=>i===0||d===ds[i-1]+1))return DOW[ds[0]]+"–"+DOW[ds[ds.length-1]];
  return ds.map(d=>DOW[d]).join("·");
}
function rangeLabel(r){
  const[a,z]=r;
  if(a<=0&&z>=21)return"하루종일";
  if(z>=21)return a+"시 이후";
  return a+"–"+z+"시";
}
function watchDesc(w){
  const g={};
  for(const[d,r]of Object.entries(w.windows||{})){(g[r.join("-")] ||= []).push(Number(d))}
  return Object.entries(g).map(([k,ds])=>dayLabel(ds)+" "+rangeLabel(k.split("-").map(Number))).join(" · ");
}
function watchEl(w,i){
  const div=document.createElement("div");div.className="watch";
  div.innerHTML='<div class="whead"><span class="wt">WATCH '+(i+1)+'</span><button type="button" class="wrm">삭제</button></div>'+
    '<label>서비스</label><select class="ws">'+SVC_OPTS+'</select>'+
    '<label>직원</label><select class="wr">'+RES_OPTS+'</select>'+
    '<label>요일 · 시간 (베를린)</label><div class="days">'+
    [1,2,3,4,5,6].map(d=>{
      const r=(w&&w.windows&&w.windows[d]);
      return '<div class="dayrow"><label><input type="checkbox" class="don" data-d="'+d+'"'+(r?" checked":"")+
        '><span class="dchip">'+DOW[d]+'</span></label>'+
        '<input type="number" class="df" data-d="'+d+'" min="0" max="23" value="'+(r?r[0]:10)+'"'+(r?"":" disabled")+'>'+
        '<span class="sep">–</span>'+
        '<input type="number" class="dt" data-d="'+d+'" min="1" max="24" value="'+(r?r[1]:19)+'"'+(r?"":" disabled")+'></div>';
    }).join("")+'</div>';
  div.querySelector(".ws").value=w?w.serviceId:SVC[0].id;
  div.querySelector(".wr").value=w?(w.resourceId||""):"";
  div.querySelector(".wrm").onclick=()=>{if(document.querySelectorAll(".watch").length>1)div.remove()};
  div.querySelectorAll(".don").forEach(cb=>cb.onchange=()=>{
    const d=cb.dataset.d;
    div.querySelector('.df[data-d="'+d+'"]').disabled=!cb.checked;
    div.querySelector('.dt[data-d="'+d+'"]').disabled=!cb.checked;
  });
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
      const d=cb.dataset.d;
      windows[d]=[Number(el.querySelector('.df[data-d="'+d+'"]').value),Number(el.querySelector('.dt[data-d="'+d+'"]').value)];
    });
    if(Object.keys(windows).length){
      out.push({serviceId:el.querySelector(".ws").value,resourceId:el.querySelector(".wr").value,windows});
    }
  });
  return out;
}
function render(s){
  const c=s.config,lt=s.lastTick||{};
  $("liveDot").className="dot"+(c.enabled?" on":"");
  const r=RESULT[lt.result]||{t:lt.result||"대기 중",c:"b-gray"};
  $("stateBadge").className="badge "+r.c;$("stateBadge").textContent=r.t;
  $("tickTime").textContent=lt.at?("마지막 기록 "+ago(lt.at)+(c.enabled?" · ~20초 폴링 중":"")):"";
  $("cond").innerHTML=(c.watches||[]).map(w=>{
    const svc=(SVC.find(x=>x.id===w.serviceId)||{}).name||w.serviceId;
    const res=(RES.find(x=>x.id===(w.resourceId||""))||{}).name||w.resourceId;
    return '<div class="wsum"><div class="ws-t"><b>'+svc+'</b><span>'+res+'</span></div>'+
      '<div class="ws-d">'+watchDesc(w)+'</div>'+
      '<div class="ws-r">'+korDate(c.dateFrom)+" ~ "+korDate(c.dateTo)+" 감시 중</div></div>";
  }).join("");
  let ev="";
  if(s.booked)ev+='<div class="eventBox ev-ok">예약 접수됨 — <b class="mono">'+(s.booked.label||"")+'</b>'+(s.booked.service?" ("+s.booked.service+")":"")+" — "+ago(s.booked.at)+" 에 잡힘</div>";
  $("events").innerHTML=ev;
}
let dirty=false;
$("f").addEventListener("input",()=>{dirty=true});
async function load(){
  const s=await (await fetch("/status"+KEY)).json();
  if(!dirty){
    const c=s.config;
    $("enabled").checked=c.enabled;
    $("dateFrom").value=c.dateFrom;$("dateTo").value=c.dateTo;
    renderWatches(c.watches||[]);
  }
  render(s);
}
$("addWatch").onclick=()=>$("watches").appendChild(watchEl(null,document.querySelectorAll(".watch").length));
$("f").onsubmit=async e=>{
  e.preventDefault();
  const body={enabled:$("enabled").checked,dateFrom:$("dateFrom").value,dateTo:$("dateTo").value,watches:readWatches()};
  const r=await (await fetch("/config"+KEY,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})).json();
  toast(r.ok?"저장됨":("오류: "+(r.error||"")));
  if(r.ok)dirty=false;
  load();
};
$("checkBtn").onclick=async()=>{
  const box=$("checkResult");box.style.display="block";box.innerHTML='<div class="cond">조회 중…</div>';
  const r=await (await fetch("/check"+KEY)).json();
  if(r.status==="found"){
    box.innerHTML='<div class="cond"><b>'+r.count+'개 빈자리</b> (가장 빠른 것부터 예약 시도)</div><div class="slots">'+r.slots.map(s=>"<span>"+s+"</span>").join("")+"</div>";
  }else{
    box.innerHTML='<div class="cond">'+((RESULT[r.status]||{}).t||r.status)+(r.error?" — "+r.error:"")+"</div>";
  }
  load();
};
$("resetBtn").onclick=async()=>{if(confirm("예약/확인 상태를 지울까요?")){await fetch("/reset"+KEY);toast("리셋됨");load()}};
load();setInterval(load,15000);
</script></body></html>`;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
