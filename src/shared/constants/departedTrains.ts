/** #3155 — 탑승 열차 목록에 "이미 출발" 열차를 남겨 두는 창(ms). 사용자 결정(2026-10-21): 10분. backend `ANCHOR_DEPARTURE_WINDOW_MS`와 같은 값. */
export const DEPARTED_TRAIN_WINDOW_MS = 10 * 60_000;

/** #3155 — backend `GET /trips/:token/anchor-departures` 조회 주기(ms). 도착 목록 polling(30s)과 같은 박자. */
export const ANCHOR_DEPARTURES_POLL_MS = 30_000;
