import { Platform } from 'react-native';
import * as LiveActivity from 'live-activity';
import { Station } from '../types/station';

// 동일 역 머무는 동안 매 GPS 폴링마다 WidgetCenter.reloadAllTimelines 가
// 호출되는 낭비를 막기 위한 station.id 기준 dedupe.
let lastStationId: string | null = null;

export async function saveStationToWidget(
  station: Station,
  distanceKm: number,
): Promise<void> {
  if (Platform.OS !== 'ios') return;
  if (station.id === lastStationId) return;
  lastStationId = station.id;
  await LiveActivity.saveWidgetStation(
    station.name,
    station.lineColor,
    Math.max(0, Math.round(distanceKm * 1000)),
  );
}

export async function clearWidgetStation(): Promise<void> {
  lastStationId = null;
  if (Platform.OS !== 'ios') return;
  await LiveActivity.clearWidgetStation();
}
