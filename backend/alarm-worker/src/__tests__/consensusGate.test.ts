import { describe, expect, it } from 'vitest';
import type { GateOutcome } from '../boardingPrompt';
import {
  computeAllowedLines,
  evaluateConsensusGate,
  isLockLineAllowed,
  isLockLineAllowedForTrip,
  type StationEnvironment,
} from '../consensusGate';
import type { MultiTransferRoute, Route, TransferRoute } from '../types';

/** 기본 metric stub — 통과/실패 형식만 보면 되므로 최소 필드. */
const PASS_GATE: GateOutcome = {
  pass: true,
  metrics: {
    count: 5,
    avgAccuracyMeters: 10,
    gpsAvgKmh: 20,
    motion: 'automotive',
    mapMatchedKmh: null,
    start: { lat: 0, lng: 0, ts: 0, accuracyMeters: 0, motion: 'automotive' },
    end: { lat: 0, lng: 0, ts: 0, accuracyMeters: 0, motion: 'automotive' },
  } as unknown as GateOutcome extends { pass: true; metrics: infer M } ? M : never,
  fusedSpeedKmh: 20,
};
const FAIL_GATE: GateOutcome = { pass: false, reason: 'speed-too-low' };

/** signals factory — gateOutcome + arrival + lockAttachable + optional surrogates를 한 곳에서 생성. */
type SignalOverrides = Partial<Parameters<typeof evaluateConsensusGate>[1]>;
const signals = (overrides: SignalOverrides = {}) => ({
  gateOutcome: PASS_GATE,
  arrivalSignalPresent: true,
  lockAttachable: true,
  ...overrides,
});

/** gate 평가 wrapper — env + overrides만 받아 호출 보일러플레이트 제거. */
const runGate = (env: StationEnvironment, overrides: SignalOverrides = {}) =>
  evaluateConsensusGate(env, signals(overrides));

