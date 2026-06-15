/**
 * #876 — Sticky Station 훅.
 *
 * 목적: trip 없는 상태(탑승 전 / 환승 대기 / 단순 위치 확인)에서 백엔드 정답이 없어
 *   클라이언트가 GPS-only로 회귀할 때, 지상에서 잠깐 잡힌 좋은 fix를 lock해
 *   지하 dead-zone의 부정확한 fix(50~100m)가 250m 표시 게이트를 통과해도
 *   엉뚱한 역으로 흔들리지 않게 한다.
 *
 * 입력: 매 GPS fix마다 캐스트되는 `{ candidate, accuracyMeters, speedMps }` + 선택적 motion.
 * 출력: `{ locked: Station | null }` — sticky lock된 역 (없으면 null).
 *
 * 알람 트리거에는 영향 없음 — sticky는 표시에만 영향. 알람은 별도 엄격 게이트(200m) 통과 fix만 사용.
 *
 * Lock 조건: 좋은 fix(accuracy ≤ 50m, speed < 1 m/s)가 같은 역 STICKY_LOCK_CONSECUTIVE_COUNT(3)회 연속.
 *
 * Unlock 트리거:
 *   1. distance — 좋은 fix가 lock된 역에서 STICKY_UNLOCK_DISTANCE_KM(1km) 초과
 *   2. motion — automotive(차/지하철 이동 확정)
 *   3. ttl — STICKY_TTL_MS(30분) 경과
 *   4. better-fix — 좋은 fix가 다른 역에서 N회 연속 관찰 → 즉시 갱신(unlock + 새 lock)
 *   5. moved-away (#1317) — 저품질 fix(≤250m)여도 lock된 역에서 1km+ 떨어진 다른 역이
 *      STICKY_DEGRADED_UNLOCK_COUNT(3)회 연속 관찰되면 unlock. 좋은 fix가 안 잡히는 지하·도심
 *      협곡에서 출발역 lock이 고착되는 회귀 차단. 단발성 부정확 fix는 카운트가 리셋돼 안 풀린다.
 *
 * 명시적 unlock: 사용자가 지도탭 "현재위치"를 탭하면 releaseLock()으로 sticky를 비우고 live 위치를
 * 노출한다(호출자 useNearestStation의 requestCurrentLocation 경로).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NearestStationResult, Station } from '../../../shared/types/station';
import { STICKY_STATION_KEY } from '../../../shared/constants/storageKeys';
import {
  STICKY_DEGRADED_UNLOCK_COUNT,
  STICKY_LOCK_CONSECUTIVE_COUNT,
} from '../../../shared/constants/stickyStation';
import {
  isGoodFix,
  shouldCountAsMovedAway,
  shouldUnlockByDistance,
  shouldUnlockByMotion,
  shouldUnlockByTtl,
} from '../utils/stickyStationGates';
import {
  pushFusionDebugEntry,
  type StickyStationEvent,
} from '../utils/fusionDebugBuffer';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('useStickyStation');

export interface StickyFixInput {
  candidate: NearestStationResult | null;
  accuracyMeters: number | null;
  speedMps: number | null;
}

export interface StickyMotionInput {
  /** automotive=true면 차/지하철 이동 확정으로 간주 — unlock 트리거. */
  automotive?: boolean;
  /**
   * D6 (#1212) — 기압계가 지하 진입을 시사하는지. 지하 + trip 활성 시 automotive 신호는
   * 지하철 탑승의 정상 신호로 간주하여 sticky를 풀지 않는다. distance 게이트도 같은 조합에서 보류.
   */
  subsurface?: boolean;
  /**
   * D6 (#1212) — trip(목적지/경로) 활성 여부. 지하 dead-zone GPS로 sticky가 잘못 풀려
   * "탑승 중 노선 정보 사라짐" 회귀가 발생하던 케이스 차단.
   */
  tripActive?: boolean;
}

export interface UseStickyStationReturn {
  locked: Station | null;
  /**
   * #1317 — sticky lock을 즉시 비운다. 지도탭 "현재위치" 명시 탭처럼 사용자가 live 위치를
   * 명시적으로 요청할 때 호출한다. lock이 없으면 no-op.
   */
  releaseLock: () => void;
}

interface PersistedLock {
  station: Station;
  lockedAt: number;
}

function isPersistedLock(value: unknown): value is PersistedLock {
  if (!value || typeof value !== 'object') return false;
  const v = value as { station?: unknown; lockedAt?: unknown };
  if (typeof v.lockedAt !== 'number') return false;
  if (!v.station || typeof v.station !== 'object') return false;
  const s = v.station as { id?: unknown; name?: unknown; lat?: unknown; lng?: unknown };
  return typeof s.id === 'string'
    && typeof s.name === 'string'
    && typeof s.lat === 'number'
    && typeof s.lng === 'number';
}

