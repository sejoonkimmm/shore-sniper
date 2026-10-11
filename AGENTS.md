# shore-sniper

Cancellation-slot sniper for the Shore booking widget (connect.shore.com). Target: le vivant, a Korean hair salon in Düsseldorf. Runs on Cloudflare Workers with a 1-minute cron trigger and KV, so no local machine has to stay on.

## Deployed state (as of 2026-10-11)

- URL: `https://shore-sniper.bod092512.workers.dev`
- Settings page: `https://shore-sniper.bod092512.workers.dev/?key=<ADMIN_KEY>` (key is a secret, for bookmarking)
- Cron `* * * * *`. Inside each invocation, three sub-polls run 20 seconds apart via `scheduler.wait` (`POLL_ITERATIONS`), giving ~20s effective detection latency. KV binding `STATE` (id `97ead7147baa42409753b468e070bd8e`).
- The watch config is edited live on the settings page. Check current values via `/status?key=`.
- `CUSTOMER_*` secrets are registered (Sejoon Kim / male / email stored in secrets).

## Flow

1. Cron tick loads `config` from KV. Skips when `enabled:false` or `booked` exists.
2. `POST https://api.shore.com/v2/availability/calculate_slots` (no auth needed).
3. Earliest matching slot goes to `POST https://api.shore.com/v3/bookings`. On `slot_taken`, up to 3 candidates are retried within the same tick.
4. On success the worker writes `booked` to KV, sets `config.enabled=false`, and idles. The confirmation email is a plain receipt with no separate DOI step (verified 2026-10-11). The Gmail check logic was removed.

## Shore API recon (from reversing the widget bundle)

- Required header: `X-Shore-Origin: booking-widget`. No other auth for guest bookings.
- merchant_id `07fe87fa-e905-4f69-b58e-19f37379e54f`, slug `le-vivant`, tz `Europe/Berlin`.
- Availability body: `{merchant_id, timezone, starts_at:"yyyy-MM-dd HH:mm:ss", ends_at, search_weeks_range:0, required_capacity:"1", services_resources:[{service_id, resource_id?}]}`. Omitting `resource_id` means "any staff member".
- Booking body: `{appointment:{customer:{first_name*,last_name*,email*,mobile,locale,opt_in}, customer_custom_attributes:[], datetime:ISO(UTC), merchant_id, origin:"https://connect.shore.com", required_capacity:1, services:[{requirements:[],resource_uuid?,uuid:serviceId,employee_selected_by}], special_wishes, ...}}`
  - `employee_selected_by`: `"not_defined"` when a staff member is picked, `"auto"` for any staff (mirrors widget logic).
- Staff: Leehyun `88ae1994-…`, An `5f919e8d-…`, Suji Kim `7f384c5a-…` (clinic only). Full list via `GET secure.shore.com/api/widget/{slug}/resources`.
- Full service catalog lives in `src/services.js` (36 entries, extracted from `__PREFETCHED_DATA__` on the booking page).
- The API returns `double_opt_in_required:true`, but bookings take effect immediately on POST (verified 2026-10-11 with a real booking: the slot vanished from availability right away). The confirmation email is a "has been booked" receipt with no confirm button. Its only CTA is a "Your Appointment" button wrapped in `awstrack.me/L0/` pointing at `communication.shore.com/click/<uuid>?p=<b64{target:connect.shore.com/appointments/…,verification}>`. Opening that link loads the booking management page and counts as click tracking, which acts as the de facto DOI.

## Files

- `src/index.js`: the whole worker: cron handler, fetch router, settings page HTML.
- `src/services.js`: service catalog (id, name, duration).
- `wrangler.toml`: cron, KV binding, non-secret defaults.
- `.dev.vars`: local secrets (gitignored). Production secrets only via `wrangler secret put`.

## KV schema

- `config`: `{enabled, dateFrom, dateTo, watches:[{serviceId, resourceId, windows:{dow:[minH,maxH]}}]}`. Up to 4 watches, each with per-weekday hour windows. The legacy `{dow,minHour,maxHour}` shape is auto-converted by `getConfig`.
- `booked`: `{label, service, datetime, response, at}`.
- `lastTick`: last tick result. Significant events only, plus a 2-minute heartbeat, because the free KV write quota is 1000/day.
- `debug:lastRaw`: raw response saved when slots existed but parsing failed (24h TTL).

## Secrets

- `ADMIN_KEY`: protects the settings page and endpoints via `?key=`.
- `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`: registered but unused by current code (Gmail confirmation path removed 2026-10-11).
- `CUSTOMER_FIRST_NAME/LAST_NAME/EMAIL/MOBILE/GENDER`: customer identity used in bookings.

## Commands

```bash
npm run dev                  # local workerd, trigger cron manually via /__scheduled
npm run deploy               # deploy to Cloudflare
npx wrangler secret put NAME # register a secret
```

## Known unverified items and risks

- `times[]` elements are `"16:00"` style strings (confirmed by measurement).
- Observed bookable range at le vivant on weekdays: last slot around 10:00–17:30 for a 30-minute service (shop closes at 18:00). With minHour 16 the effective window is 16:00–17:30.
- Cron granularity is 1 minute, the Workers minimum. Sub-polling covers ~20s. A slot grabbed between sub-polls shows up as `slot_taken` and watching continues.
- Shore rate limiting returns 429, recorded as `fetch_error` (currently about 3 API calls per minute).

## Verified by a real booking on 2026-10-11

- The booking POST succeeds instantly. The confirmation mail arrives about 20 seconds later and the slot disappears from availability immediately. There is no separate DOI confirmation step. Gmail check and link-click logic were removed after this test.
- Cancellation works through the booking link in the email (`connect.shore.com/bookings/appointments/<uuid>`), which opens the management page (shop policy: phone or website).
- `wrangler kv key` commands hit the local dev store by default. Use `--remote` for production.
- `/status` KV reads can be stale by tens of seconds to a few minutes due to edge caching. For exact values use `wrangler kv key get --remote`.
