/**
 * Trip correlation id (#1501, ADR-015 §10 P5 / PR-A).
 *
 * 매 trip에 unique id를 부여해 rawSignalBuffer entry / backend evidence가 어떤 trip
 * 소속인지 사후 재구성한다. trip 시작 시 `setTripCorrId(generateTripCorrId())` 호출,
 * tripBoundCleanups에서 `clearTripCorrId()`로 제거.
 *
 * 형식: `${epoch ms}-${8 hex}`. timestamp 자체로 정렬 가능 + random suffix로 collision 차단
 * (밀리초 안에 동시 trip 생성 race 방지).
 *
 * 모든 storage 작업은 graceful — 실패 시 측정만 영향, trip 흐름 무관.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TRIP_CORR_ID_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('tripCorrId');

/** 내부 factory — test에서 fixed seed 주입 가능하게 추출. */
export interface CorrIdDeps {
  now: () => number;
  random: () => number;
}

const defaultDeps: CorrIdDeps = {
  now: () => Date.now(),
  random: () => Math.random(),
};

function hex8(rand: () => number): string {
  // 8 hex chars = 32 bit. Math.random은 unbiased 가정.
  const n = Math.floor(rand() * 0x1_0000_0000);
  return n.toString(16).padStart(8, '0');
}

/** `${epoch ms}-${8 hex}` 형식 corrId 생성. test에서 deps 주입 가능. */
export function generateTripCorrId(deps: CorrIdDeps = defaultDeps): string {
  return `${deps.now()}-${hex8(deps.random)}`;
}

// In-memory cache — fusion cycle hot path에서 sync read를 보장한다 (async useEffect로
// state 갱신 시 React 19 act() race가 발생). set/clear/hydrate가 cache를 항상 동기 갱신.
let cachedCorrId: string | null = null;

/** corrId를 AsyncStorage에 저장 + in-memory cache 동기 갱신. trip 시작 시 호출. */
export async function setTripCorrId(id: string): Promise<void> {
  cachedCorrId = id;
  try {
    await AsyncStorage.setItem(TRIP_CORR_ID_KEY, id);
  } catch (e) {
    // graceful — 측정만 영향, trip 흐름 무관.
    logger.warn('storage 실패(graceful):', e);
  }
}

/** 현재 corrId 또는 null. 키 부재 = trip 미시작/종료. async — boot/hydrate 경로용. */
export async function getCurrentTripCorrId(): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(TRIP_CORR_ID_KEY);
    cachedCorrId = stored;
    return stored;
  } catch (e) {
    logger.warn('hydrate 실패(graceful, cache fallback):', e);
    return cachedCorrId;
  }
}

/** sync read — fusion cycle hot path 전용. boot 시 hydrate 후 정상 값. */
export function getCurrentTripCorrIdSync(): string | null {
  return cachedCorrId;
}

/** corrId 제거 + cache 동기 갱신. tripBoundCleanups에서 호출. */
export async function clearTripCorrId(): Promise<void> {
  cachedCorrId = null;
  try {
    await AsyncStorage.removeItem(TRIP_CORR_ID_KEY);
  } catch (e) {
    // graceful — 다음 cleanup에서 재시도.
    logger.warn('clear 실패(graceful):', e);
  }
}

/** 테스트 전용 — cache 초기화. */
export function __resetTripCorrIdForTests__(): void {
  cachedCorrId = null;
}
