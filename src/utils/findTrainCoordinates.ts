import type { LinePositions, TrainPosition } from '../api/positionApi';
import type { LineNumber, Station } from '../types/station';

/** 지도 마커로 표시할 열차 정보 — TrainPosition + 좌표 + lineColor. */
export interface TrainMarker {
  trainNo: string;
  line: LineNumber;
  lineColor: string;
  /** 매칭된 역의 좌표(역 위치에 마커 표시 — 열차가 그 역에 있다는 의미). */
  lat: number;
  lng: number;
  statnNm: string;
  /** trainSttus: 0:진입, 1:도착, 2:출발, 3:전역출발 */
  trainStatus: number;
  updnLine: number;
  terminalStationName: string;
}

/**
 * (line, name) → Station 빠른 조회 인덱스. stations 배열은 빌드 타임 고정이므로
 * 호출자가 한 번 만들어 캐시 후 findTrainCoordinates에 주입한다(매 폴링마다 528개 재빌드 방지).
 */
export type StationIndex = Map<LineNumber, Map<string, Station>>;

export function buildStationIndex(stations: Station[]): StationIndex {
  const indexByLine: StationIndex = new Map();
  for (const s of stations) {
    let lineIdx = indexByLine.get(s.line);
    if (!lineIdx) {
      lineIdx = new Map();
      indexByLine.set(s.line, lineIdx);
    }
    if (!lineIdx.has(s.name)) lineIdx.set(s.name, s);
  }
  return indexByLine;
}

/**
 * LinePositions의 각 train을 stations 좌표로 매핑한다.
 * 매칭 키: `(line, statnNm)` — Phase 3 Stage 1+2 fusion과 같은 정책.
 *
 * 매칭 실패(역명 미상)인 트레인은 제외 — 좌표 없이 마커를 그릴 수 없음.
 * stale(receivedAtMs<=0) 트레인도 제외 — fusion 정책 일관.
 */
export function findTrainCoordinates(
  positions: (LinePositions | null)[],
  index: StationIndex,
): TrainMarker[] {
  const out: TrainMarker[] = [];
  for (const lp of positions) {
    if (!lp || lp.isMock) continue;
    const lineIdx = index.get(lp.line);
    if (!lineIdx) continue;
    for (const t of lp.trains) {
      if (t.receivedAtMs <= 0) continue;
      const station = lineIdx.get(t.statnNm);
      if (!station) continue;
      out.push(toMarker(t, station));
    }
  }
  return out;
}

function toMarker(t: TrainPosition, s: Station): TrainMarker {
  return {
    trainNo: t.trainNo,
    line: s.line,
    lineColor: s.lineColor,
    lat: s.lat,
    lng: s.lng,
    statnNm: t.statnNm,
    trainStatus: t.trainStatus,
    updnLine: t.updnLine,
    terminalStationName: t.terminalStationName,
  };
}
