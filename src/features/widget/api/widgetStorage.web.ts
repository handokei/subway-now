import { Station } from '../../../shared/types/station';

/**
 * R9-a (#1612) — native 시그니처와 동일. web에서는 no-op.
 */
export interface SaveStationToWidgetOptions {
  force?: boolean;
}

// 웹 플랫폼에서는 iOS App Groups를 사용할 수 없으므로 no-op으로 처리
export async function saveStationToWidget(
  _station: Station,
  _distanceKm: number,
  _savedAt?: number,
  _options?: SaveStationToWidgetOptions,
): Promise<void> {
  return;
}

export async function clearWidgetStation(): Promise<void> {
  return;
}