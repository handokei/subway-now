import { describe, expect, it } from 'vitest';
import {
  type ConsistencyResult,
  type DeviceSignal,
  type Motion,
  type PushTarget,
  type TripContext,
  SIGNAL_STALE_MS,
  evaluatePushConsistency,
} from '../pushConsistency';

/**
 * Backend pushConsistency unit test (#1389).
 *
 * 작성 패턴: vitest `it.each` 테이블 드라이븐.
 * Frontend(jest) mirror test 와 동일한 9-branch matrix 를 다른 시각화로 검증한다.
 * (분기 검증 동등성 유지 + textual duplication 회피 목적.)
 */

const T0 = 1_750_000_000_000;
const STALE_GAP = SIGNAL_STALE_MS + 1;

/** DeviceSignal 빌더 (overrides 머지). default = 중곡/automotive/WiFi 없음/now). */
const signal = (over: Partial<DeviceSignal> = {}): DeviceSignal => ({
  currentStationName: '중곡',
  motion: 'automotive',
  wifiStation: null,
  lastUpdateMs: T0,
  ...over,
});

/** PushTarget 빌더. default = 중곡 7호선. */
const pushFor = (over: Partial<PushTarget> = {}): PushTarget => ({
  stationName: '중곡',
  line: '7호선',
  ...over,
});

/** TripContext 빌더 (hops 명시). null = trip 모름 fallback. */
const arc = (hops: number | null): TripContext => ({
  deviceHopsBehindTarget: hops,
});

/** Allowed 결과만 통과시키는 검증자. */
function assertAllow(r: ConsistencyResult): void {
  if (r.allowed !== true) {
    throw new Error(`expected allow, got blocked: ${r.reason}`);
  }
  expect(r.allowed).toBe(true);
}

/** Blocked 결과 + reason 정확 매치 검증자. */
function assertBlock(
  r: ConsistencyResult,
  expected: Extract<ConsistencyResult, { allowed: false }>['reason'],
): void {
  if (r.allowed !== false) {
    throw new Error(`expected block(${expected}), got allow`);
  }
  expect(r.reason).toBe(expected);
}

// ============================================================================
// Allow 케이스 테이블 (9-branch matrix 중 allow 분기 + edge)
// ============================================================================
type AllowRow = {
  name: string;
  device: Partial<DeviceSignal>;
  target?: Partial<PushTarget>;
  hops: number | null;
  /** now offset from device.lastUpdateMs (0 means current). */
  nowAt?: number;
};

const allowMatrix: AllowRow[] = [
  {
    name: '[1] WiFi == target → 강 확증 (motion/hops 무시)',
    device: {
      wifiStation: { stationName: '중곡', line: '7호선' },
      motion: 'stationary',
    },
    hops: 5,
  },
  {
    name: '[2-alt] WiFi mismatch + motion=walking → 이동 중 허용',
    device: {
      wifiStation: { stationName: '용마산', line: '7호선' },
      motion: 'walking',
    },
    hops: 0,
  },
  {
    name: '[3] signal stale (>5분) → 정보 부재 처리',
    device: {
      lastUpdateMs: T0,
      motion: 'stationary',
    },
    nowAt: STALE_GAP,
    hops: 5,
  },
  {
    name: '[3-edge] signal age == 정확히 5분 → boundary, 아직 stale 아님',
    device: { lastUpdateMs: T0 },
    nowAt: SIGNAL_STALE_MS,
    hops: 0,
  },
  {
    name: '[4] 모든 signal null/unknown → 지하 보호',
    device: {
      currentStationName: null,
      motion: 'unknown',
      wifiStation: null,
    },
    hops: 99,
  },
  {
    name: '[5] trip context 부재 (hops=null) → fallback',
    device: { motion: 'stationary' },
    hops: null,
  },
  {
    name: '[6] hops == 0 (device == target) → 정상',
    device: { motion: 'stationary' },
    hops: 0,
  },
];

describe('evaluatePushConsistency — allow branches', () => {
  it.each(allowMatrix)('$name', ({ device, target, hops, nowAt }) => {
    const now = T0 + (nowAt ?? 0);
    const result = evaluatePushConsistency(
      signal(device),
      pushFor(target),
      arc(hops),
      now,
    );
    assertAllow(result);
  });
});

// ============================================================================
// hops==1 motion 분기 (9번 — walking/automotive/unknown 추격 중 허용)
// ============================================================================
describe('evaluatePushConsistency — hops==1 motion 분기 (case 9)', () => {
  const chaseMotions: Motion[] = ['walking', 'automotive', 'unknown'];
  it.each(chaseMotions)(
    '[9] hops=1 + motion=%s → 추격 중 허용',
    (motion) => {
      const result = evaluatePushConsistency(
        signal({ motion }),
        pushFor(),
        arc(1),
        T0,
      );
      assertAllow(result);
    },
  );
});

