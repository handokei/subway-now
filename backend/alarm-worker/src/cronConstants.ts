/**
 * cron 명목 주기 공유 상수 (#2602 코드리뷰 항목5).
 *
 * `scheduled.ts`(`CRON_NOMINAL_INTERVAL_MS`)와 `transferDestinationGate.ts`
 * (freshness cycle 계산)가 각자 독립 상수로 60_000을 중복 정의했던 것을 이 파일 하나로
 * 합친다 — 애초에 두 모듈을 분리한 목적(순환 import 회피: `transferDestinationGate.ts`는
 * `scheduled.ts`가 import하는 하위 모듈이라 반대 방향 import 불가)은 이 별도 파일로도
 * 그대로 달성된다(두 모듈 다 이 파일만 import, 서로를 import하지 않음).
 *
 * `wrangler.toml`의 `[triggers].crons`(현재 매 1분 주기)와 값이 반드시 일치해야 한다 —
 * 빌드 타임 검증은 없고 수동 동기화다. cron 트리거 주기를 바꾸면 이 상수도 함께 갱신할 것.
 */
export const CRON_INTERVAL_MS = 60_000;

/**
 * #2615 — cycle 내 +30초 재폴링·재발사 pass(midCycle) 오프셋.
 *
 * cron 명목 주기(`CRON_INTERVAL_MS`)의 정확히 절반 뒤에 경량 2차 pass를 실행해 발사
 * 양자화를 60초→30초로 절반화한다. `CRON_INTERVAL_MS`를 소비하는 파생 상수라 주기가
 * 바뀌어도 이 파일 하나만 갱신하면 자동으로 따라온다.
 */
export const MID_CYCLE_OFFSET_MS = CRON_INTERVAL_MS / 2;

/**
 * #2615 (재설계, 코드리뷰 F7) — mid-cycle pass 시작에 필요한 최소 남은 시간(ms).
 *
 * `scheduleMidCyclePass`가 t+30 anchor까지 남은 시간(`MID_CYCLE_OFFSET_MS -
 * 경과시간`, F5 드리프트 보정)을 계산했을 때 이 값 미만이면 스케줄 자체를 skip한다 —
 * 대기가 너무 짧으면(또는 이미 지났으면) 다음 cron과 경합할 실익이 없다. 아래
 * `MID_CYCLE_START_GUARD_MS`의 파생 기준이기도 하다(같은 여유값 재사용, magic number 중복 방지).
 */
export const MID_CYCLE_MIN_REMAINING_MS = 10_000;

/**
 * #2615 (재설계, 코드리뷰 F7) — mid-cycle pass 시작 가드 임계값(cycle 시작 기준 경과 ms).
 *
 * `CRON_INTERVAL_MS - MID_CYCLE_MIN_REMAINING_MS`로 파생 — cron 주기가 바뀌어도 magic
 * number 재조정 없이 따라온다. `handler.scheduled`가 바쁘거나 waitUntil 스케줄이 밀려
 * 대기 후 실제 시작 시각이 이 임계값을 넘으면 다음 cron tick(t+60)과 겹칠 위험이 있어
 * pass 자체를 skip한다 — "겹침" 리스크 관리(#2615 이슈 본문 항목 3).
 */
export const MID_CYCLE_START_GUARD_MS = CRON_INTERVAL_MS - MID_CYCLE_MIN_REMAINING_MS;
