import { Platform } from 'react-native';
import * as LiveActivity from 'live-activity';
import { Station } from '../../../shared/types/station';

// 위젯 거리 표시는 50m 단위로 의미가 있다고 보고, 같은 역 + 같은 50m 버킷일 때만
// WidgetCenter.reloadAllTimelines 호출을 dedupe 한다. 같은 역이라도 버킷이
// 바뀌면(예: 500m → 450m) 위젯이 stale 상태로 남지 않도록 재전달한다.
const DISTANCE_BUCKET_M = 50;

// 같은 역+버킷에 머물러도 위젯의 savedAt이 stale로 표시되지 않도록 강제로 재전달하는
// 최소 간격. 위젯 측 stale 임계(10분)보다 작아야 의미가 있다.
const FRESHNESS_REFRESH_MS = 5 * 60 * 1000;

let lastDedupeKey: string | null = null;
let lastSavedAt: number | null = null;

function distanceBucket(distanceKm: number): number {
  const distanceM = Math.max(0, Math.round(distanceKm * 1000));
  return Math.floor(distanceM / DISTANCE_BUCKET_M);
}

export async function saveStationToWidget(
  station: Station,
  distanceKm: number,
  savedAt: number = Date.now(),
): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const key = `${station.id}:${distanceBucket(distanceKm)}`;
  const isSameKey = key === lastDedupeKey;
  const isFresh =
    lastSavedAt !== null && savedAt - lastSavedAt < FRESHNESS_REFRESH_MS;
  if (isSameKey && isFresh) return;
  lastDedupeKey = key;
  lastSavedAt = savedAt;
  await LiveActivity.saveWidgetStation(
    station.name,
    station.lineColor,
    Math.max(0, Math.round(distanceKm * 1000)),
    savedAt,
  );
}

export async function clearWidgetStation(): Promise<void> {
  lastDedupeKey = null;
  lastSavedAt = null;
  if (Platform.OS !== 'ios') return;
  await LiveActivity.clearWidgetStation();
}
