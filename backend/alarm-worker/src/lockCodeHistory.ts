/**
 * #3141 — 같은 trip에서 lock trainCode가 교체될 때(vanish-swap / 시간표 후속 정정) 옛 코드를 쌓는 이력.
 *
 * 매역 알림 dedup 마커(`stationPassedFiredKey`)는 (token, trainCode, station) 단위라, 번호가 바뀌면
 * 옛 번호로 이미 알린 역이 새 번호로 재발사된다. dedup 체크가 현재 코드 OR 이력 내 코드를 함께 보도록
 * 이력을 trip에 둔다(신규 KV key·write 0 — 이력은 이미 일어나는 putTrip에 실려 간다).
 */
export const LOCK_CODE_HISTORY_CAP = 5;

/** 옛 코드를 이력 끝에 붙인다. 중복은 무시, cap 초과 시 가장 오래된 것부터 버린다. 입력은 변이하지 않는다. */
export function appendLockCodeHistory(history: readonly string[] | undefined, oldCode: string): string[] {
  const base = history ?? [];
  if (base.includes(oldCode)) return [...base];
  return [...base, oldCode].slice(-LOCK_CODE_HISTORY_CAP);
}
