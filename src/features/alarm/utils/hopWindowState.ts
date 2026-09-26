import AsyncStorage from '@react-native-async-storage/async-storage';
import { BG_HOP_WINDOW_STATION_KEY } from '../../../shared/constants/storageKeys';
import type { Station } from '../../../shared/types/station';

/**
 * #2373 — BG 채널(stationPipeline.processLocationUpdate) hop-window 게이트의 직전 tick 기준점.
 *
 * FG(useStationAlarm)는 D1 estimator의 currentHopIndex(또는 firedAlarms 기반 fallback)를 SSOT로
 * 쓰지만, BG는 매 tick 독립 호출되는 stateless 함수라 그 컨텍스트가 없다. 대신 직전 tick에 게이트를
 * 통과한 nearestStation을 여기 영속화해 다음 tick의 hop 기준으로 삼는다.
 *
 * destinationId로 scoping — read 시점 destinationId가 저장된 값과 다르면 stale로 간주하고
 * null을 반환한다. 새 destination(=새 trip) 시작 시 자동 무효화되므로 명시적 reset 호출이
 * 필요 없다 (notificationState.ts의 LAST_NOTIFIED_STATION_KEY와 동일 패턴).
 */
interface BgHopWindowRecord {
  destinationId: string;
  station: Station;
}

function isStation(value: unknown): value is Station {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Station).id === 'string' &&
    typeof (value as Station).line === 'string'
  );
}

function isBgHopWindowRecord(value: unknown): value is BgHopWindowRecord {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as BgHopWindowRecord).destinationId === 'string' &&
    isStation((value as BgHopWindowRecord).station)
  );
}

/**
 * destinationId가 저장된 record와 일치할 때만 직전 tick 기준 station을 반환.
 * 부재/파싱 실패/다른 trip이면 null — 호출자는 이번 tick을 "기준 없음"으로 graceful 처리한다.
 */
export async function getBgHopWindowStation(destinationId: string): Promise<Station | null> {
  try {
    const raw = await AsyncStorage.getItem(BG_HOP_WINDOW_STATION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isBgHopWindowRecord(parsed)) return null;
    if (parsed.destinationId !== destinationId) return null;
    return parsed.station;
  } catch {
    return null;
  }
}

export async function setBgHopWindowStation(
  destinationId: string,
  station: Station,
): Promise<void> {
  const record: BgHopWindowRecord = { destinationId, station };
  try {
    await AsyncStorage.setItem(BG_HOP_WINDOW_STATION_KEY, JSON.stringify(record));
  } catch {
    // storage 실패는 silent — 다음 tick이 "기준 없음"으로 graceful skip.
  }
}
