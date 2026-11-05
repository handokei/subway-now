/**
 * #3005 PR-D-b — status 'ended' 응답이 **현재 trip이 아닌 이전 trip**의 marker인지 판정.
 *
 * backend marker 보존이 10h로 늘어 같은 token의 이전 trip marker가 조회에 섞일 수 있다
 * (register 실패로 현재 trip이 backend에 없는 상황). 이 marker로 현재 trip을 'ended' 정리하면 안 된다.
 * 양쪽 corrId가 모두 있고 다를 때만 true — 한쪽이라도 모르면(구 backend/cache 미수화) 기존 동작(false).
 */
export function isEndedMarkerOfOtherTrip(
  markerCorrId: string | undefined,
  currentCorrId: string | null,
): boolean {
  return Boolean(markerCorrId) && currentCorrId !== null && markerCorrId !== currentCorrId;
}
