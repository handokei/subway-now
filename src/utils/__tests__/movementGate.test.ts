import {
  evaluateMovement,
  isFusionDowngradeTarget,
  isStaticSpeedSignal,
  shouldDowngradeFusion,
  MOVEMENT_TO_ALARM_LOG_REASON,
  MAX_ACCURACY_M,
  STALE_AGE_MS,
  STATIC_SPEED_THRESHOLD_MPS,
} from '../movementGate';

describe('movementGate', () => {
  describe('evaluateMovement', () => {
    it('loc=null이면 reliable=false reason=no-location', () => {
      const m = evaluateMovement(null);
      expect(m).toEqual({ reliable: false, reason: 'no-location' });
    });

    it('timestamp가 STALE_AGE_MS 초과 이전이면 stale-timestamp', () => {
      const now = 2_000_000;
      const m = evaluateMovement({ timestamp: now - STALE_AGE_MS - 1 }, now);
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('stale-timestamp');
      expect(m.ageMs).toBe(STALE_AGE_MS + 1);
    });

    it('timestamp가 STALE_AGE_MS 경계 이내면 stale 아님', () => {
      const now = 2_000_000;
      const m = evaluateMovement({ timestamp: now - STALE_AGE_MS }, now);
      expect(m.reliable).toBe(true);
      expect(m.ageMs).toBe(STALE_AGE_MS);
    });

    it('accuracyM > MAX_ACCURACY_M이면 low-accuracy (timestamp 통과한 경우)', () => {
      const now = 1_000_000;
      const m = evaluateMovement(
        { timestamp: now, accuracyM: MAX_ACCURACY_M + 1 },
        now,
      );
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('low-accuracy');
      expect(m.accuracyM).toBe(MAX_ACCURACY_M + 1);
    });

    it('accuracyM이 경계값이면 통과', () => {
      const now = 1_000_000;
      const m = evaluateMovement(
        { timestamp: now, accuracyM: MAX_ACCURACY_M, speedMps: 1 },
        now,
      );
      expect(m.reliable).toBe(true);
    });

    it('speedMps < STATIC_SPEED_THRESHOLD_MPS면 static-speed', () => {
      const m = evaluateMovement({ speedMps: STATIC_SPEED_THRESHOLD_MPS - 0.1 });
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('static-speed');
      expect(m.speedMps).toBe(STATIC_SPEED_THRESHOLD_MPS - 0.1);
    });

    it('speedMps가 경계값이면 통과', () => {
      const m = evaluateMovement({ speedMps: STATIC_SPEED_THRESHOLD_MPS });
      expect(m.reliable).toBe(true);
      expect(m.speedMps).toBe(STATIC_SPEED_THRESHOLD_MPS);
    });

    it('모든 신호 없이 호출하면 reliable=true (보수적 거부 X)', () => {
      const m = evaluateMovement({});
      expect(m).toEqual({ reliable: true });
    });

    it('timestamp/accuracy/speed 모두 정상이면 reliable + 신호 보존', () => {
      const now = 1_000_000;
      const m = evaluateMovement(
        { timestamp: now - 5_000, accuracyM: 50, speedMps: 3 },
        now,
      );
      expect(m.reliable).toBe(true);
      expect(m.ageMs).toBe(5_000);
      expect(m.accuracyM).toBe(50);
      expect(m.speedMps).toBe(3);
    });

    it('평가 순서 우선순위: stale > accuracy > speed', () => {
      const now = 1_000_000;
      // 모두 위반 — stale-timestamp가 먼저 잡혀야 함.
      const m1 = evaluateMovement(
        { timestamp: now - STALE_AGE_MS - 1, accuracyM: 999, speedMps: 0 },
        now,
      );
      expect(m1.reason).toBe('stale-timestamp');

      // stale은 OK, accuracy/speed 위반 — accuracy가 먼저 잡혀야 함.
      const m2 = evaluateMovement(
        { timestamp: now, accuracyM: 999, speedMps: 0 },
        now,
      );
      expect(m2.reason).toBe('low-accuracy');

      // stale/accuracy OK, speed만 위반 — static-speed.
      const m3 = evaluateMovement(
        { timestamp: now, accuracyM: 50, speedMps: 0 },
        now,
      );
      expect(m3.reason).toBe('static-speed');
    });

    it('now 인자 미지정 시 Date.now() 기본 사용', () => {
      const realNow = Date.now();
      const m = evaluateMovement({ timestamp: realNow - 1_000 });
      // 1초 전 = stale 아님
      expect(m.reliable).toBe(true);
    });
  });

  describe('MOVEMENT_TO_ALARM_LOG_REASON', () => {
    it('4개 MovementReason 모두 매핑', () => {
      expect(MOVEMENT_TO_ALARM_LOG_REASON['no-location']).toBe('movement-no-location');
      expect(MOVEMENT_TO_ALARM_LOG_REASON['stale-timestamp']).toBe('movement-stale-timestamp');
      expect(MOVEMENT_TO_ALARM_LOG_REASON['low-accuracy']).toBe('movement-low-accuracy');
      expect(MOVEMENT_TO_ALARM_LOG_REASON['static-speed']).toBe('movement-static-speed');
    });
  });

  describe('isStaticSpeedSignal (fusion downgrade 전용)', () => {
    it('speed < 임계값 + accuracy 정상이면 true', () => {
      expect(isStaticSpeedSignal(STATIC_SPEED_THRESHOLD_MPS - 0.01, 50)).toBe(true);
      expect(isStaticSpeedSignal(0, 50)).toBe(true);
    });

    it('speed < 임계값 + accuracy 미측정이면 true (보조 검증 skip)', () => {
      expect(isStaticSpeedSignal(0)).toBe(true);
      expect(isStaticSpeedSignal(0, null)).toBe(true);
    });

    it('speed >= 임계값이면 false', () => {
      expect(isStaticSpeedSignal(STATIC_SPEED_THRESHOLD_MPS)).toBe(false);
      expect(isStaticSpeedSignal(1)).toBe(false);
      expect(isStaticSpeedSignal(10, 50)).toBe(false);
    });

    it('null/undefined면 false (보수적 — 신호 부재 시 fusion 유지)', () => {
      expect(isStaticSpeedSignal(null)).toBe(false);
      expect(isStaticSpeedSignal(undefined)).toBe(false);
    });

    it('accuracy > MAX_ACCURACY_M이면 speed=0이어도 false (지하 GPS 끊김 보호)', () => {
      expect(isStaticSpeedSignal(0, MAX_ACCURACY_M + 1)).toBe(false);
      expect(isStaticSpeedSignal(0, 1500)).toBe(false);
    });

    it('accuracy 경계값(MAX_ACCURACY_M)이면 speed=0이어도 true (지하 추정 X)', () => {
      expect(isStaticSpeedSignal(0, MAX_ACCURACY_M)).toBe(true);
    });
  });

  describe('isFusionDowngradeTarget', () => {
    it('fusion 승격 라벨 3종 모두 true', () => {
      expect(isFusionDowngradeTarget('position-train')).toBe(true);
      expect(isFusionDowngradeTarget('boarding-lock')).toBe(true);
      expect(isFusionDowngradeTarget('boarding-lock-interp')).toBe(true);
    });

    it('그 외 라벨은 false', () => {
      expect(isFusionDowngradeTarget('gps-only')).toBe(false);
      expect(isFusionDowngradeTarget('arrival-confirmed')).toBe(false);
      expect(isFusionDowngradeTarget('route-progress')).toBe(false);
      expect(isFusionDowngradeTarget('unknown')).toBe(false);
    });
  });

  describe('shouldDowngradeFusion', () => {
    it('승격 라벨 + 정적 신호면 true', () => {
      expect(
        shouldDowngradeFusion({ confidence: 'position-train', speedMps: 0, accuracyM: 50 }),
      ).toBe(true);
      expect(
        shouldDowngradeFusion({ confidence: 'boarding-lock', speedMps: 0.1, accuracyM: 30 }),
      ).toBe(true);
      expect(
        shouldDowngradeFusion({
          confidence: 'boarding-lock-interp',
          speedMps: 0,
          accuracyM: 30,
        }),
      ).toBe(true);
    });

    it('승격 라벨이지만 정적 신호 아니면 false', () => {
      expect(
        shouldDowngradeFusion({ confidence: 'position-train', speedMps: 5, accuracyM: 50 }),
      ).toBe(false);
      // accuracy noise → 정적 신호 인정 안 함
      expect(
        shouldDowngradeFusion({ confidence: 'position-train', speedMps: 0, accuracyM: 1500 }),
      ).toBe(false);
    });

    it('정적 신호여도 승격 라벨 아니면 false', () => {
      expect(
        shouldDowngradeFusion({ confidence: 'gps-only', speedMps: 0, accuracyM: 50 }),
      ).toBe(false);
      expect(
        shouldDowngradeFusion({ confidence: 'arrival-confirmed', speedMps: 0, accuracyM: 50 }),
      ).toBe(false);
    });
  });
});