// ============================================================================
// Block 케이스 테이블 (9-branch matrix 중 block 분기 + reason 매트릭스)
// ============================================================================
type BlockRow = {
  name: string;
  device: Partial<DeviceSignal>;
  target?: Partial<PushTarget>;
  hops: number | null;
  reason: Extract<ConsistencyResult, { allowed: false }>['reason'];
};

const blockMatrix: BlockRow[] = [
  {
    name: '[2] WiFi mismatch + stationary → wifi-mismatch',
    device: {
      wifiStation: { stationName: '용마산', line: '7호선' },
      motion: 'stationary',
    },
    hops: 0,
    reason: 'wifi-mismatch',
  },
  {
    name: '[7] hops < 0 (-1) → device-ahead-of-target',
    device: {},
    hops: -1,
    reason: 'device-ahead-of-target',
  },
  {
    name: '[7-alt] hops < 0 (-5, 멀리 ahead) → device-ahead-of-target',
    device: {},
    hops: -5,
    reason: 'device-ahead-of-target',
  },
  {
    name: '[8] hops=1 + motion=stationary → motion-stationary-far-behind',
    device: { motion: 'stationary' },
    hops: 1,
    reason: 'motion-stationary-far-behind',
  },
  {
    name: '[10] hops=2 + motion=walking → device-station-mismatch',
    device: { motion: 'walking' },
    hops: 2,
    reason: 'device-station-mismatch',
  },
  {
    name: '[10-alt] hops=10 + motion=automotive → device-station-mismatch',
    device: { motion: 'automotive' },
    hops: 10,
    reason: 'device-station-mismatch',
  },
];

describe('evaluatePushConsistency — block branches', () => {
  it.each(blockMatrix)('$name', ({ device, target, hops, reason }) => {
    const result = evaluatePushConsistency(
      signal(device),
      pushFor(target),
      arc(hops),
      T0,
    );
    assertBlock(result, reason);
  });
});

// ============================================================================
// 우선순위 / edge isolation (다른 분기 동시 trigger 시 어느 step이 결정?)
// ============================================================================
describe('evaluatePushConsistency — step priority', () => {
  it('WiFi==target 은 hops 불일치/stale/null currentStation 모두 override', () => {
    const out = evaluatePushConsistency(
      signal({
        currentStationName: null,
        motion: 'stationary',
        wifiStation: { stationName: '중곡', line: '7호선' },
        lastUpdateMs: T0 - STALE_GAP,
      }),
      pushFor(),
      arc(7),
      T0,
    );
    assertAllow(out);
  });

  it('WiFi==target + hops<0 → WiFi 우선이라 ahead 판단 override', () => {
    const out = evaluatePushConsistency(
      signal({ wifiStation: { stationName: '중곡', line: '7호선' } }),
      pushFor(),
      arc(-3),
      T0,
    );
    assertAllow(out);
  });

  it('WiFi line 다르면 stationName 같아도 mismatch', () => {
    const out = evaluatePushConsistency(
      signal({
        wifiStation: { stationName: '중곡', line: '5호선' },
        motion: 'stationary',
      }),
      pushFor({ stationName: '중곡', line: '7호선' }),
      arc(0),
      T0,
    );
    assertBlock(out, 'wifi-mismatch');
  });

  it('stale + WiFi mismatch + stationary → step1/2가 step3보다 먼저라 wifi-mismatch', () => {
    const out = evaluatePushConsistency(
      signal({
        wifiStation: { stationName: '용마산', line: '7호선' },
        motion: 'stationary',
        lastUpdateMs: T0 - STALE_GAP,
      }),
      pushFor(),
      arc(0),
      T0,
    );
    assertBlock(out, 'wifi-mismatch');
  });

  it('hops=null + motion=stationary + wifi=null + currentStation 존재 → step5 fallback allow', () => {
    const out = evaluatePushConsistency(
      signal({
        currentStationName: '용마산',
        motion: 'stationary',
        wifiStation: null,
      }),
      pushFor(),
      arc(null),
      T0,
    );
    assertAllow(out);
  });
});

// ============================================================================
// 사용자 evidence 재현 (2026-06-16 20:06:54 KST 용마산 정지)
// ============================================================================
describe('evaluatePushConsistency — user trip evidence (#1389)', () => {
  it('용마산 정지 상태 + 중곡 imminent push (1 hop behind, stationary) → block', () => {
    const out = evaluatePushConsistency(
      signal({
        currentStationName: '용마산',
        motion: 'stationary',
        wifiStation: null,
        lastUpdateMs: T0,
      }),
      pushFor({ stationName: '중곡', line: '7호선' }),
      arc(1),
      T0,
    );
    assertBlock(out, 'motion-stationary-far-behind');
  });
});
