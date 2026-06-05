import { Platform } from 'react-native';
import * as LiveActivity from 'live-activity';
import type { WidgetStoragePort } from '../../../features/widget/ports/WidgetStoragePort';

/**
 * SharedGroupAdapter — iOS App Groups(SharedGroupPreferences) 기반 WidgetStoragePort 구현.
 *
 * iOS 외 플랫폼에서는 모든 메서드가 no-op으로 동작한다 (위젯이 iOS 전용).
 * 실제 위젯 갱신은 native module `live-activity`의 `saveWidgetStation` /
 * `clearWidgetStation`이 SharedGroupPreferences에 기록 후 WidgetCenter.reloadAllTimelines를 호출한다.
 */
export class SharedGroupAdapter implements WidgetStoragePort {
  async saveStation(stationName: string, lineColor: string, distanceKm: number): Promise<void> {
    if (Platform.OS !== 'ios') return;
    await LiveActivity.saveWidgetStation(
      stationName,
      lineColor,
      Math.max(0, Math.round(distanceKm * 1000)),
    );
  }

  async clearStation(): Promise<void> {
    if (Platform.OS !== 'ios') return;
    await LiveActivity.clearWidgetStation();
  }
}
