import AsyncStorage from '@react-native-async-storage/async-storage';
import { RECENT_LOCAL_STATION_FIRES_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';

// #2122 — FG 보조 발사(로컬 station-passed 알림) 직후, 뒤늦게 도착하는 backend alert push가
// 같은 (station, kind)를 표시하려 하면 foreground 표시 핸들러(stationNotification.ts
// setupNotificationHandler)가 이 기록을 참조해 중복 배너를 억제한다.
//
// collapse-id 문자열 일치(stationNotifCollapseId, 2a)가 1차 방어선이고, 본 store는 2차
// 방어선(2b) — iOS가 로컬↔원격 알림을 항상 동일 identifier로 교체한다는 보장이 없어(#2122
// PR 본문 "알려진 잔여 윈도우" 참고) 별도 문자열 기반 신호로 이중 방어한다.
//
// firedPushIds.ts(#574 P2e)와 동일한 write-queue 직렬화 패턴 — read-modify-write race로
// entry가 유실되면 본 게이트의 목적(중복 표시 차단) 자체가 깨지므로 add를 chain한다.

const logger = createLogger('RecentLocalStationFires');

/** backend alert push 실측 지연 35~51s(#2122) + 안전 마진. */
export const RECENT_LOCAL_STATION_FIRE_TTL_MS = 2 * 60 * 1000;

type FireMap = Record<string, number>;

function keyOf(stationName: string, kind: string): string {
  return `${kind}:${stationName}`;
}

async function read(): Promise<FireMap> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_LOCAL_STATION_FIRES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as FireMap;
  } catch {
    return {};
  }
}

function prune(map: FireMap, now: number): FireMap {
  const out: FireMap = {};
  for (const [key, ts] of Object.entries(map)) {
    if (typeof ts === 'number' && now - ts < RECENT_LOCAL_STATION_FIRE_TTL_MS) {
      out[key] = ts;
    }
  }
  return out;
}

let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task);
  writeQueue = next;
  return next;
}

export function markLocalStationFired(
  stationName: string,
  kind: string,
  now: number = Date.now(),
): Promise<void> {
  return enqueue(async () => {
    try {
      const current = await read();
      const pruned = prune(current, now);
      pruned[keyOf(stationName, kind)] = now;
      await AsyncStorage.setItem(RECENT_LOCAL_STATION_FIRES_KEY, JSON.stringify(pruned));
    } catch (e) {
      logger.warn('markLocalStationFired 실패 — FG 표시 중복억제 한 사이클 손실:', e);
    }
  });
}

export function hasRecentLocalStationFire(
  stationName: string,
  kind: string,
  now: number = Date.now(),
): Promise<boolean> {
  return enqueue(async () => {
    const current = await read();
    const ts = current[keyOf(stationName, kind)];
    if (typeof ts !== 'number') return false;
    return now - ts < RECENT_LOCAL_STATION_FIRE_TTL_MS;
  });
}
