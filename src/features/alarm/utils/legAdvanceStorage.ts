import AsyncStorage from '@react-native-async-storage/async-storage';
import { LEG_ADVANCE_KEY } from '../../../shared/constants/storageKeys';
import { isValidLineNumber } from '../../../shared/constants/lineApiNames';
import type { LineNumber } from '../../../shared/types/station';

/**
 * #2278 (PR #2287 리뷰 P1-2) — leg-advance stamp의 trip-scoped 영속화 상태.
 * `useLegAdvanceStore`가 이 storage와 in-memory state를 동기 유지한다.
 */
export interface LegAdvanceStorageState {
  nextLine: LineNumber;
  stampedAt: number;
}

/**
 * FG/BG/cold-start 어디서든 동일하게 read 가능한 storage SSOT.
 * parse 실패/키 부재/유효하지 않은 line 시 null — stamp 없음(또는 이미 clear됨)을 의미.
 */
export async function getLegAdvance(): Promise<LegAdvanceStorageState | null> {
  try {
    const raw = await AsyncStorage.getItem(LEG_ADVANCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LegAdvanceStorageState> | null;
    if (
      parsed &&
      isValidLineNumber(parsed.nextLine ?? null) &&
      typeof parsed.stampedAt === 'number'
    ) {
      return { nextLine: parsed.nextLine, stampedAt: parsed.stampedAt };
    }
    return null;
  } catch {
    return null;
  }
}

export async function setLegAdvance(state: LegAdvanceStorageState): Promise<void> {
  try {
    await AsyncStorage.setItem(LEG_ADVANCE_KEY, JSON.stringify(state));
  } catch {
    // storage 실패는 silent — in-memory stamp는 이미 반영됨. 다음 cold start는 hydrate 실패로
    // route/lock fallback만 적용(기존 우선순위) — 안전한 degrade.
  }
}

export async function clearLegAdvance(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LEG_ADVANCE_KEY);
  } catch {
    // storage 실패는 silent — stale entry는 다음 trip 종료 cleanup에서 재시도.
  }
}
