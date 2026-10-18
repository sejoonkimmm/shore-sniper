// Natural-language commands for the Telegram bot.
// The model only turns text into an intent object. Everything that must be exact
// (dates, service matching, time rounding) is resolved here in plain code.

const DOW = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
const DOW_KO = ["", "월", "화", "수", "목", "금", "토", "일"];
const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, "0");

const dowOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
const isoOf = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export function buildMessages(text, { today }) {
  const wd = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][dowOf(today.y, today.m, today.d)];
  const system = `You turn a message from a hair salon customer into one JSON object. Reply with JSON only, no prose, no code fences.

Today is ${wd} ${today.y}-${pad(today.m)}-${pad(today.d)} (Europe/Berlin).

Schema:
{"intent":"set_watch"|"enable"|"disable"|"status"|"check"|"unknown",
 "service":string|null,
 "staff":string|null,
 "mode":"replace"|"add",
 "range":{"kind":"unspecified"|"this_week"|"next_week"|"next_days"|"explicit","days":number|null,"from":string|null,"to":string|null},
 "windows":[{"days":["mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"sun"],"from":string|null,"to":string|null}]}

Rules:
- set_watch: the user wants to be booked into free slots. enable/disable: turn the bot on or off. status: asks what is currently set. check: asks what is free right now.
- service: the service the user named, as a short English salon term. Translate Korean: 아이롱펌="iron perm", 커트="cut", 매직="magic straightening", 웨이브펌="wave perm", 다운펌="down perm", 염색="color". null if none named.
- staff: a person's name only if the user names one, else null.
- mode: "add" only if the user says to add another one or also. Otherwise "replace".
- range: this_week = today through Sunday. next_week = next Monday through next Sunday. next_days = within the next N days, put N in "days". explicit = "from" and "to" as YYYY-MM-DD, using the year of today. unspecified = no dates given.
- windows: one entry per distinct time rule. "from" is the earliest start time and "to" the latest start time, both 24h "HH:MM". Use null when not said.
- Days: "Mon-Thu" = mon,tue,wed,thu. "weekdays" = mon..fri. "weekend" = sat,sun. If no day is named, use all of mon..sat.
- Times: a bare hour from 1 to 8 means afternoon (3 -> 15:00, 1 -> 13:00). A bare 9 to 12 is that hour in the morning. "after 3pm", "from 3" and "15시부터" all mean from=15:00.

Examples:
User: Mon-Thu from 15:00 iron perm, Friday from 1
{"intent":"set_watch","service":"iron perm","staff":null,"mode":"replace","range":{"kind":"unspecified","days":null,"from":null,"to":null},"windows":[{"days":["mon","tue","wed","thu"],"from":"15:00","to":null},{"days":["fri"],"from":"13:00","to":null}]}
User: cut with An next week tuesday between 10 and 12
{"intent":"set_watch","service":"cut","staff":"An","mode":"replace","range":{"kind":"next_week","days":null,"from":null,"to":null},"windows":[{"days":["tue"],"from":"10:00","to":"12:00"}]}
User: 다음주 월~목 3시 이후 아이롱펌 잡아줘
{"intent":"set_watch","service":"iron perm","staff":null,"mode":"replace","range":{"kind":"next_week","days":null,"from":null,"to":null},"windows":[{"days":["mon","tue","wed","thu"],"from":"15:00","to":null}]}
User: turn it off
{"intent":"disable","service":null,"staff":null,"mode":"replace","range":{"kind":"unspecified","days":null,"from":null,"to":null},"windows":[]}`;
  return [
    { role: "system", content: system },
    { role: "user", content: String(text).slice(0, 500) },
  ];
}

// Models may return a string, a fenced string, or an already parsed object.
export function extractIntent(out) {
  let r = out;
  if (r && typeof r === "object") {
    if (r.intent) return r;
    r = r.response ?? r.choices?.[0]?.message?.content ?? r.result ?? "";
    if (r && typeof r === "object") return r.intent ? r : null;
  }
  const s = String(r);
  const a = s.indexOf("{"), z = s.lastIndexOf("}");
  if (a < 0 || z < a) return null;
  try {
    return JSON.parse(s.slice(a, z + 1));
  } catch {
    return null;
  }
}

