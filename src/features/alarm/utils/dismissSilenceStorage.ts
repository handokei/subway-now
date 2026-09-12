import AsyncStorage from '@react-native-async-storage/async-storage';
import { DISMISS_SILENCE_KEY } from '../../../shared/constants/storageKeys';

/**
 * #746 — dismiss silence 상태. dismiss 시점의 timestamp와 좌표.
 * 좌표는 GPS 미가용 시 null — 이 경우 거리 조건은 평가 불가하고 시간 조건만 평가된다.
 */
export interface DismissSilenceState {
  sinceTs: number;
  sinceLat: number | null;
  sinceLng: number | null;
}

/**
 * FG/BG 어디서든 동일하게 read 가능한 storage SSOT. 호출자는 await 후
 * dismissSilenceGate(state, now, currentPosition)로 활성 여부를 판정한다.
 *
 * parse 실패/키 부재 시 null — 이전 dismiss 기록 없음(또는 만료/clear됨)을 의미.
 */
export async function getDismissSilence(): Promise<DismissSilenceState | null> {
  try {
    const raw = await AsyncStorage.getItem(DISMISS_SILENCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DismissSilenceState> | null;
    if (
      parsed &&
      typeof parsed.sinceTs === 'number' &&
      (parsed.sinceLat === null || typeof parsed.sinceLat === 'number') &&
      (parsed.sinceLng === null || typeof parsed.sinceLng === 'number')
    ) {
      return {
        sinceTs: parsed.sinceTs,
        sinceLat: parsed.sinceLat,
        sinceLng: parsed.sinceLng,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function setDismissSilence(state: DismissSilenceState): Promise<void> {
  try {
    await AsyncStorage.setItem(DISMISS_SILENCE_KEY, JSON.stringify(state));
  } catch {
    // storage 실패는 silent — silence 미지속이 더 작은 회귀 (다음 cycle에서 게이트 자연 통과).
  }
}

export async function clearDismissSilence(): Promise<void> {
  try {
    await AsyncStorage.removeItem(DISMISS_SILENCE_KEY);
  } catch {
    // storage 실패는 silent — stale entry는 다음 만료/clear 사이클에서 자연 정리.
  }
}
