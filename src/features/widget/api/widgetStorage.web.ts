import { Station } from '../../../shared/types/station';

// 웹 플랫폼에서는 iOS App Groups를 사용할 수 없으므로 no-op으로 처리
export async function saveStationToWidget(
  _station: Station,
  _distanceKm: number
): Promise<void> {
  return;
}

export async function clearWidgetStation(): Promise<void> {
  return;
}