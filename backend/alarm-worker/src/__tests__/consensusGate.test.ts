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

describe('evaluateConsensusGate (ADR-015 §3/§4)', () => {
  describe('environment=surface', () => {
    it('base 게이트 통과 → fire 허용', () => {
      const out = evaluateConsensusGate('surface', {
        gateOutcome: PASS_GATE,
        arrivalSignalPresent: true,
        lockAttachable: true,
      });
      expect(out.pass).toBe(true);
    });

    it('base 게이트 실패 → reject (reason=base-gate-failed)', () => {
      const out = evaluateConsensusGate('surface', {
        gateOutcome: FAIL_GATE,
        arrivalSignalPresent: true,
        lockAttachable: true,
      });
      expect(out).toEqual({ pass: false, environment: 'surface', reason: 'base-gate-failed' });
    });
  });

  describe('environment=underground (§3 GPS reject)', () => {
    it('arrival(B) + lockAttachable(E surrogate) 2-of-2 → 통과 (GPS 입력 무시)', () => {
      const out = evaluateConsensusGate('underground', {
        gateOutcome: FAIL_GATE, // GPS 기반 base 실패해도 무시
        arrivalSignalPresent: true,
        lockAttachable: true,
      });
      expect(out.pass).toBe(true);
    });

    it('arrival만 있고 lockAttachable=false → reject', () => {
      const out = evaluateConsensusGate('underground', {
        gateOutcome: PASS_GATE,
        arrivalSignalPresent: true,
        lockAttachable: false,
      });
      expect(out).toEqual({
        pass: false,
        environment: 'underground',
        reason: 'environment-no-gps-consensus',
      });
    });

    it('positionTrainAgreement(C) + arrival(B) → 통과', () => {
      const out = evaluateConsensusGate('underground', {
        gateOutcome: FAIL_GATE,
        arrivalSignalPresent: true,
        lockAttachable: false,
        positionTrainAgreement: true,
      });
      expect(out.pass).toBe(true);
    });

    it('wifiSsidMatch(D) + arrival(B) → 통과', () => {
      const out = evaluateConsensusGate('underground', {
        gateOutcome: FAIL_GATE,
        arrivalSignalPresent: true,
        lockAttachable: false,
        wifiSsidMatch: true,
      });
      expect(out.pass).toBe(true);
    });

    it('전 신호 침묵 → silent (reject) — ADR-015 §4 silent 한정 케이스', () => {
      const out = evaluateConsensusGate('underground', {
        gateOutcome: FAIL_GATE,
        arrivalSignalPresent: false,
        lockAttachable: false,
      });
      expect(out.pass).toBe(false);
    });
  });

  describe('environment=mixed (보수적)', () => {
    it('base + arrival + lockAttachable 모두 통과 → 허용', () => {
      const out = evaluateConsensusGate('mixed', {
        gateOutcome: PASS_GATE,
        arrivalSignalPresent: true,
        lockAttachable: true,
      });
      expect(out.pass).toBe(true);
    });

    it('base 통과 + lockAttachable=false → reject (insufficient)', () => {
      const out = evaluateConsensusGate('mixed', {
        gateOutcome: PASS_GATE,
        arrivalSignalPresent: true,
        lockAttachable: false,
      });
      expect(out).toEqual({
        pass: false,
        environment: 'mixed',
        reason: 'mixed-strong-signals-insufficient',
      });
    });

    it('base 실패 → reject (base-gate-failed) — strong 두 개로 회피 불가', () => {
      const out = evaluateConsensusGate('mixed', {
        gateOutcome: FAIL_GATE,
        arrivalSignalPresent: true,
        lockAttachable: true,
      });
      expect(out).toEqual({
        pass: false,
        environment: 'mixed',
        reason: 'base-gate-failed',
      });
    });
  });

  describe('environment=unknown (= mixed 동급 보수)', () => {
    it('mixed와 동일 분기로 평가', () => {
      const out = evaluateConsensusGate('unknown', {
        gateOutcome: PASS_GATE,
        arrivalSignalPresent: true,
        lockAttachable: true,
      });
      expect(out.pass).toBe(true);
    });
  });

  describe('§7 토글 input X — backend는 trip 등록만 본다', () => {
    it.each<StationEnvironment>(['surface', 'underground', 'mixed'])(
      '%s: 동일 signals → 토글 ON/OFF / boardingPrompt 응답 유무와 무관하게 동일 결과',
      (env) => {
        // 본 게이트 시그너처는 BoardingPromptState / locklessStationPassed를 받지 않는다.
        // 동일 signals 입력은 두 trip이 모두 동일 결과를 반환해야 한다 — 정적 보증.
        const signals = {
          gateOutcome: PASS_GATE,
          arrivalSignalPresent: true,
          lockAttachable: true,
        };
        const a = evaluateConsensusGate(env, signals);
        const b = evaluateConsensusGate(env, signals);
        expect(a).toEqual(b);
      },
    );
  });
});

describe('computeAllowedLines (ADR-015 §5/§9)', () => {
  it('direct route — 단일 line', () => {
    const route: Route = { type: 'direct', line: '2', stops: 5 };
    expect(Array.from(computeAllowedLines(route)).sort()).toEqual(['2']);
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
    expect(Array.from(computeAllowedLines(route)).sort()).toEqual(['2', '5']);
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
    expect(Array.from(computeAllowedLines(route)).sort()).toEqual(['2', '5', '6']);
  });

  it('waypoints의 line도 union (구 client direct + cross-line waypoints 호환)', () => {
    // direct route line=7이지만 waypoints에 line=2가 있는 historical-compat case.
    const route: Route = { type: 'direct', line: '7', stops: 3 };
    const waypoints = [
      { stationName: '건대입구', line: '7' as const, kind: 'transfer' as const },
      { stationName: '성수', line: '2' as const, kind: 'destination' as const },
    ];
    expect(Array.from(computeAllowedLines(route, waypoints)).sort()).toEqual(['2', '7']);
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
