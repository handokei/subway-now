import { Platform } from 'react-native';
import * as LiveActivity from 'live-activity';
import { Station } from '../../../shared/types/station';

// 위젯 거리 표시는 50m 단위로 의미가 있다고 보고, 같은 역 + 같은 50m 버킷일 때만
// WidgetCenter.reloadAllTimelines 호출을 dedupe 한다. 같은 역이라도 버킷이
// 바뀌면(예: 500m → 450m) 위젯이 stale 상태로 남지 않도록 재전달한다.
const DISTANCE_BUCKET_M = 50;

let lastDedupeKey: string | null = null;

function distanceBucket(distanceKm: number): number {
  const distanceM = Math.max(0, Math.round(distanceKm * 1000));
  return Math.floor(distanceM / DISTANCE_BUCKET_M);
}

export async function saveStationToWidget(
  station: Station,
  distanceKm: number,
): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const key = `${station.id}:${distanceBucket(distanceKm)}`;
  if (key === lastDedupeKey) return;
  lastDedupeKey = key;
  await LiveActivity.saveWidgetStation(
    station.name,
    station.lineColor,
    Math.max(0, Math.round(distanceKm * 1000)),
  );
}

export async function clearWidgetStation(): Promise<void> {
  lastDedupeKey = null;
  if (Platform.OS !== 'ios') return;
  await LiveActivity.clearWidgetStation();
}
