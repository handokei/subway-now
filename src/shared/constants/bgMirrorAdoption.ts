/**
 * #3319 PR-d — BG(silent push) LA 갱신이 backend SSoT 미러를 채택할 때 `lastAdvanceAt`(backend가 마지막으로
 * 전진한 시각)의 허용 상한. 이 시간 넘게 묵은 미러는 GPS 품질과 무관하게 채택하지 않는다.
 * 11/04 실측: GPS 60s+ stale이라 기존 회귀 가드가 꺼진 채 22분 묵은 2호선 '성수' 미러가 7호선 구간 LA에 표시됐다.
 * 값은 `BACKEND_SSOT_ADVANCE_STALE_MS`(180s)와 동일 — 역간 소요(2~3분) + 여유.
 */
export const BG_MIRROR_MAX_ADVANCE_AGE_MS = 180_000;