describe('evaluateConsensusGate (ADR-015 §3/§4)', () => {
  describe('environment=surface', () => {
    it('base 게이트 통과 → fire 허용', () => {
      expect(runGate('surface').pass).toBe(true);
    });

    it('base 게이트 실패 → reject (reason=base-gate-failed)', () => {
      expect(runGate('surface', { gateOutcome: FAIL_GATE })).toEqual({
        pass: false,
        environment: 'surface',
        reason: 'base-gate-failed',
      });
    });
  });

  describe('environment=underground (§3 GPS reject)', () => {
    it('arrival(B) + lockAttachable(E surrogate) 2-of-2 → 통과 (GPS 입력 무시)', () => {
      // GPS 기반 base 실패해도 무시
      expect(runGate('underground', { gateOutcome: FAIL_GATE }).pass).toBe(true);
    });

    it('arrival만 있고 lockAttachable=false → reject', () => {
      expect(runGate('underground', { lockAttachable: false })).toEqual({
        pass: false,
        environment: 'underground',
        reason: 'environment-no-gps-consensus',
      });
    });

    it('positionTrainAgreement(C) + arrival(B) → 통과', () => {
      expect(
        runGate('underground', {
          gateOutcome: FAIL_GATE,
          lockAttachable: false,
          positionTrainAgreement: true,
        }).pass,
      ).toBe(true);
    });

    it('wifiSsidMatch(D) + arrival(B) → 통과', () => {
      expect(
        runGate('underground', {
          gateOutcome: FAIL_GATE,
          lockAttachable: false,
          wifiSsidMatch: true,
        }).pass,
      ).toBe(true);
    });

    it('전 신호 침묵 → silent (reject) — ADR-015 §4 silent 한정 케이스', () => {
      expect(
        runGate('underground', {
          gateOutcome: FAIL_GATE,
          arrivalSignalPresent: false,
          lockAttachable: false,
        }).pass,
      ).toBe(false);
    });
  });

  describe('environment=mixed (보수적)', () => {
    it('base + arrival + lockAttachable 모두 통과 → 허용', () => {
      expect(runGate('mixed').pass).toBe(true);
    });

    it('base 통과 + lockAttachable=false → reject (insufficient)', () => {
      expect(runGate('mixed', { lockAttachable: false })).toEqual({
        pass: false,
        environment: 'mixed',
        reason: 'mixed-strong-signals-insufficient',
      });
    });

    it('base 실패 → reject (base-gate-failed) — strong 두 개로 회피 불가', () => {
      expect(runGate('mixed', { gateOutcome: FAIL_GATE })).toEqual({
        pass: false,
        environment: 'mixed',
        reason: 'base-gate-failed',
      });
    });
  });

  describe('environment=unknown (= mixed 동급 보수)', () => {
    it('mixed와 동일 분기로 평가', () => {
      expect(runGate('unknown').pass).toBe(true);
    });
  });

  describe('S10 #1543 — cellularEnvironmentVote contradict 게이트', () => {
    it('surface env + cellular=underground → reject (cellular-environment-contradicts)', () => {
      expect(runGate('surface', { cellularEnvironmentVote: 'underground' })).toEqual({
        pass: false,
        environment: 'surface',
        reason: 'cellular-environment-contradicts',
      });
    });

    it('underground env + cellular=surface → reject (contradicts) — base 통과 무시', () => {
      expect(runGate('underground', { cellularEnvironmentVote: 'surface' })).toEqual({
        pass: false,
        environment: 'underground',
        reason: 'cellular-environment-contradicts',
      });
    });

    it('surface env + cellular=surface (일치) → 기존 base 게이트 결과 그대로', () => {
      expect(runGate('surface', { cellularEnvironmentVote: 'surface' }).pass).toBe(true);
    });

    it('underground env + cellular=underground (일치) → 기존 B+E 합의 통과', () => {
      expect(runGate('underground', { cellularEnvironmentVote: 'underground' }).pass).toBe(true);
    });

    it('cellular=unknown → vote 미투표, 게이트 정책 영향 0', () => {
      expect(runGate('surface', { cellularEnvironmentVote: 'unknown' }).pass).toBe(true);
      expect(runGate('underground', { cellularEnvironmentVote: 'unknown' }).pass).toBe(true);
    });

    it('cellular undefined (필드 미전송) → vote 미투표', () => {
      expect(runGate('surface').pass).toBe(true);
    });

    it('mixed env — cellular vote는 contradict 판정 대상이 아님 (보수)', () => {
      expect(runGate('mixed', { cellularEnvironmentVote: 'surface' }).pass).toBe(true);
      expect(runGate('mixed', { cellularEnvironmentVote: 'underground' }).pass).toBe(true);
    });

    it('unknown env — mixed와 동일 (cellular vote는 contradict 판정 X)', () => {
      expect(runGate('unknown', { cellularEnvironmentVote: 'surface' }).pass).toBe(true);
    });
  });

  describe('#2014 (ADR-022 B8) — archFlag=on 시 환경 분기 우회', () => {
    it('archFlag=on + surface + base 실패 → pass (base 게이트 무시)', () => {
      // legacy 경로에선 base-gate-failed 로 reject. archFlag=on 은 arvlCd SSoT 로 우회.
      expect(
        evaluateConsensusGate(
          'surface',
          signals({ gateOutcome: FAIL_GATE }),
          'on',
        ).pass,
      ).toBe(true);
    });

    it('archFlag=on + underground + arrival/lockAttachable 모두 없음 → pass', () => {
      // legacy 경로에선 environment-no-gps-consensus. archFlag=on 은 우회.
      expect(
        evaluateConsensusGate(
          'underground',
          signals({
            gateOutcome: FAIL_GATE,
            arrivalSignalPresent: false,
            lockAttachable: false,
          }),
          'on',
        ).pass,
      ).toBe(true);
    });

    it('archFlag=on + cellular contradict → pass (cellular vote 도 무시)', () => {
      // legacy 경로에선 cellular-environment-contradicts. archFlag=on 은 우회.
      expect(
        evaluateConsensusGate(
          'surface',
          signals({ cellularEnvironmentVote: 'underground' }),
          'on',
        ).pass,
      ).toBe(true);
    });

    it('archFlag=off → 기존 정책 유지 (base 실패 시 reject)', () => {
      expect(
        evaluateConsensusGate(
          'surface',
          signals({ gateOutcome: FAIL_GATE }),
          'off',
        ),
      ).toEqual({
        pass: false,
        environment: 'surface',
        reason: 'base-gate-failed',
      });
    });

    it('archFlag undefined (legacy) → 기존 정책 유지', () => {
      // 3-arg overload 없이 호출한 케이스와 동일.
      expect(
        evaluateConsensusGate('surface', signals({ gateOutcome: FAIL_GATE })),
      ).toEqual({
        pass: false,
        environment: 'surface',
        reason: 'base-gate-failed',
      });
    });
  });

  describe('§7 토글 input X — backend는 trip 등록만 본다', () => {
    it.each<StationEnvironment>(['surface', 'underground', 'mixed'])(
      '%s: 동일 signals → 토글 ON/OFF / boardingPrompt 응답 유무와 무관하게 동일 결과',
      (env) => {
        // 본 게이트 시그너처는 BoardingPromptState / infoModeEnabled를 받지 않는다.
        // 동일 signals 입력은 두 trip이 모두 동일 결과를 반환해야 한다 — 정적 보증.
        expect(runGate(env)).toEqual(runGate(env));
      },
    );
  });
});