const tokens = (s) => String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
const STOP = new Set(["the", "a", "an", "for", "please", "m", "w"]);

export function matchService(query, services) {
  const qt = tokens(query).filter((t) => !STOP.has(t));
  if (!qt.length) return { ask: "어떤 서비스인지 알려 주세요. 예: iron perm, cut" };
  const pool = services.filter((s) => !/^(\+|notice)/i.test(s.name.trim()));
  const hits = pool
    .map((s) => ({ s, nt: tokens(s.name).filter((t) => t !== "m" && t !== "w") }))
    .filter(({ nt }) => qt.every((t) => nt.some((n) => n === t || n.startsWith(t))))
    .map((h) => ({ ...h, extra: h.nt.length - qt.length }));
  if (!hits.length) return { ask: `"${query}"에 맞는 서비스를 못 찾았어요. 서비스 이름을 다시 알려 주세요.` };
  const best = Math.min(...hits.map((h) => h.extra));
  let top = hits.filter((h) => h.extra === best);
  if (top.length > 1) {
    const men = top.filter((h) => /^m\b/i.test(h.s.name.trim()));
    if (men.length) top = men;
  }
  const byName = new Map(top.map((h) => [h.s.name.trim(), h.s]));
  if (byName.size > 1) {
    const names = [...byName.keys()].slice(0, 6).join(", ");
    return { ask: `"${query}"에 해당하는 서비스가 여러 개예요. 후보는 ${names}예요. 하나를 골라 다시 보내 주세요.` };
  }
  return { service: [...byName.values()][0] };
}

function matchStaff(name, resources) {
  if (!name) return { resourceId: "" };
  const q = String(name).toLowerCase().trim();
  if (/^(any|anyone|no preference)$/.test(q)) return { resourceId: "" };
  const r = resources.find((x) => x.id && x.name.toLowerCase().includes(q));
  return r ? { resourceId: r.id, name: r.name } : { ask: `"${name}" 직원을 못 찾았어요. 이름을 다시 알려 주세요.` };
}

export function resolveRange(range, today, current) {
  const t = Date.UTC(today.y, today.m - 1, today.d);
  const dow = dowOf(today.y, today.m, today.d);
  const kind = range?.kind || "unspecified";
  if (kind === "this_week") return { from: isoOf(t), to: isoOf(t + (7 - dow) * DAY_MS) };
  if (kind === "next_week") {
    const mon = t + (8 - dow) * DAY_MS;
    return { from: isoOf(mon), to: isoOf(mon + 6 * DAY_MS) };
  }
  if (kind === "next_days") {
    const n = Math.round(Number(range.days));
    if (!(n >= 1 && n <= 120)) return { ask: "며칠 안에 잡을지 알려 주세요." };
    return { from: isoOf(t), to: isoOf(t + n * DAY_MS) };
  }
  if (kind === "explicit") {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const from = re.test(range.from || "") ? range.from : isoOf(t);
    const to = re.test(range.to || "") ? range.to : null;
    if (!to || to < from || to < isoOf(t)) return { ask: "날짜 범위를 이해하지 못했어요. 예: 10월 20일부터 10월 24일까지" };
    return { from: from < isoOf(t) ? isoOf(t) : from, to };
  }
  if (current && current.dateTo >= isoOf(t)) return { from: current.dateFrom < isoOf(t) ? isoOf(t) : current.dateFrom, to: current.dateTo, kept: true };
  return { from: isoOf(t), to: isoOf(t + 14 * DAY_MS), defaulted: true };
}

function toTime(v, fallback) {
  if (v == null || v === "") return { min: fallback };
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim());
  if (!m) return { error: true };
  const min = Number(m[1]) * 60 + Number(m[2]);
  if (min < 0 || min > 24 * 60 - 1) return { error: true };
  return { min: Math.floor(min / 10) * 10 };
}
const fmt = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;

const DAY_GROUPS = {
  weekday: [1, 2, 3, 4, 5], weekdays: [1, 2, 3, 4, 5],
  weekend: [6, 7], weekends: [6, 7],
  daily: [1, 2, 3, 4, 5, 6], everyday: [1, 2, 3, 4, 5, 6], all: [1, 2, 3, 4, 5, 6],
};

