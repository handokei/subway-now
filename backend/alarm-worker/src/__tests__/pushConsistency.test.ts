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

// ---- fixtures ---------------------------------------------------------------
const NOW = 1_750_000_000_000;

const makeDevice = (overrides: Partial<DeviceSignal> = {}): DeviceSignal => ({
  currentStationName: '중곡',
  motion: 'automotive',
  wifiStation: null,
  lastUpdateMs: NOW,
  ...overrides,
});

const makeTarget = (overrides: Partial<PushTarget> = {}): PushTarget => ({
  stationName: '중곡',
  line: '7호선',
  ...overrides,
});

const trip = (deviceHopsBehindTarget: number | null): TripContext => ({
  deviceHopsBehindTarget,
});

const expectAllowed = (r: ConsistencyResult): void => {
  expect(r).toEqual({ allowed: true });
};
const expectBlocked = (
  r: ConsistencyResult,
  reason: Extract<ConsistencyResult, { allowed: false }>['reason'],
): void => {
  expect(r).toEqual({ allowed: false, reason });
};

// ---- 9-branch matrix --------------------------------------------------------
describe('evaluatePushConsistency — 9-branch matrix (#1389)', () => {
  it('1) WiFi == target → allow (강 확증, motion/hops 무시)', () => {
    const result = evaluatePushConsistency(
      makeDevice({
        wifiStation: { stationName: '중곡', line: '7호선' },
        motion: 'stationary',
      }),
      makeTarget(),
      trip(5), // 5 hops behind인데도 WiFi가 우선
      NOW,
    );
    expectAllowed(result);
  });

  it('2) WiFi != target && motion=stationary → block (wifi-mismatch)', () => {
    const result = evaluatePushConsistency(
      makeDevice({
        wifiStation: { stationName: '용마산', line: '7호선' },
        motion: 'stationary',
      }),
      makeTarget(),
      trip(0),
      NOW,
    );
    expectBlocked(result, 'wifi-mismatch');
  });

  it('2-alt) WiFi != target && motion=walking → allow (WiFi mismatch 차단 X, 이동 중)', () => {
    // motion이 stationary가 아니면 WiFi mismatch만으로는 차단 안 함 → 후속 분기 평가
    const result = evaluatePushConsistency(
      makeDevice({
        wifiStation: { stationName: '용마산', line: '7호선' },
        motion: 'walking',
      }),
      makeTarget(),
      trip(0),
      NOW,
    );
    expectAllowed(result);
  });

  it('3) signal stale (lastUpdate > 5분 전) → allow', () => {
    const result = evaluatePushConsistency(
      makeDevice({
        lastUpdateMs: NOW - SIGNAL_STALE_MS - 1,
        motion: 'stationary', // stale이면 motion 무관 허용
      }),
      makeTarget(),
      trip(5),
      NOW,
    );
    expectAllowed(result);
  });

  it('3-edge) signal age == 정확히 5분 → 아직 stale 아님 (boundary)', () => {
    // age == SIGNAL_STALE_MS 는 stale 아님 (strict >). hops==0 정상 trip.
    const result = evaluatePushConsistency(
      makeDevice({ lastUpdateMs: NOW - SIGNAL_STALE_MS }),
      makeTarget(),
      trip(0),
      NOW,
    );
    expectAllowed(result);
  });

  it('4) 모든 signal null/unknown → allow (지하 보호)', () => {
    const result = evaluatePushConsistency(
      makeDevice({
        currentStationName: null,
        motion: 'unknown',
        wifiStation: null,
      }),
      makeTarget(),
      trip(99), // hops가 멀어도 모든 signal 부재면 허용
      NOW,
    );
    expectAllowed(result);
  });

  it('5) trip context 부재 (hops=null) → allow (fallback)', () => {
    const result = evaluatePushConsistency(
      makeDevice({ motion: 'stationary' }),
      makeTarget(),
      trip(null),
      NOW,
    );
    expectAllowed(result);
  });

  it('6) hops == 0 (device == target) → allow', () => {
    const result = evaluatePushConsistency(
      makeDevice({ motion: 'stationary' }),
      makeTarget(),
      trip(0),
      NOW,
    );
    expectAllowed(result);
  });

  it('7) hops < 0 (device ahead of target) → block (device-ahead-of-target)', () => {
    const result = evaluatePushConsistency(
      makeDevice(),
      makeTarget(),
      trip(-1),
      NOW,
    );
    expectBlocked(result, 'device-ahead-of-target');
  });

  it('7-alt) hops = -5 (멀리 ahead) → block (device-ahead-of-target)', () => {
    const result = evaluatePushConsistency(
      makeDevice(),
      makeTarget(),
      trip(-5),
      NOW,
    );
    expectBlocked(result, 'device-ahead-of-target');
  });

  it('8) hops == 1 && motion=stationary → block (motion-stationary-far-behind)', () => {
    const result = evaluatePushConsistency(
      makeDevice({ motion: 'stationary' }),
      makeTarget(),
      trip(1),
      NOW,
    );
    expectBlocked(result, 'motion-stationary-far-behind');
  });

  it.each<[Motion]>([['walking'], ['automotive'], ['unknown']])(
    '9) hops == 1 && motion=%s → allow (추격 중)',
    (motion) => {
      const result = evaluatePushConsistency(
        makeDevice({ motion }),
        makeTarget(),
        trip(1),
        NOW,
      );
      expectAllowed(result);
    },
  );

  it('10) hops == 2 → block (device-station-mismatch)', () => {
    const result = evaluatePushConsistency(
      makeDevice({ motion: 'walking' }),
      makeTarget(),
      trip(2),
      NOW,
    );
    expectBlocked(result, 'device-station-mismatch');
  });

  it('10-alt) hops == 10 → block (device-station-mismatch, motion 무관)', () => {
    const result = evaluatePushConsistency(
      makeDevice({ motion: 'automotive' }),
      makeTarget(),
      trip(10),
      NOW,
    );
    expectBlocked(result, 'device-station-mismatch');
  });
});

