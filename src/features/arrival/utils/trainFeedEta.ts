import type { StationArrival } from '../../../shared/types/arrival';

/**
 * ADR-039 §5 3단계 (#2728) — lock 활성 trip의 destination ETA를 Seoul 열차 피드 1순위로 산출.
 *
 * `arrival`(목적지 역의 실시간 도착정보, `useArrivalInfo`)에서 lock된 `trainCode`(btrainNo)와
 * 일치하는 행을 찾아 `arrivalSeconds`(Seoul `barvlDt` 기반 실측 ETA, `arrivalApi.ts` 참고)를
 * 반환한다. GPS 직선거리 ÷ 속도 추정(`estimateTransitEtaSeconds`)이 아니라 열차 자신의 실측
 * 진행 데이터 — 2026-09-18 실측(잠긴 열차 7256이 지하 구간 내내 용마산 ETA를 매 cycle 정확히
 * 카운트다운)이 근거.
 *
 * 매칭 실패(피드에 해당 trainCode가 없음 — Seoul 장애, 아직 도달 전 목적지 역 리스트 미노출,
 * trainCode 미확정 pending sentinel 등)는 null — 호출자가 GPS 거리 fallback으로 강등한다
 * (ADR-039 §2 E: 삭제가 아니라 강등).
 *
 * `isImminentByArrivalCode`(같은 디렉토리, arvlCd 기반 imminent 판정)와 동일한 보수적 매칭
 * 규약을 공유한다 — arrival/trainCode 부재는 그레이스풀하게 null.
 */
export function findTrainFeedEtaSeconds(
  arrival: StationArrival | null | undefined,
  trainCode: string | null,
): number | null {
  if (!arrival || !trainCode) return null;
  // 방어적 기본값 — 호출부(테스트 mock 포함)가 up/down 없이 부분 형태의 arrival을 전달해도
  // (예: API 실패 fallback 형태) 예외 없이 매칭 실패(null)로 graceful 처리한다.
  const trains = [...(arrival.up ?? []), ...(arrival.down ?? [])];
  const match = trains.find((t) => t.trainCode === trainCode);
  return match ? match.arrivalSeconds : null;
}
