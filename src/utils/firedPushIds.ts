import AsyncStorage from '@react-native-async-storage/async-storage';
import { FIRED_PUSH_IDS_KEY } from '../shared/constants/storageKeys';
import { createLogger } from './logger';

// #574 P2e — silent push fire/dedup 시점에 pushId를 기록하고, 동일 pushId의 alert push가
// 도달했을 때 중복 표시를 차단한다. silent → ACK → 백엔드 KV 정리 사이의 race(~1s)에서
// backend cron이 alert를 fallback 발사하는 경우를 대비.
//
// 한계: FG에서만 동작 (notification handler에서 suppress). BG는 iOS가 alert를 직접 표시해
// JS 개입 불가 — P2e 의도된 trade-off.
//
// 형식: `{ "<pushId>": ts (epoch ms) }`. TTL FIRED_PUSH_ID_TTL_MS 초과 항목은 add 호출 시 cleanup.
// AsyncStorage 실패는 dedup 효과만 잃을 뿐 silent push 본 처리에 무관 — caller는 fire-and-forget 호출.
//
// **동시성**: addFiredPushId 호출이 짧은 간격으로 두 번 발생하면 read-modify-write race로 entry가
// 손실될 수 있다(두 호출이 같은 read 결과에 각자 항목을 더해 마지막 write가 이김). 이는 P2e 본 목적
// (alert 중복 차단)을 직접 깨므로 모듈 내부 직렬화 큐로 write를 chain한다. has는 큐 끝에서 읽어
// 가장 최신 상태를 본다.

const logger = createLogger('FiredPushIds');

/** 5분 — 30s 임계 + cron 1분 + 네트워크 지연 모두 커버하는 안전 마진. */
export const FIRED_PUSH_ID_TTL_MS = 5 * 60 * 1000;

type FiredMap = Record<string, number>;

async function read(): Promise<FiredMap> {
  try {
    const raw = await AsyncStorage.getItem(FIRED_PUSH_IDS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as FiredMap;
  } catch {
    return {};
  }
}

function prune(map: FiredMap, now: number): FiredMap {
  const out: FiredMap = {};
  for (const [id, ts] of Object.entries(map)) {
    if (typeof ts === 'number' && now - ts < FIRED_PUSH_ID_TTL_MS) {
      out[id] = ts;
    }
  }
  return out;
}

// 모듈 스코프 write 큐. add/has를 chain해 동시 진입 race를 차단한다.
// add/has 내부 task는 모두 자체 try/catch로 swallow하므로 큐는 항상 fulfilled로 진행한다.
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task);
  writeQueue = next;
  return next;
}

export function addFiredPushId(pushId: string, now: number = Date.now()): Promise<void> {
  return enqueue(async () => {
    try {
      const current = await read();
      const pruned = prune(current, now);
      pruned[pushId] = now;
      await AsyncStorage.setItem(FIRED_PUSH_IDS_KEY, JSON.stringify(pruned));
    } catch (e) {
      logger.warn('addFiredPushId 실패 — dedup 한 사이클 손실:', e);
    }
  });
}

export function hasFiredPushId(
  pushId: string,
  now: number = Date.now(),
): Promise<boolean> {
  return enqueue(async () => {
    const current = await read();
    const ts = current[pushId];
    if (typeof ts !== 'number') return false;
    return now - ts < FIRED_PUSH_ID_TTL_MS;
  });
}

/**
 * #799: trip 종료/전환 시 호출. trip-bound dedup state라 다음 trip으로 이월하면
 * 이전 trip의 pushId가 false-positive로 잡혀 새 alert가 silent 처리되는 회귀 가능.
 * write queue를 통해 호출해 add/has와의 순서 일관성 보존.
 */
export function clearFiredPushIds(): Promise<void> {
  return enqueue(async () => {
    try {
      await AsyncStorage.removeItem(FIRED_PUSH_IDS_KEY);
    } catch (e) {
      logger.warn('clearFiredPushIds 실패:', e);
    }
  });
}