// ---- WiFi priority over hops ------------------------------------------------
describe('evaluatePushConsistency — priority ordering', () => {
  it('WiFi == target 은 hops 부정합/stale/null currentStation 모두 override (강 확증)', () => {
    const result = evaluatePushConsistency(
      makeDevice({
        currentStationName: null,
        motion: 'stationary',
        wifiStation: { stationName: '중곡', line: '7호선' },
        lastUpdateMs: NOW - SIGNAL_STALE_MS - 1, // stale도 무관
      }),
      makeTarget(),
      trip(7),
      NOW,
    );
    expectAllowed(result);
  });

  it('WiFi mismatch는 line 다르면 stationName 같아도 mismatch', () => {
    const result = evaluatePushConsistency(
      makeDevice({
        wifiStation: { stationName: '중곡', line: '5호선' }, // line 다름
        motion: 'stationary',
      }),
      makeTarget({ stationName: '중곡', line: '7호선' }),
      trip(0),
      NOW,
    );
    expectBlocked(result, 'wifi-mismatch');
  });
});

// ---- 사용자 evidence 재현 (2026-06-16 20:06:54 KST 용마산 정지) ---------------
describe('evaluatePushConsistency — 사용자 evidence (#1389)', () => {
  it('용마산 정지 (motion=stationary, currentStation=용마산) 상태에서 중곡 imminent push → block', () => {
    // 용마산 → 중곡: 7호선 인접 (1 hop). device는 용마산에 정지.
    const result = evaluatePushConsistency(
      makeDevice({
        currentStationName: '용마산',
        motion: 'stationary',
        wifiStation: null,
        lastUpdateMs: NOW,
      }),
      makeTarget({ stationName: '중곡', line: '7호선' }),
      trip(1),
      NOW,
    );
    expectBlocked(result, 'motion-stationary-far-behind');
  });
});

// ---- 추가 edge — reviewer 권고 P2-5 (priority/transitive isolation) ---------
describe('evaluatePushConsistency — edge isolation', () => {
  it('stale + WiFi mismatch + stationary → WiFi 우선이라 wifi-mismatch (stale check 도달 전)', () => {
    const result = evaluatePushConsistency(
      makeDevice({
        wifiStation: { stationName: '용마산', line: '7호선' },
        motion: 'stationary',
        lastUpdateMs: NOW - SIGNAL_STALE_MS - 1, // stale이지만 step 1/2가 먼저
      }),
      makeTarget(),
      trip(0),
      NOW,
    );
    expectBlocked(result, 'wifi-mismatch');
  });

  it('WiFi == target + hops<0 → WiFi 우선이라 allow (ahead 판단 override)', () => {
    const result = evaluatePushConsistency(
      makeDevice({
        wifiStation: { stationName: '중곡', line: '7호선' },
      }),
      makeTarget(),
      trip(-3),
      NOW,
    );
    expectAllowed(result);
  });

  it('hops=null + motion=stationary + wifi=null + currentStation 존재 → step 5 fallback allow', () => {
    // step 1/2: wifi null이라 skip. step 3: not stale. step 4: currentStation 존재라 skip.
    // step 5: hops==null로 trigger되어 allow.
    const result = evaluatePushConsistency(
      makeDevice({
        currentStationName: '용마산',
        motion: 'stationary',
        wifiStation: null,
      }),
      makeTarget(),
      trip(null),
      NOW,
    );
    expectAllowed(result);
  });
});