function expandDays(list) {
  const out = new Set();
  for (const d of list) {
    const k = String(d).toLowerCase().trim();
    if (DAY_GROUPS[k]) DAY_GROUPS[k].forEach((x) => out.add(x));
    else if (DOW[k.slice(0, 3)]) out.add(DOW[k.slice(0, 3)]);
  }
  return [...out];
}

export function resolveWindows(windows) {
  const out = {};
  const list = Array.isArray(windows) && windows.length ? windows : [{ days: [], from: null, to: null }];
  for (const w of list) {
    let days = expandDays(Array.isArray(w.days) ? w.days : []);
    if (!days.length) days = [1, 2, 3, 4, 5, 6];
    const a = toTime(w.from, 0), z = toTime(w.to, 23 * 60 + 50);
    if (a.error || z.error) return { ask: "시간을 이해하지 못했어요. 예: 15시부터, 10시에서 12시 사이" };
    if (a.min > z.min) return { ask: "시작 시각이 끝 시각보다 늦어요. 시간을 다시 알려 주세요." };
    for (const d of days) out[d] = [fmt(a.min), fmt(z.min)];
  }
  return { windows: out };
}

const korDate = (iso) => `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;

function dayLabel(ds) {
  ds = [...ds].sort((a, b) => a - b);
  if (ds.length === 1) return `${DOW_KO[ds[0]]}요일`;
  if (ds.every((d, i) => i === 0 || d === ds[i - 1] + 1)) return `${DOW_KO[ds[0]]}~${DOW_KO[ds[ds.length - 1]]}`;
  return ds.map((d) => DOW_KO[d]).join("·");
}

function timeLabel([a, z]) {
  if (a === "00:00" && z >= "23:50") return "하루종일";
  if (z >= "23:50") return `${a} 이후`;
  return `${a} ~ ${z}`;
}

export function describeWatch(w, services, resources) {
  const svc = services.find((s) => s.id === w.serviceId);
  const res = resources.find((r) => r.id === (w.resourceId || ""));
  const groups = {};
  for (const [d, r] of Object.entries(w.windows || {})) (groups[r.join("-")] ||= []).push(Number(d));
  const lines = Object.entries(groups)
    .sort((x, y) => Math.min(...x[1]) - Math.min(...y[1]))
    .map(([k, ds]) => `  ${dayLabel(ds)} ${timeLabel(k.split("-"))}`);
  return [`${svc ? svc.name : w.serviceId}${svc ? ` (${svc.dur}분)` : ""}, ${res && res.id ? res.name : "직원 상관없음"}`, ...lines].join("\n");
}

export function describeConfig(cfg, services, resources) {
  return [
    `기간 ${korDate(cfg.dateFrom)} ~ ${korDate(cfg.dateTo)}`,
    ...cfg.watches.map((w, i) => `${cfg.watches.length > 1 ? `[${i + 1}] ` : ""}${describeWatch(w, services, resources)}`),
  ].join("\n");
}

// Returns {config, summary} for a set_watch intent, or {ask} when it needs a follow-up.
export function resolveSetWatch(intent, { today, services, resources, current }) {
  const svc = matchService(intent.service, services);
  if (svc.ask) return svc;
  const staff = matchStaff(intent.staff, resources);
  if (staff.ask) return staff;
  const range = resolveRange(intent.range, today, current);
  if (range.ask) return range;
  const win = resolveWindows(intent.windows);
  if (win.ask) return win;

  const watch = { serviceId: svc.service.id, resourceId: staff.resourceId, windows: win.windows };
  let watches = [watch];
  if (intent.mode === "add" && current && Array.isArray(current.watches)) {
    watches = [...current.watches, watch];
    if (watches.length > 4) return { ask: "대상은 최대 4개까지예요. 기존 대상을 줄이거나 새로 교체해 주세요." };
  }
  const config = { enabled: true, dateFrom: range.from, dateTo: range.to, watches };
  const note = range.defaulted ? "\n날짜를 말씀하지 않아서 오늘부터 2주로 잡았어요." : range.kept ? "\n날짜는 기존 설정을 그대로 썼어요." : "";
  const head = intent.mode === "add" ? `기존 ${watches.length - 1}개에 추가해요.\n` : "";
  return { config, summary: `${head}${describeConfig(config, services, resources)}${note}` };
}
