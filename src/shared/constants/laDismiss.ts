/**
 * #926 (Seam E3) — LA dismiss sentinel TTL.
 *
 * 사용자가 Live Activity를 dismiss하면 `markLaDismissed()`로 sentinel을 기록하고,
 * silent push 핸들러는 이 TTL 안의 sentinel이 있으면 LA refresh를 skip한다.
 *
 * 30분: 일반적인 트립 길이(서울 평균 30~40분) 안에서 dismiss 의사를 존중하기에 충분하면서,
 * 그 이상 silence가 지속되면 trip이 살아있어도 LA가 영영 안 뜨는 사고를 방지할 만큼 짧다.
 */
export const LA_DISMISS_SENTINEL_TTL_MS = 30 * 60_000;
