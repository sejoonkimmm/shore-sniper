# shore-sniper

Shore(connect.shore.com) 예약 취소표 스나이핑 봇. 대상: **le vivant** (한인 미용실, Düsseldorf).
Cloudflare Worker + Cron(1분) + KV로 동작 — 로컬 서버/PC 상시가동 불필요.

## 배포된 상태 (2026-10-11 기준)

- URL: `https://shore-sniper.<subdomain>.workers.dev`
- 설정 페이지: `https://shore-sniper.<subdomain>.workers.dev/?key=<ADMIN_KEY>` (key=시크릿, 북마크 용도)
- Cron `* * * * *` — 한 호출 안에서 `scheduler.wait`으로 20초 간격 서브폴링 3회 (`POLL_ITERATIONS`) → 실효 ~20초 감지 지연. KV binding `STATE` (id `97ead7147baa42409753b468e070bd8e`)
- 저장된 config: 사용자가 설정 페이지에서 실시간 변경 (최신값은 `/status?key=`로 확인)
- CUSTOMER_* 시크릿 등록 완료 (`wrangler secret put`으로만 관리)

## 동작 흐름

1. Cron tick → KV `config` 로드 (`enabled:false` 또는 `booked` 존재 시 스킵)
2. `POST https://api.shore.com/v2/availability/calculate_slots` (인증 불필요)
3. 조건 맞는 가장 빠른 슬롯 → `POST https://api.shore.com/v3/bookings` (slot_taken 시 같은 틱 안에서 최대 3개 후보까지 재시도)
4. 성공 → KV `booked` 기록, `config.enabled=false` → 종료. 예약 확정 메일은 영수증(별도 DOI 액션 불필요, 2026-10-11 실증) — Gmail 확인 로직은 제거됨

## Shore API 정찰 결과 (위젯 번들 리버싱)

- 헤더: `X-Shore-Origin: booking-widget` 필수, 그 외 인증 없음 (게스트 예약)
- merchant_id `07fe87fa-e905-4f69-b58e-19f37379e54f`, slug `le-vivant`, tz `Europe/Berlin`
- 가용시간 바디: `{merchant_id, timezone, starts_at:"yyyy-MM-dd HH:mm:ss", ends_at, search_weeks_range:0, required_capacity:"1", services_resources:[{service_id, resource_id?}]}` — resource_id 생략 = "아무 직원"
- 예약 바디: `{appointment:{customer:{first_name*,last_name*,email*,mobile,locale,opt_in}, customer_custom_attributes:[], datetime:ISO(UTC), merchant_id, origin:"https://connect.shore.com", required_capacity:1, services:[{requirements:[],resource_uuid?,uuid:serviceId,employee_selected_by}], special_wishes, ...}}`
  - `employee_selected_by`: 지정 직원=`"not_defined"`, 무지정=`"auto"` (위젯 로직 모사)
- 직원: Leehyun `88ae1994-…`, An `5f919e8d-…`, Suji Kim `7f384c5a-…`(클리닉 전담) — GET `secure.shore.com/api/widget/{slug}/resources`
- 서비스 전체 목록: `src/services.js` (36개, 페이지 `__PREFETCHED_DATA__`에서 추출)
- `double_opt_in_required:true` 이지만 **실측 결과 예약은 POST 시점에 즉시 성립** (2026-10-11 실예약 검증: 잡은 슬롯이 가용 목록에서 즉시 사라짐). 확정 메일은 "has been booked" 영수증 형태 — 별도 confirm 버튼 없음. CTA는 "Your Appointment" 버튼 = `awstrack.me/L0/` 래핑된 `communication.shore.com/click/<uuid>?p=<b64{target:connect.shore.com/appointments/…,verification}>`. 링크 클릭은 예약 관리 페이지 열기 + 클릭 추적(=사실상의 DOI 검증)이며 봇이 자동 GET함

## 파일

- `src/index.js` — Worker 전체 (cron handler, fetch 라우터, 설정 페이지 HTML)
- `src/services.js` — 서비스 목록 (id/name/dur)
- `wrangler.toml` — cron/KV/env defaults
- `.dev.vars` — 로컬 시크릿 (gitignore). 프로덕션 시크릿은 `wrangler secret put`으로만 관리

## KV 키 스키마

- `config` — `{enabled, dateFrom, dateTo, watches:[{serviceId, resourceId, windows:{dow:[minH,maxH]}}]}` (최대 4개 watch, 요일별 시간창. 레거시 `{dow,minHour,maxHour}` 형태는 getConfig가 자동 변환)
- `booked` — `{label, service, datetime, response, at}`
- `lastTick` — 마지막 틱 결과 (중요 이벤트만 + 2분 하트비트 — KV 쓰기 1000/일 무료한도 때문)
- `debug:lastRaw` — 슬롯 있는데 파싱 실패 시 원본 응답 (TTL 24h)

## 시크릿

- `ADMIN_KEY` — 설정 페이지/엔드포인트 인증 (`?key=`)
- `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` — 등록돼 있으나 현재 코드 미사용 (Gmail 확인 경로 제거됨, 2026-10-11)
- `CUSTOMER_FIRST_NAME/LAST_NAME/EMAIL/MOBILE/GENDER` — 예약자 정보

## 명령어

```bash
npm run dev          # 로컬 (workerd, /__scheduled로 크론 수동 트리거)
npm run deploy       # 배포
npx wrangler secret put NAME   # 시크릿 등록
```

## 알려진 미검증/리스크

- `times[]` 원소 = `"16:00"` 형태 문자열 (실측 확인)
- le vivant 예약 가능 시간대 실측: 평일 ~10:00–17:30 마지막 슬롯 (30분 서비스 기준, 18시 마감) — minHour 16 이상이면 실효 창은 16:00~17:30
- Cron 최소 간격 1분(Workers 한계) — 서브폴링으로 ~20초 커버. 그 사이 선점되면 `slot_taken`으로 기록되고 계속 감시
- Shore 레이트리밋 시 429 → `fetch_error`로 기록됨 (현재 분당 ~3회 호출)

## 2026-10-11 실예약 테스트로 확인된 것들

- 예약 POST → 즉시 성립 (메일 "~20초 후 도착", 가용 슬롯 즉시 소멸). 별도 DOI 확정 단계는 없음 — Gmail 확인/링크클릭 로직은 이 테스트 후 제거됨
- 예약 취소: 메일의 예약 링크(connect.shore.com/bookings/appointments/<uuid>) → 웹사이트에서 취소 가능 (샵 공지: 전화 또는 웹사이트)
- `wrangler kv key` 명령은 기본 **로컬 dev 스토어** — 프로덕션 조작은 반드시 `--remote` 플래그
- `/status`의 KV 읽기는 edge 캐시로 수십 초~수분 stale할 수 있음 — 정확한 값은 `wrangler kv key get --remote`로 확인
