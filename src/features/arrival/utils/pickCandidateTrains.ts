import type { LinePositions, TrainPosition } from '../../../shared/types/position';
import type { LineNumber, Station } from '../../../shared/types/station';
import { getStationsOnLine } from '../../../shared/utils/stationRoute';
import { hopsOnLine } from '../../../shared/utils/lineLoopPath';
import { haversine } from '../../../shared/utils/haversine';

// CandidateTrain은 shared/types/position으로 추출됨 (#890, Phase 5). re-export 유지.
import type { CandidateTrain } from '../../../shared/types/position';
export type { CandidateTrain };

export interface PickCandidateTrainsInput {
  positions: LinePositions[];
  line: LineNumber;
  direction?: 0 | 1;
  anchorStationName?: string;
  windowStations?: number;
  /**
   * #1616 (R12-a) — candidate별 GPS 거리 hard gate.
   * 사용자 마지막 known location + 노선 정렬 station 좌표 lookup이 모두 주어지면
   * 각 candidate train의 currentStation 좌표와 사용자 위치 거리가
   * CANDIDATE_DISTANCE_THRESHOLD_KM를 초과할 때 후보에서 reject.
   *
   * userLocation/stationCoordinates 둘 중 하나라도 미전달 시 거리 가드 미적용 (graceful fallback,
   * 기존 anchorIdx ± window 동작 유지).
   *
   * 배경: anchorIdx ± window=3 index 거리만으로는 anchor(=GPS-nearest) 자체가 GPS drift된
   * 케이스(2026-06-19 trip evidence: anchor=이수, 실제=학동)에서 인접 3개 station(예: 이수↔
   * 강남구청 → 7호선 동일 노선이지만 GPS 거리 5km+) 잘못된 영역 train이 후보 진입.
   * candidate-station GPS 거리로 cross-check해 misfire 차단.
   *
   * threshold 3.0km — 호선 평균 station 간 거리 ~1.5km × 2 (보수치).
   */
  userLocation?: { lat: number; lng: number } | null;
  stationCoordinates?: ReadonlyMap<string, { lat: number; lng: number }>;
  /**
   * #1616 (R12-a) — 거리 가드로 reject된 candidate를 호출자가 fusionDebugBuffer에 적재할 때
   * 사용하는 측정 hook. 미전달 시 reject는 silent — 본 helper는 측정 정책에 비의존.
   */
  onCandidateDistanceReject?: (info: {
    trainNo: string;
    line: LineNumber;
    stationName: string;
    distanceKm: number;
  }) => void;
}

const DEFAULT_WINDOW_STATIONS = 3;

/**
 * #1616 (R12-a) — candidate별 GPS 거리 hard gate threshold.
 * 호선 평균 station 간 거리(~1.5km) × 2 = 3.0km. 보수적: 정상 trip에서 false reject 최소화.
 */
export const CANDIDATE_DISTANCE_THRESHOLD_KM = 3.0;

function buildCandidate(
  train: TrainPosition,
  line: LineNumber,
  direction: 0 | 1,
): CandidateTrain {
  return {
    trainNo: train.trainNo,
    line,
    direction,
    currentStationName: train.statnNm,
    trainStatus: train.trainStatus,
    receivedAtMs: train.receivedAtMs,
  };
}

export function pickCandidateTrains(input: PickCandidateTrainsInput): CandidateTrain[] {
  const {
    positions,
    line,
    direction,
    anchorStationName,
    windowStations,
    userLocation,
    stationCoordinates,
    onCandidateDistanceReject,
  } = input;

  const linePositions = positions.find((p) => p.line === line);
  if (!linePositions) return [];

  const stationsOnLine = getStationsOnLine(line);
  const nameToIndex = new Map<string, number>();
  stationsOnLine.forEach((s, i) => nameToIndex.set(s.name, i));

  const window = Math.max(0, windowStations ?? DEFAULT_WINDOW_STATIONS);
  const anchorIdx =
    anchorStationName !== undefined ? nameToIndex.get(anchorStationName) : undefined;
  // #1616 (R12-a): userLocation + stationCoordinates 둘 다 있어야 거리 가드 활성.
  // 어느 한쪽이라도 빠지면 기존 동작 유지 (graceful fallback).
  const distanceGateActive = userLocation != null && stationCoordinates != null;

  const candidates: Array<{ candidate: CandidateTrain; sortKey: number }> = [];

  for (const train of linePositions.trains) {
    if (train.receivedAtMs <= 0) continue;
    // positionApi가 파싱 실패 시 updnLine=-1을 sentinel로 내보낸다. 방향 모름은 후보에서 제외.
    if (train.updnLine !== 0 && train.updnLine !== 1) continue;
    if (direction !== undefined && train.updnLine !== direction) continue;

    const stationIdx = nameToIndex.get(train.statnNm);
    if (stationIdx === undefined) continue;

    // #1722 — 2호선 본선 wraparound 고려. 직선 `Math.abs`는 wraparound 가까운 train을
    // 멀리 인식해 window 누락 → anchor 부근 train 후보 손실.
    const hopsFromAnchor =
      anchorIdx !== undefined ? hopsOnLine(stationsOnLine, anchorIdx, stationIdx, line) : 0;
    if (anchorIdx !== undefined && hopsFromAnchor > window) continue;

    // #1616 (R12-a): candidate station GPS 좌표 hard gate.
    if (distanceGateActive) {
      const stationCoord = stationCoordinates.get(train.statnNm);
      // 좌표 lookup miss는 graceful pass — caller가 line별 stations.json subset만 줄 수 있음.
      if (stationCoord !== undefined) {
        const distanceKm = haversine(
          userLocation.lat,
          userLocation.lng,
          stationCoord.lat,
          stationCoord.lng,
        );
        if (distanceKm > CANDIDATE_DISTANCE_THRESHOLD_KM) {
          onCandidateDistanceReject?.({
            trainNo: train.trainNo,
            line,
            stationName: train.statnNm,
            distanceKm,
          });
          continue;
        }
      }
    }

    candidates.push({ candidate: buildCandidate(train, line, train.updnLine), sortKey: hopsFromAnchor });
  }

  candidates.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    return a.candidate.trainNo.localeCompare(b.candidate.trainNo);
  });

  return candidates.map((c) => c.candidate);
}
