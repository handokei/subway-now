/**
 * #1279 — 기압계 subsurface 상태 AsyncStorage stamp.
 *
 * useBarometer는 FG-only React state로 subsurface를 관리한다.
 * BG silent-push task와 위치 게이트는 React hook에 접근할 수 없어 이 값을 읽지 못한다.
 * 이 모듈이 그 브리지 역할을 한다:
 *   - setSubsurfaceState: useBarometer가 subsurface flip 시 AsyncStorage에 stamp.
 *   - getSubsurfaceState: BG task/게이트가 stamp를 읽어 지하 여부를 판정.
 *
 * TTL 기본값(90_000ms = 90초): 기압계는 1Hz 샘플 + 3회 hysteresis = ~3초 확정 주기.
 * 90초 초과 stamp는 stale(앱 BG 진입 or barometer 구독 해제)로 보수적 false 반환.
 *
 * graceful 정책(feedback_whileinuse_must_work.md):
 *   - parse 실패 / 키 부재 / TTL 만료 / storage 오류 → false (보수적 fallback).
 *   - false 반환이 지하 감지 미작동 → 기존 GPS 게이트로 폴백. 안전.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { SUBSURFACE_STATE_KEY } from '../constants/storageKeys';

/** stamp 형식. */
interface SubsurfaceStamp {
  subsurface: boolean;
  updatedAt: number;
}

/** TTL 기본값 (ms). */
const DEFAULT_TTL_MS = 90_000;

/**
 * subsurface 상태를 AsyncStorage에 기록한다.
 * useBarometer가 subsurface 값이 바뀔 때마다 호출한다.
 *
 * storage 오류는 swallow — 저장 실패가 앱 정지 이유가 되어선 안 된다.
 */
export async function setSubsurfaceState(subsurface: boolean): Promise<void> {
  try {
    const stamp: SubsurfaceStamp = { subsurface, updatedAt: Date.now() };
    await AsyncStorage.setItem(SUBSURFACE_STATE_KEY, JSON.stringify(stamp));
  } catch {
    // storage 실패는 silent — BG task가 false로 fallback해 안전.
  }
}

/**
 * AsyncStorage에 기록된 subsurface 상태를 읽는다.
 *
 * @param ttlMs stamp 유효 기간(ms). 기본 90_000.
 * @returns 유효한 stamp가 있으면 그 subsurface 값, 없으면 false.
 */
export async function getSubsurfaceState(ttlMs: number = DEFAULT_TTL_MS): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(SUBSURFACE_STATE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<SubsurfaceStamp> | null;
    if (
      !parsed ||
      typeof parsed.subsurface !== 'boolean' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return false;
    }
    if (Date.now() - parsed.updatedAt > ttlMs) return false;
    return parsed.subsurface;
  } catch {
    return false;
  }
}
