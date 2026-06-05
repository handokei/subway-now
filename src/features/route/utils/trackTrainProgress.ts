import type { CandidateTrain } from '../../../shared/types/position';
import type { Station } from '../../../shared/types/station';
import { findStationByNameAndLine } from '../../../shared/utils/stationRoute';
import { haversine } from '../../../shared/utils/haversine';

export interface TrackTrainProgressInput {
  candidates: CandidateTrain[];
  userLocation?: { lat: number; lng: number } | null;
  lastConfirmedTrainNo?: string;
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
  const { candidates, userLocation, lastConfirmedTrainNo } = input;

  if (candidates.length === 0) return null;

  const resolved: ResolvedCandidate[] = [];
  for (const candidate of candidates) {
    const station = findStationByNameAndLine(candidate.currentStationName, candidate.line);
    if (station) resolved.push({ candidate, station });
  }

  if (resolved.length === 0) return null;
  if (resolved.length === 1) return toResult(resolved[0], 'single');

  // sticky 판정은 station 해석에 성공한 후보(resolved)에서만 수행.
  // lastConfirmedTrainNo가 station 해석 실패로 resolved에서 탈락한 경우 GPS fallthrough.
  if (lastConfirmedTrainNo) {
    const sticky = resolved.find((r) => r.candidate.trainNo === lastConfirmedTrainNo);
    if (sticky) return toResult(sticky, 'sticky');
  }

  if (userLocation) {
    const scored = resolved.map((r) => ({
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
