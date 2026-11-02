/**
 * #1480 PR-2 — 경로 후보 확장 상수 (findRoutes `{ expand: true }`).
 *
 * 단일 환승은 모든 공통역을 후보로 낸다. 2회 환승은 조합이 많아 상위 K개만, 그리고 최소 단일 환승 정거장 수에서
 * 이 폭(Δ) 이내인 것만 남긴다(최소 다중 1개는 기존 동작 호환으로 항상 포함).
 *
 * 값 근거(비용 측정, 무작위 이종 노선 150쌍): 기본 평균 1.9개·0.52ms/쌍 -> 확장 평균 4.5개·최대 8개·0.52ms/쌍,
 * 엔진 총 소요 0.2ms/후보 -> 출발역당 최악 약 1.6ms. 세션당 1회(InteractionManager) 계산이라 K=3·Δ=8정거장으로 충분하다.
 * 운영 중에는 `findRoutes` debug 로그의 `candidates=`·ms가 같은 근거를 남긴다.
 */
export const MULTI_TRANSFER_CANDIDATE_LIMIT = 3;
export const MULTI_TRANSFER_STOP_SLACK = 8;
