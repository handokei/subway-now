import AsyncStorage from '@react-native-async-storage/async-storage';
import { BG_LAST_FIX_KEY } from '../../../shared/constants/storageKeys';
import type { FixSample } from './locationGates';

/**
 * BG task가 마지막으로 수용한 fix 레코드(BG_LAST_FIX_KEY).
 *
 * lat/lng/timestamp는 #527 jump gate 입력(FixSample)이다. #3191 PR-0에서 acc/speed를 관측용으로
 * 함께 남긴다 — 어떤 판정도 acc/speed를 읽지 않는다(DebugModal 표시 전용).
 * 구 레코드(acc/speed 없음)는 null로 정규화한다.
 */
export interface BgLastFix extends FixSample {
  acc: number | null;
  speed: number | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export async function readBgLastFix(): Promise<BgLastFix | null> {
  try {
    const raw = await AsyncStorage.getItem(BG_LAST_FIX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Record<keyof BgLastFix, unknown>> | null;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.lat === 'number' &&
      typeof parsed.lng === 'number' &&
      typeof parsed.timestamp === 'number'
    ) {
      return {
        lat: parsed.lat,
        lng: parsed.lng,
        timestamp: parsed.timestamp,
        acc: numberOrNull(parsed.acc),
        speed: numberOrNull(parsed.speed),
      };
    }
    return null;
  } catch {
    return null;
  }
}
