# shore-sniper

A Cloudflare Worker that watches a Shore booking widget (le vivant, a hair salon in Düsseldorf) and books the first slot matching configured criteria. It exists to catch cancellation slots that get taken within seconds.

## How it works

- A cron trigger runs every minute. Each invocation fires three sub-polls spaced 20 seconds apart, so effective detection latency is about 20 seconds.
- Each poll queries the Shore availability API for the configured date range, service, and optional staff member.
- The earliest matching slot is booked through the guest booking endpoint. If it was taken in the meantime, up to three candidates are tried within the same tick.
- On success the worker records the booking in KV and disables itself. A receipt email arrives from Shore.
- Watch settings are edited on a small settings page protected by `ADMIN_KEY`.

## Endpoints

All endpoints accept `?key=<ADMIN_KEY>`.

- `GET /`: settings page for editing watch criteria
- `GET /status`: current config, last tick result, booking record
- `GET`/`POST /config`: read or replace the watch config
- `GET /check`: dry-run poll, lists matching slots without booking
- `GET /book-now`: run one real poll immediately
- `GET /reset`: clear the booked state
- `GET /debug-raw`: last raw availability response when parsing failed

## Setup

You need a Cloudflare account and wrangler.

```bash
npm install
npx wrangler kv namespace create STATE    # paste the id into wrangler.toml
npx wrangler secret put ADMIN_KEY
npx wrangler secret put CUSTOMER_FIRST_NAME   # also LAST_NAME, EMAIL, MOBILE, GENDER
cp src/personal.example.js src/personal.js    # your own deadlines, gitignored
npm run deploy
```

Optional Telegram bot: create a bot with BotFather, then set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `TELEGRAM_WEBHOOK_SECRET` as secrets and register `https://<worker>/telegram` with `setWebhook` and the same `secret_token`. The bot sends booking alerts, accepts commands (`status`, `on`, `off`, `check`) and parses free-text requests with Workers AI. Every config change needs a button confirmation.

For local dev, create `.dev.vars` with the same keys, then:

```bash
npm run dev    # workerd locally, cron via /__scheduled
```

## Files

- `src/index.js`: worker entry: cron handler, HTTP router, settings page
- `src/nl.js`: turns Telegram text into a watch config (AI only returns an intent, dates and matching are plain code)
- `src/reminders.js`: scheduled Telegram reminders and deadline alerts
- `src/personal.js`: personal deadlines, gitignored (see `src/personal.example.js`)
- `src/services.js`: service catalog for the salon (id, name, duration)
- `wrangler.toml`: cron schedule, KV binding, non-secret defaults
- `.dev.vars`: local secrets, gitignored. Production secrets go through `wrangler secret put` only.

## Notes

- The worker makes about three API calls per minute. Shore rate limiting (429) is recorded as `fetch_error` in `lastTick`.
- Cron granularity is one minute, the Workers minimum. Sub-polling narrows the gap, but a slot taken between sub-polls is logged as `slot_taken` and polling continues.
- KV writes are throttled to significant events plus a 2-minute heartbeat to stay under the free quota.
