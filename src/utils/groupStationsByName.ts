import type { Station, LineNumber } from '../types/station';
import { LINE_COLORS } from '../constants/lineColors';

export interface StationGroup {
  key: string;
  representativeName: string;
  lat: number;
  lng: number;
  stations: Station[];
}

// 후행 괄호 부제 제거 ("상봉(시외버스터미널)" → "상봉").
// #401과 동일 로직. #401 머지 후 stationRoute.normalizeStationName으로 교체 가능.
// regex 대신 string 연산 — Sonar S5852 (super-linear backtracking 회피).
function normalize(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.endsWith(')')) return trimmed;
  const open = trimmed.lastIndexOf('(');
  if (open === -1) return trimmed;
  return trimmed.slice(0, open).trimEnd();
}

const LINE_ORDER: Record<LineNumber, number> = Object.keys(LINE_COLORS).reduce(
  (acc, key, idx) => {
    acc[key as LineNumber] = idx;
    return acc;
  },
  {} as Record<LineNumber, number>,
);

export function groupStationsByName(stations: Station[]): StationGroup[] {
  const buckets = new Map<string, Station[]>();
  for (const s of stations) {
    const key = normalize(s.name);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(s);
  }

  const groups: StationGroup[] = [];
  for (const [key, members] of buckets) {
    const sorted = [...members].sort((a, b) => LINE_ORDER[a.line] - LINE_ORDER[b.line]);
    const representativeName = sorted.reduce((shortest, s) =>
      s.name.length < shortest.length ? s.name : shortest,
    sorted[0].name);
    const latSum = sorted.reduce((sum, s) => sum + s.lat, 0);
    const lngSum = sorted.reduce((sum, s) => sum + s.lng, 0);
    groups.push({
      key,
      representativeName,
      lat: latSum / sorted.length,
      lng: lngSum / sorted.length,
      stations: sorted,
    });
  }
  return groups;
}
