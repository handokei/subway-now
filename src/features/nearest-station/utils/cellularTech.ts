/**
 * #1543 (ADR-016 S10) — CTRadioAccessTechnology(iOS) JS wrapper + 환경 분류 helper.
 *
 * 목적: native module에서 받은 radio access tech 코드를 환경(지하/지상) vote로 분류해
 * 4분면 SSOT 합의 게이트(`consensusGate`)에 1표 추가한다.
 *
 * 모든 API는 graceful — native module 부재(jest/web/Android/미지원 디바이스), SIM 비활성,
 * 예외 모두 `null` / no-op로 처리. "모르는 상태"는 vote 미투표 (환경 판정 영향 0).
 *
 * 분류 정책 (Apple `CTRadioAccessTechnology*` 상수 기준):
 *   - `surface` (지상 hard-reject): NR (5G SA)
 *       → 2026년 기준 지하 인프라 거의 없음. hard-reject 유지.
 *   - `surface-weak` (지상 soft downgrade): LTE, LTEAdvanced, NRNSA (5G NSA)
 *       → 서울 지하철 DAS가 LTE/NRNSA를 지하에서도 중계 (100% 커버). 지하에서도 잡힘.
 *       → hard-reject 대신 soft downgrade: undergroundSSOTConsensus에서 envVotes −1로 처리.
 *       → 다른 신호(barometer/accelerometer)가 충분하면 underground 채택 허용.
 *       (#1876 — plan-1846 §4.1 옵션 B 적용)
 *   - `underground` (지하 vote): GPRS, Edge, WCDMA, HSDPA, HSUPA, CDMA1x, eHRPD, CDMAEVDORev0/A/B
 *       → 지하 캐리어 펨토셀 / DAS 안테나가 흔히 fallback하는 2G/3G 신호.
 *   - `unknown`              : null / 빈 문자열 / 미지의 상수
 *       → vote 미투표. 무신호도 이론적으로 underground 신호지만 false positive 우려로 보수.
 *
 * Android: CTRadioAccessTechnology와 대응되는 무권한 API가 없어 native module 자체 미제공
 *          → `requireOptionalNativeModule`이 null 반환 → 모든 API graceful.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

interface CellularTechNative {
  isAvailable(): boolean;
  startUpdates(): void;
  stopUpdates(): void;
  /** native가 캐시한 최신 radio access tech 코드. 미확정 시 null. */
  getCurrentTech(): string | null;
}

function getNativeModule(): CellularTechNative | null {
  return requireOptionalNativeModule<CellularTechNative>('CellularTechListener') ?? null;
}

export function isCellularTechSupported(): boolean {
  const module = getNativeModule();
  if (!module) return false;
  try {
    return module.isAvailable();
  } catch {
    return false;
  }
}

export function startCellularTechUpdates(): void {
  const module = getNativeModule();
  if (!module) return;
  try {
    module.startUpdates();
  } catch {
    // graceful — 시작 실패는 getCurrent가 null 반환으로 자연 fallback.
  }
}

export function stopCellularTechUpdates(): void {
  const module = getNativeModule();
  if (!module) return;
  try {
    module.stopUpdates();
  } catch {
    // graceful — 중지 실패는 lifecycle 관점에서 무해.
  }
}

export function getCurrentCellularTech(): string | null {
  const module = getNativeModule();
  if (!module) return null;
  try {
    const tech = module.getCurrentTech();
    return typeof tech === 'string' && tech.length > 0 ? tech : null;
  } catch {
    return null;
  }
}

/**
 * 환경 vote 결과. consensusGate / undergroundSSOTConsensus 입력으로 사용.
 *
 * - `'surface'`      : NR (5G SA) — 지하 발생 낮음. hard-reject 유지.
 * - `'surface-weak'` : LTE / LTEAdvanced / NRNSA — 지하에서도 잡힘(서울 DAS). soft downgrade.
 * - `'underground'`  : 2G/3G — 지하 확정 1표.
 * - `'unknown'`      : vote 미투표.
 */
export type CellularEnvironmentVote = 'surface' | 'surface-weak' | 'underground' | 'unknown';

/**
 * Apple `CTRadioAccessTechnology` 상수 → 환경 vote 매핑.
 *
 * 하드코딩이 아닌 데이터 주도: 추가 상수가 등장하면 본 표에만 한 줄 추가.
 * (CLAUDE.md 글로벌 룰 3번 — 확장성/재사용성 우선)
 *
 * 상수 prefix `CTRadioAccessTechnology`는 native가 그대로 string으로 반환한다.
 */

/**
 * NR (5G SA) — 지하 인프라 미비 (2026년 기준). hard-reject 유지.
 * 새 5G SA 기술이 지하 커버를 갖추기 전까지 이 분류를 유지한다.
 */
const SURFACE_HARD_TECHS: ReadonlySet<string> = new Set([
  'CTRadioAccessTechnologyNR',
]);

/**
 * LTE / LTEAdvanced / NRNSA — 서울 지하철 DAS 지하 중계로 지하에서도 흔히 수신.
 * hard-reject 대신 soft downgrade (`'surface-weak'`).
 */
const SURFACE_WEAK_TECHS: ReadonlySet<string> = new Set([
  'CTRadioAccessTechnologyLTE',
  'CTRadioAccessTechnologyLTEAdvanced',
  'CTRadioAccessTechnologyNRNSA',
]);

const UNDERGROUND_TECHS: ReadonlySet<string> = new Set([
  'CTRadioAccessTechnologyGPRS',
  'CTRadioAccessTechnologyEdge',
  'CTRadioAccessTechnologyWCDMA',
  'CTRadioAccessTechnologyHSDPA',
  'CTRadioAccessTechnologyHSUPA',
  'CTRadioAccessTechnologyCDMA1x',
  'CTRadioAccessTechnologyeHRPD',
  'CTRadioAccessTechnologyCDMAEVDORev0',
  'CTRadioAccessTechnologyCDMAEVDORevA',
  'CTRadioAccessTechnologyCDMAEVDORevB',
]);

/**
 * radio tech 코드 → 환경 vote 분류.
 *
 * - NR (5G SA)       → `'surface'`      (hard-reject — 지하 발생 낮음)
 * - LTE / NRNSA      → `'surface-weak'` (soft downgrade — 서울 지하 DAS 중계)
 * - 2G/3G            → `'underground'`  (지하 1표)
 * - null / 미지 코드  → `'unknown'`     (vote 미투표)
 */
export function classifyCellularEnvironment(tech: string | null): CellularEnvironmentVote {
  if (!tech) return 'unknown';
  if (SURFACE_HARD_TECHS.has(tech)) return 'surface';
  if (SURFACE_WEAK_TECHS.has(tech)) return 'surface-weak';
  if (UNDERGROUND_TECHS.has(tech)) return 'underground';
  return 'unknown';
}
