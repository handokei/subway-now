import type { CandidateTrain } from '../../../shared/types/position';
import type { Station } from '../../../shared/types/station';
import { findStationByNameAndLine } from '../../../shared/utils/stationRoute';
import { haversine } from '../../../shared/utils/haversine';

export interface TrackTrainProgressInput {
  candidates: CandidateTrain[];
  userLocation?: { lat: number; lng: number } | null;
  lastConfirmedTrainNo?: string;
  /**
   * #1017 forward-only 가드 — RC4 차단.
   * 탑승역부터 목적지까지의 순서 있는 역 목록(route arc).
   * 제공되면 currentStation이 탑승역 이전에 해당하는 candidate를 탈락시킨다.
   */
  segmentStations?: readonly Station[];
  /** #1017: segmentStations 내에서 탑승역 id — boardingIdx 계산에 사용. */
  boardingStationId?: string;
  /**
   * #1616 (R8a) — forward-only 가드가 backward candidate를 탈락시킨 경우 호출되는 측정 hook.
   * 호출자는 lockless 시 alarmLog `lockless-forward-only-block`로 적재해 1주 production
   * evidence를 모은다. fallback(전부 backward → resolved 그대로 사용)에 진입한 경우에는
   * 호출하지 않는다 — fallback은 실질적으로 가드 미적용이라 measurement 의미 X.
   */
  onFilteredBackward?: (info: { trainNo: string; stationName: string }) => void;
}

export interface TrainProgressResult {
  trainNo: string;
  currentStation: Station;
  trainStatus: number;
  confidence: 'single' | 'gps-disambiguated' | 'sticky';
}

interface ResolvedCandidate {
  candidate: CandidateTrain;
  station: Station;
}

function toResult(
  resolved: ResolvedCandidate,
  confidence: TrainProgressResult['confidence'],
): TrainProgressResult {
  return {
    trainNo: resolved.candidate.trainNo,
    currentStation: resolved.station,
    trainStatus: resolved.candidate.trainStatus,
    confidence,
  };
}

export function trackTrainProgress(
  input: TrackTrainProgressInput,
): TrainProgressResult | null {
  const {
    candidates,
    userLocation,
    lastConfirmedTrainNo,
    segmentStations,
    boardingStationId,
    onFilteredBackward,
  } = input;

  if (candidates.length === 0) return null;

  const resolved: ResolvedCandidate[] = [];
  for (const candidate of candidates) {
    const station = findStationByNameAndLine(candidate.currentStationName, candidate.line);
    if (station) resolved.push({ candidate, station });
  }

  if (resolved.length === 0) return null;

  // #1017 forward-only 가드 — backward jump RC4 차단.
  // segmentStations + boardingStationId가 제공되면 탑승역보다 앞에 있는 candidate를 탈락시킨다.
  // forward survivor가 없으면 원본 resolved 전체를 fallback으로 사용 — graceful degradation.
  const filtered = (() => {
    if (!segmentStations || segmentStations.length === 0 || !boardingStationId) return resolved;
    const boardingIdx = segmentStations.findIndex((s) => s.id === boardingStationId);
    if (boardingIdx === -1) return resolved;
    const rejected: ResolvedCandidate[] = [];
    const forward = resolved.filter((r) => {
      const idx = segmentStations.findIndex((s) => s.id === r.station.id);
      // arc 밖(idx === -1)은 탈락시키지 않는다 — 다른 가드(#662 노선 가드 등)가 처리.
      const keep = idx === -1 || idx >= boardingIdx;
      if (!keep) rejected.push(r);
      return keep;
    });
    if (forward.length > 0) {
      // #1616 (R8a) — 실제 가드가 적용된 (fallback X) 경우에만 onFilteredBackward 발사.
      // fallback은 실질적으로 가드 미적용이라 measurement 의미 없음.
      if (onFilteredBackward) {
        for (const r of rejected) {
          onFilteredBackward({
            trainNo: r.candidate.trainNo,
            stationName: r.station.name,
          });
        }
      }
      return forward;
    }
    return resolved;
  })();

  /* istanbul ignore next — graceful fallback(forward.length>0 ? forward : resolved)가
   * resolved 비공(非空)인 경우 filtered 공(空)을 만들지 않으므로 실제로는 도달 불능 */
  if (filtered.length === 0) return null;
  if (filtered.length === 1) return toResult(filtered[0], 'single');

  // sticky 판정은 forward-only 필터 통과 후보(filtered)에서만 수행.
  // lastConfirmedTrainNo가 station 해석 실패 또는 forward 필터 탈락으로 filtered에서
  // 빠진 경우 GPS fallthrough.
  if (lastConfirmedTrainNo) {
    const sticky = filtered.find((r) => r.candidate.trainNo === lastConfirmedTrainNo);
    if (sticky) return toResult(sticky, 'sticky');
  }

  if (userLocation) {
    const scored = filtered.map((r) => ({
      resolved: r,
      distance: haversine(
        userLocation.lat,
        userLocation.lng,
        r.station.lat,
        r.station.lng,
      ),
    }));
    const [first, ...rest] = scored;
    const nearest = rest.reduce((min, cur) => {
      if (cur.distance < min.distance) return cur;
      if (
        cur.distance === min.distance &&
        cur.resolved.candidate.trainNo.localeCompare(min.resolved.candidate.trainNo) < 0
      ) {
        return cur;
      }
      return min;
    }, first);
    return toResult(nearest.resolved, 'gps-disambiguated');
  }

  return null;
}
