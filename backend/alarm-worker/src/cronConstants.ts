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
