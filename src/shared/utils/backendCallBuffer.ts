/**
 * Backend HTTP 호출 ring buffer (#1518).
 *
 * 디바이스 로그에 backend 호출 흔적이 0건이라 #622 transfer-leg sync 회귀 진단 시
 * device-측 호출 여부 / 응답 / latency를 사후 재구성할 수가 없었다. 모든 backend
 * fetch wrapper(`fetchWithTimeout`, `fetchWithTelemetryTimeout`, alarmBackend
 * 내부 헬퍼, tripStatus 내부 헬퍼)가 본 buffer에 entry를 push해 DebugModal share
 * dump로 한 번에 떨어뜨린다.
 *
 * 각 호출은 1쌍의 entry를 만든다:
 *   - call:     fetch 직전 (sentAtMs, url, method)
 *   - response: 응답 도착 (status, latencyMs)  OR  error: throw/timeout (message, latencyMs)
 *
 * corrId(상관식별자)는 활성 trip이 있으면 `TRIP_STARTED_AT_KEY` epoch ms 기반의 짧은
 * 문자열을 붙여 device entry ↔ backend wrangler tail 간 1:1 매칭이 가능하게 한다.
 * trip 없으면 corrId는 null — entry 자체는 그대로 남는다.
 *
 * Persistence: in-memory ring(capacity 100)을 push마다 AsyncStorage(`BACKEND_CALL_LOG_KEY`)에
 * mirror. 빈도 ≤ 5-10/min이라 본 mirror가 정상 흐름에 영향 없다. setItem은 fire-and-forget —
 * 실패해도 throw 하지 않는다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createDebugBuffer } from './createDebugBuffer';
import {
  BACKEND_CALL_LOG_KEY,
  TRIP_STARTED_AT_KEY,
} from '../constants/storageKeys';

/** Ring buffer capacity. 100건은 1 trip(보통 ~30-50건) 한 사이클을 충분히 덮는다. */
export const BACKEND_CALL_BUFFER_CAPACITY = 100;

export type BackendCallEntryKind = 'call' | 'response' | 'error';

export interface BackendCallEntry {
  kind: BackendCallEntryKind;
  /** epoch ms — call: 전송 시각, response/error: 완료 시각. */
  ts: number;
  /** call/response/error 1쌍을 묶는 식별자. push마다 새 string. */
  callId: string;
  /** 상관식별자 — 활성 trip의 TRIP_STARTED_AT_KEY 기반. trip 없으면 null. */
  corrId: string | null;
  /** 호출 대상 URL (query string 포함). 길이 제한 없음 — capacity가 자연 제한. */
  url: string;
  method: string;
  /** response 시 HTTP status. call/error에서는 미설정. */
  status?: number;
  /** response 시 fetch resolve까지 걸린 ms. error 시 throw/timeout까지 걸린 ms. call에서는 미설정. */
  latencyMs?: number;
  /** error 시 throw된 메시지. call/response에서는 미설정. */
  errorMessage?: string;
}

const db = createDebugBuffer<BackendCallEntry>(BACKEND_CALL_BUFFER_CAPACITY);

/**
 * 모듈 레벨 corrId 캐시. AsyncStorage read는 async라 fetch path를 직접 await로
 * 묶지 않기 위해 별도로 hydrate해 둔다. tripStart 변경 신호는 `refreshCorrId`로
 * 수동 호출 — trip 시작/종료 hook에서 사용.
 */
let cachedCorrId: string | null = null;

/** TRIP_STARTED_AT_KEY epoch ms → 짧은 base36 식별자. 동일 trip은 동일 corrId. */
function deriveCorrId(rawTripStart: string | null): string | null {
  if (!rawTripStart) return null;
  const parsed = Number(rawTripStart);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return `t${parsed.toString(36)}`;
}

/**
 * 활성 trip이 있으면 corrId를 hydrate한다. fire-and-forget — read 실패 시
 * 캐시는 그대로(stale corrId가 entry에 남아도 진단 가치는 유지된다).
 */
export async function refreshCorrId(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(TRIP_STARTED_AT_KEY);
    cachedCorrId = deriveCorrId(raw);
  } catch {
    // graceful — 마지막 캐시 유지.
  }
}

/** 직전 hydrate된 corrId. 한 번도 hydrate 안 했으면 null. */
export function getCurrentCorrId(): string | null {
  return cachedCorrId;
}

/** 테스트용 강제 set. production 코드에서 직접 호출 금지. */
export function __setCorrIdForTest(value: string | null): void {
  cachedCorrId = value;
}

/**
 * 새 callId 생성 — 한 fetch 호출의 call/response·error 1쌍을 묶는다.
 * Math.random + ts로 충돌 가능성을 무시할 수 있는 수준으로 떨어뜨린다.
 */
export function createCallId(): string {
  // base36 short id — 9자리 이내. 시간 prefix 없이 충돌만 피하면 충분.
  return Math.random().toString(36).slice(2, 11);
}

async function persist(): Promise<void> {
  try {
    const snapshot = db.get();
    await AsyncStorage.setItem(BACKEND_CALL_LOG_KEY, JSON.stringify(snapshot));
  } catch {
    // graceful — persistence 실패해도 in-memory ring은 살아있다.
  }
}

/** entry를 ring에 push + AsyncStorage mirror. fire-and-forget. */
export function pushBackendCallEntry(entry: BackendCallEntry): void {
  db.push(entry);
  void persist();
}

export function getBackendCallEntries(): readonly BackendCallEntry[] {
  return db.get();
}

export function clearBackendCallEntries(): void {
  db.clear();
  AsyncStorage.removeItem(BACKEND_CALL_LOG_KEY).catch(() => {
    // graceful — in-memory clear는 이미 수행됨.
  });
}

export function subscribeBackendCallEntries(listener: () => void): () => void {
  return db.subscribe(listener);
}

/**
 * 앱 boot 시 AsyncStorage의 직전 buffer를 in-memory ring으로 복원한다.
 * 직전 세션의 호출 흔적이 진단 도구에서 즉시 보이게 하는 게 목적.
 * 형식이 깨졌거나 read 실패 시 graceful skip (in-memory ring은 빈 상태로 시작).
 */
export async function hydrateBackendCallBuffer(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(BACKEND_CALL_LOG_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as BackendCallEntry).callId === 'string' &&
        typeof (entry as BackendCallEntry).ts === 'number' &&
        typeof (entry as BackendCallEntry).url === 'string' &&
        typeof (entry as BackendCallEntry).method === 'string'
      ) {
        db.push(entry as BackendCallEntry);
      }
    }
  } catch {
    // graceful — 깨진 JSON 등.
  }
}
