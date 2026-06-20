/**
 * #1568 (T8b, Epic ADR-017 #1553) — backend SSoT 권위 mirror storage SSoT 모듈.
 *
 * silent push handler가 payload.ssot를 영속화하고 device 화면/cascade picker가 read한다.
 * 본 모듈은 AsyncStorage I/O만 다루며 expo-notifications / expo-task-manager 의존성이 없어
 * 어떤 feature에서든 가볍게 import 가능하다 (#1568 cascade picker / DebugModal 양쪽이 사용).
 *
 * 구 호환: 원래 `silentPushTask.ts`에 함께 있던 helper(`persistBackendSsotMirror`/`readBackendSsotMirror`/
 * `SilentPushSsotMirror`/`BackendSsotMirrorEntry`)를 본 모듈로 이전. silentPushTask.ts는 re-export로
 * 기존 import path를 유지한다.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { BACKEND_SSOT_MIRROR_KEY } from '../../../shared/constants/storageKeys';

/**
 * #1561 (T8) — silent push payload에 실린 SSoT 권위 스냅샷 형태.
 *
 * backend `apns.ts`의 `SilentPushSsotPayload`와 1:1. device는 본 값을 BACKEND_SSOT_MIRROR_KEY에
 * mirror하며 cascade picker가 다음 polling cycle에서 read해 `backend-ssot` tier로 채택.
 */
export interface SilentPushSsotMirror {
  currentStationId: string;
  motionState: 'moving' | 'stationary' | 'unknown';
  lastAdvanceEvidence: string;
  lastAdvanceAt: number;
  passedStations: readonly string[];
}

/** #1561 (T8) — mirror entry에 receivedAt 추가. cascade picker가 자체 staleness 판정. */
export interface BackendSsotMirrorEntry extends SilentPushSsotMirror {
  receivedAt: number;
}

/**
 * #1561 (T8, ADR-017 / S2 #1535 흡수) — backend SSoT 권위 mirror를 AsyncStorage에 영속화.
 *
 * useFusedNearestStation cascade picker가 다음 polling cycle에서 본 값을 read해 `backend-ssot`
 * tier(최상위)로 채택한다. receivedAt epoch ms를 함께 stamp.
 *
 * write 실패는 silent — backend SSoT mirror는 보조 신호로 미존재 시 cascade는 기존 tier fallback.
 */
export async function persistBackendSsotMirror(
  ssot: SilentPushSsotMirror,
  receivedAt: number,
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      BACKEND_SSOT_MIRROR_KEY,
      JSON.stringify({ ...ssot, receivedAt }),
    );
  } catch {
    // graceful — cascade picker는 mirror 부재 시 기존 tier fallback.
  }
}

/**
 * #1573 (T10) — backend SSoT mirror를 AsyncStorage에서 제거.
 *
 * trip 종료 시(tripBoundCleanups 경로 전체 — FG setDestination(null), silent push trip-ended,
 * useStateRehydration sentinel, useLaunchTripReconciliation, 6h backstop) 호출해 stale mirror가
 * 다음 trip의 cascade 최상위 tier로 leak 채택되는 회귀(Mirror leak #3) 차단.
 *
 * 멱등 — 키 부재 시 graceful no-op. removeItem 실패는 swallow.
 */
export async function clearBackendSsotMirror(): Promise<void> {
  try {
    await AsyncStorage.removeItem(BACKEND_SSOT_MIRROR_KEY);
  } catch {
    // graceful — 다음 cleanup pass에서 재시도. 잔존하더라도 freshness 180s 만료 후
    // 자연 비활성화되므로 보조 backstop이 있다.
  }
}

/**
 * #1561 (T8) — AsyncStorage에서 backend SSoT mirror 읽기. cascade picker가 polling cycle마다 호출.
 *
 * 미존재 / parse 실패 → null. cascade picker는 기존 tier fallback.
 */
export async function readBackendSsotMirror(): Promise<BackendSsotMirrorEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(BACKEND_SSOT_MIRROR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BackendSsotMirrorEntry> | null;
    if (
      !parsed ||
      typeof parsed.currentStationId !== 'string' ||
      parsed.currentStationId.length === 0 ||
      (parsed.motionState !== 'moving' &&
        parsed.motionState !== 'stationary' &&
        parsed.motionState !== 'unknown') ||
      typeof parsed.lastAdvanceEvidence !== 'string' ||
      typeof parsed.lastAdvanceAt !== 'number' ||
      !Array.isArray(parsed.passedStations) ||
      typeof parsed.receivedAt !== 'number'
    ) {
      return null;
    }
    return {
      currentStationId: parsed.currentStationId,
      motionState: parsed.motionState,
      lastAdvanceEvidence: parsed.lastAdvanceEvidence,
      lastAdvanceAt: parsed.lastAdvanceAt,
      passedStations: parsed.passedStations.filter(
        (p): p is string => typeof p === 'string' && p.length > 0,
      ),
      receivedAt: parsed.receivedAt,
    };
  } catch {
    return null;
  }
}
