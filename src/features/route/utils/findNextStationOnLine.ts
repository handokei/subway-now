import type { LineNumber, Station } from '../../../shared/types/station';

/**
 * 같은 호선 위에서 현재 역의 "다음 역"을 종착역 방향으로 한 칸 찾는다.
 *
 * 사용처: 열차 마커 애니메이션의 보간 목표점.
 * - 현재 역(`currentName`)과 종착역(`terminalName`)을 비교해 진행 방향을 결정
 * - 한 칸 앞 역을 반환 (없으면 null — 종착역에 도착했거나 매칭 실패)
 *
 * 호선 내 순서는 stations.json의 ID(`{line}-{seq}`) 순서에 의존한다.
 * 2호선 순환선은 종착역이 데이터에 명시되어 있으면 그 방향으로 처리되고,
 * "내선순환"/"외선순환" 같은 가상 종착역은 호출 전에 실제 역명으로 정규화되어야 한다(파서 책임).
 */
export function findNextStationOnLine(
  line: LineNumber,
  currentName: string,
  terminalName: string,
  allStations: readonly Station[],
): Station | null {
  const lineStations = allStations.filter((s) => s.line === line);
  if (lineStations.length === 0) return null;

  const currentIdx = lineStations.findIndex((s) => s.name === currentName);
  const terminalIdx = lineStations.findIndex((s) => s.name === terminalName);
  if (currentIdx === -1 || terminalIdx === -1) return null;
  if (currentIdx === terminalIdx) return null;

  const step = terminalIdx > currentIdx ? 1 : -1;
  const nextIdx = currentIdx + step;
  /* istanbul ignore next -- currentIdx/terminalIdx 모두 findIndex 성공 + 서로 다름이 보장돼
     step 방향으로 한 칸은 항상 호선 범위 내. boundary 가드는 방어용. */
  if (nextIdx < 0 || nextIdx >= lineStations.length) return null;
  return lineStations[nextIdx];
}
