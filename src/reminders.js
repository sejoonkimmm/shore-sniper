import { DEADLINES } from "./personal.js";

// Scheduled reminders sent through the Telegram bot.
// Pure scheduling and message text live here. KV state and sending are in index.js.

export const REMINDERS = [
  {
    id: "face",
    days: [1, 2, 3, 4, 5],
    slots: [{ at: "15:00" }],
    url: "https://www.youtube.com/watch?v=dsiS3V03J5U",
  },
];

// A slot stays eligible for this long after its time, so a missed cron run is
// caught up but a message is never sent hours late.
const GRACE_MIN = 45;

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function inAnyWindow(reminder, now) {
  if (!reminder.days.includes(now.dow)) return false;
  const nowMin = now.hour * 60 + now.minute;
  return reminder.slots.some((s) => nowMin >= toMin(s.at) && nowMin < toMin(s.at) + GRACE_MIN);
}

export function dueSlots(reminder, now, sent) {
  if (!inAnyWindow(reminder, now)) return [];
  const nowMin = now.hour * 60 + now.minute;
  return reminder.slots.filter((s) => nowMin >= toMin(s.at) && nowMin < toMin(s.at) + GRACE_MIN && !(sent || []).includes(s.at));
}

const FACE_STEPS = [
  "턱선 끌어올리기 (엄지를 턱각 안쪽에 넣고 검지로 턱 아래를 잡아 위로 쭉 끌어올려요)",
  "교근 (너클을 광대 아래에서 턱 쪽으로 대고 입을 살짝 벌린 채 앞뒤로 문질러요, 위 중간 아래 순서예요)",
  "혀 자세 (혀 전체를 입천장에 껌처럼 넓게 펴서 위로 눌러요)",
  "코 옆 (너클로 코 옆을 가볍게 눌러 잠시 버티고 위아래로 쓸어요)",
  "턱 밑 (손을 쇄골 아래에 두고 아래로 당기며 턱을 위로 들어 10초 버텨요)",
  "관자놀이와 측두근 (너클로 위아래로 쓸고 입을 벌렸다 닫기를 반복해요)",
  "앞광대와 광대 (안쪽으로 눌렀다 위로 퍼올리고 손바닥 아랫부분으로 꾹꾹 눌러요)",
  "후두하근 (뒤통수뼈 아래 움푹한 곳을 안쪽과 바깥쪽 각각 10초씩 눌러요)",
  "목 앞쪽 SCM (쇄골 쪽으로 내려오며 가볍게 풀어요)",
  "목 옆 스트레칭 (한 손을 엉덩이 밑에 깔고 고개를 옆으로 돌려 반대쪽 겨드랑이를 보며 10초, 양쪽 모두 해요)",
];

export function buildMessage(reminder) {
  return [
    "얼굴운동 시간이에요. 5분 정도 걸려요.",
    "먼저 손을 손소독제로 깨끗하게 소독하고 시작하세요.",
    "",
    ...FACE_STEPS.map((s, i) => `${i + 1}. ${s}`),
    "",
    "세게 누르지 말고 시원한 정도로만 하세요. 통증은 10점 중 5 이하예요. 목 앞쪽과 코 옆은 아주 가볍게만 하고, 어지럽거나 저리면 바로 멈추세요.",
    `영상 ${reminder.url}`,
  ].join("\n");
}

// ---- Deadlines (data lives in the gitignored src/personal.js) ----
// Dates are the Berlin calendar date of the deadline. In late October and December
// UK time (GMT) is one hour behind Berlin, so 12:00 UK is 13:00 Berlin.

export { DEADLINES };

const DEADLINE_OFFSETS = [7, 3, 1, 0];
const DEADLINE_AT = "09:00";

const dayDiff = (from, to) => Math.round((Date.UTC(...to.split("-").map((v, i) => (i === 1 ? v - 1 : +v))) - Date.UTC(...from.split("-").map((v, i) => (i === 1 ? v - 1 : +v)))) / 86400000);

export function inDeadlineWindow(nowMin) {
  const at = toMin(DEADLINE_AT);
  return nowMin >= at && nowMin < at + GRACE_MIN;
}

export function deadlineMessage(d, days) {
  if (days === 0) {
    return `오늘 ${d.title} 마감이에요.\n베를린 시간 ${d.berlin} (UK ${d.uk})까지예요.\n제출 전에 단어 수 ±10%, Harvard 인용, 그림 캡션 번호, 파일명(${d.file})을 확인하세요.`;
  }
  return `${d.title} 마감이 ${days}일 남았어요.\n마감 ${d.date} ${d.berlin} 베를린 시간 (UK ${d.uk}).\n제출 파일명(${d.file})을 확인하세요.`;
}

// Returns [{slot, text}] to send now. "sent" holds slots already sent today.
export function dueDeadlines(date, nowMin, sent) {
  if (!inDeadlineWindow(nowMin)) return [];
  const out = [];
  for (const d of DEADLINES) {
    const days = dayDiff(date, d.date);
    if (!DEADLINE_OFFSETS.includes(days)) continue;
    const slot = `${d.id}:${days}`;
    if ((sent || []).includes(slot)) continue;
    out.push({ slot, text: deadlineMessage(d, days) });
  }
  return out;
}