async function readPersistedLock(): Promise<PersistedLock | null> {
  try {
    const raw = await AsyncStorage.getItem(STICKY_STATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isPersistedLock(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writePersistedLock(lock: PersistedLock): Promise<void> {
  try {
    await AsyncStorage.setItem(STICKY_STATION_KEY, JSON.stringify(lock));
  } catch {
    // storage 실패는 silent — 다음 lock 사이클에서 자연 복구.
  }
}

async function clearPersistedLock(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STICKY_STATION_KEY);
  } catch {
    // graceful — stale entry는 다음 unlock/TTL에서 자연 정리.
  }
}

function emitMetric(
  event: StickyStationEvent,
  station: Station,
  fix: { accuracyMeters: number | null; speedMps: number | null },
): void {
  pushFusionDebugEntry({
    kind: 'sticky',
    event,
    ts: Date.now(),
    stationName: station.name,
    line: station.line,
    accuracyMeters: fix.accuracyMeters,
    speedMps: fix.speedMps,
  });
}

export function useStickyStation(
  fix: StickyFixInput,
  motion: StickyMotionInput = {},
): UseStickyStationReturn {
  const [locked, setLocked] = useState<Station | null>(null);
  const lockedAtRef = useRef<number | null>(null);
  // 같은 역 연속 좋은 fix 카운터. 다른 역으로 바뀌거나 나쁜 fix면 리셋.
  const candidateIdRef = useRef<string | null>(null);
  const candidateCountRef = useRef<number>(0);
  // #1317 — lock된 역에서 1km+ 떨어진 다른 역 fix(저품질 허용)의 연속 관찰 카운터.
  // shouldCountAsMovedAway가 false면 리셋 — 단발성 부정확 fix로는 풀리지 않는다.
  const movedAwayCountRef = useRef<number>(0);
  // #1317 — releaseLock은 render 밖(UI 이벤트)에서 호출될 수 있어 stale closure를 피하려고
  // locked state와 마지막 fix meta를 ref로 미러링한다(metric 라벨링용).
  const lockedRef = useRef<Station | null>(null);
  const lastFixMetaRef = useRef<{ accuracyMeters: number | null; speedMps: number | null }>({
    accuracyMeters: null,
    speedMps: null,
  });
  // hydrate 완료 여부를 state로 — 완료 후 다음 렌더에 평가 effect가 자동 재실행돼
  // hydrate 직전에 받아둔 첫 fix가 정상적으로 카운트된다.
  const [hydrated, setHydrated] = useState<boolean>(false);

  // lock 상태를 비우는 공통 cleanup — ref/state/persistence를 함께 정리한다.
  // performUnlock(per-fix metric 포함)과 releaseLock(명시 unlock) 양쪽이 재사용.
  const clearLockState = useCallback(() => {
    lockedAtRef.current = null;
    candidateIdRef.current = null;
    candidateCountRef.current = 0;
    movedAwayCountRef.current = 0;
    setLocked(null);
    void clearPersistedLock();
  }, []);

  // #1317 — 명시적 unlock. 지도탭 "현재위치" 탭처럼 사용자가 live 위치를 직접 요청할 때 호출.
  // 평가 effect 밖에서 즉시 lock을 비워 다음 fix가 live 후보를 그대로 노출하게 한다.
  const releaseLock = useCallback(() => {
    if (lockedRef.current == null) return;
    emitMetric('unlocked-manual', lockedRef.current, lastFixMetaRef.current);
    clearLockState();
  }, [clearLockState]);

  // Hydrate from AsyncStorage on mount. TTL 만료된 lock은 무시.
  useEffect(() => {
    let cancelled = false;
    void readPersistedLock().then((persisted) => {
      if (cancelled) return;
      if (persisted && !shouldUnlockByTtl(persisted.lockedAt, Date.now())) {
        lockedAtRef.current = persisted.lockedAt;
        setLocked(persisted.station);
      } else if (persisted) {
        void clearPersistedLock();
      }
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // releaseLock이 stale closure 없이 최신 lock/fix를 읽도록 ref를 동기화한다.
  lockedRef.current = locked;

  // 매 fix마다 lock/unlock 평가. hydrate 완료 전엔 평가 보류 (race 방지).
  useEffect(() => {
    if (!hydrated) return;
    const { candidate, accuracyMeters, speedMps } = fix;
    const fixMeta = { accuracyMeters, speedMps };
    lastFixMetaRef.current = fixMeta;
    const now = Date.now();

    // unlock 공통 cleanup. metrics 이벤트별 라벨링 + clearLockState(ref/state/persistence 정리).
    const performUnlock = (event: StickyStationEvent, lockedStation: Station): void => {
      emitMetric(event, lockedStation, fixMeta);
      clearLockState();
    };

    // 1. lock 상태에서 unlock 트리거 평가(better-fix는 카운터 평가 단계에서 처리).
    //    우선순위: motion > ttl > distance > moved-away — 각각 stale lock 위험이 큰 순서.
    if (locked && lockedAtRef.current != null) {
      if (shouldUnlockByMotion(motion)) {
        performUnlock('unlocked-motion', locked);
        return;
      }
      if (shouldUnlockByTtl(lockedAtRef.current, now)) {
        performUnlock('unlocked-ttl', locked);
        return;
      }
      if (
        candidate
        && accuracyMeters != null
        && shouldUnlockByDistance(locked, {
          lat: candidate.station.lat,
          lng: candidate.station.lng,
          accuracyMeters,
          subsurface: motion.subsurface,
          tripActive: motion.tripActive,
        })
      ) {
        // distance unlock은 즉시 — 새 후보 카운트는 다음 fix부터 시작. better-fix 갱신을 같은 effect에서
        // 강제하지 않는다(distance unlock 트리거 한 fix는 카운트에 반영하지 않음).
        performUnlock('unlocked-distance', locked);
        return;
      }
      // #1317 — 저품질 GPS 내성 moved-away unlock. strict distance가 ≤50m를 요구해 막히는
      // 지하·도심 협곡에서, 1km+ 떨어진 다른 역 fix(≤250m)가 연속 누적되면 unlock한다.
      // 단발성 부정확 fix는 카운트가 리셋돼 풀리지 않는다(false unlock 방지).
      const movedAway = candidate != null && shouldCountAsMovedAway(locked, {
        lat: candidate.station.lat,
        lng: candidate.station.lng,
        accuracyMeters,
        candidateId: candidate.station.id,
        subsurface: motion.subsurface,
        tripActive: motion.tripActive,
      });
      if (movedAway) {
        movedAwayCountRef.current += 1;
        if (movedAwayCountRef.current >= STICKY_DEGRADED_UNLOCK_COUNT) {
          performUnlock('unlocked-moved-away', locked);
          return;
        }
      } else {
        movedAwayCountRef.current = 0;
      }
    }

    // 2. 좋은 fix 카운터 평가 (lock 갱신/생성)
    if (!candidate || !isGoodFix(fixMeta)) {
      // 나쁜 fix면 진행 중 카운트 리셋 — 같은 역이라도 신호 단절 시 처음부터 다시 관찰.
      candidateIdRef.current = null;
      candidateCountRef.current = 0;
      return;
    }
    const candidateId = candidate.station.id;
    if (candidateIdRef.current === candidateId) {
      candidateCountRef.current += 1;
    } else {
      candidateIdRef.current = candidateId;
      candidateCountRef.current = 1;
    }

    if (candidateCountRef.current < STICKY_LOCK_CONSECUTIVE_COUNT) return;

    // Same-lock guard (#1345): 같은 station 재lock은 no-op.
    // useNearestStation:449-462 inline object literal로 fix/motion ref가 매 렌더 새로 생성돼
    // effect가 매번 실행되고, locked 상태에서 같은 candidate가 N회 도달할 때마다
    // emit/write/setLocked cascade가 발생(9시간 ~16만회). lockedAtRef는 TTL renewal 의도로
    // silent 갱신하고 카운터만 리셋해 cascade는 차단한다.
    if (locked && locked.id === candidate.station.id) {
      lockedAtRef.current = now;
      candidateCountRef.current = 0;
      movedAwayCountRef.current = 0;
      return;
    }

    // N회 연속 좋은 fix 도달. lock 신규 생성 또는 better-fix로 갱신.
    if (locked && locked.id !== candidate.station.id) {
      emitMetric('unlocked-better-fix', locked, fixMeta);
    }
    lockedAtRef.current = now;
    candidateCountRef.current = 0; // 다음 갱신을 위해 리셋
    movedAwayCountRef.current = 0; // 새 lock 기준으로 moved-away 누적도 초기화
    setLocked(candidate.station);
    emitMetric('locked', candidate.station, fixMeta);
    void writePersistedLock({ station: candidate.station, lockedAt: now });
    logger.info('sticky locked', {
      station: candidate.station.name,
      line: candidate.station.line,
      accuracyMeters,
      speedMps,
    });
  }, [fix, motion, locked, hydrated, clearLockState]);

  return { locked, releaseLock };
}