/** sorted lines helper — Set → 정렬된 배열로 변환해 비교 보일러플레이트 제거. */
const sortedLines = (...args: Parameters<typeof computeAllowedLines>) =>
  Array.from(computeAllowedLines(...args)).sort((a, b) => a.localeCompare(b));

describe('computeAllowedLines (ADR-015 §5/§9)', () => {
  it('direct route — 단일 line', () => {
    const route: Route = { type: 'direct', line: '2', stops: 5 };
    expect(sortedLines(route)).toEqual(['2']);
  });

  it('transfer route — fromLine + toLine union', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '왕십리',
      fromLine: '2',
      toLine: '5',
      stopsToTransfer: 3,
      stopsFromTransfer: 2,
    };
    expect(sortedLines(route)).toEqual(['2', '5']);
  });

  it('multi-transfer route — 모든 segment union', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '왕십리', fromLine: '2', toLine: '5', stopsToTransfer: 3 },
        { transferName: '청구', fromLine: '5', toLine: '6', stopsToTransfer: 2 },
      ],
      stopsAfterLastTransfer: 4,
    };
    expect(sortedLines(route)).toEqual(['2', '5', '6']);
  });

  it('waypoints의 line도 union (구 client direct + cross-line waypoints 호환)', () => {
    // direct route line=7이지만 waypoints에 line=2가 있는 historical-compat case.
    const route: Route = { type: 'direct', line: '7', stops: 3 };
    const waypoints = [
      { stationName: '건대입구', line: '7' as const, kind: 'transfer' as const },
      { stationName: '성수', line: '2' as const, kind: 'destination' as const },
    ];
    expect(sortedLines(route, waypoints)).toEqual(['2', '7']);
  });
});

describe('isLockLineAllowed (ADR-015 §9 trainCode lock 정확성 게이트)', () => {
  it('lock.line이 set 안 → allow', () => {
    expect(isLockLineAllowed({ line: '2' }, new Set(['2', '5']))).toBe(true);
  });

  it('lock.line이 set 밖 → reject (분당선 variant 같은 cross-line 매핑 회귀 차단)', () => {
    expect(isLockLineAllowed({ line: 'bundang' }, new Set(['2', '5']))).toBe(false);
  });

  it('빈 set → 보수적으로 allow (데이터 부재로 게이트 자체를 막진 않음)', () => {
    expect(isLockLineAllowed({ line: 'bundang' }, new Set())).toBe(true);
  });
});

describe('isLockLineAllowedForTrip', () => {
  it('trip route 기반 편의 wrapper — direct trip + 매칭 line', () => {
    const trip = { route: { type: 'direct', line: '2', stops: 3 } as const, waypoints: [] };
    expect(isLockLineAllowedForTrip({ line: '2' }, trip)).toBe(true);
    expect(isLockLineAllowedForTrip({ line: 'bundang' }, trip)).toBe(false);
  });

  it('transfer trip — fromLine 또는 toLine 모두 허용', () => {
    const trip = {
      route: {
        type: 'transfer',
        transferName: '왕십리',
        fromLine: '2',
        toLine: '5',
        stopsToTransfer: 3,
        stopsFromTransfer: 2,
      } as const,
      waypoints: [],
    };
    expect(isLockLineAllowedForTrip({ line: '5' }, trip)).toBe(true);
    expect(isLockLineAllowedForTrip({ line: 'bundang' }, trip)).toBe(false);
  });
});
