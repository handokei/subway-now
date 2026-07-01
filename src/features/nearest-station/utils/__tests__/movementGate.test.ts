import {
  evaluateMovement,
  isFusionDowngradeTarget,
  isStaticMovementResult,
  isStaticSpeedSignal,
  shouldDowngradeFusion,
  MOVEMENT_TO_ALARM_LOG_REASON,
  MAX_ACCURACY_M,
  STALE_AGE_MS,
  STATIC_SPEED_THRESHOLD_MPS,
} from '../movementGate';
import { SIMPLE_ARRIVAL_ARCH_ENV_KEY } from '../../../../shared/config/archFlag';

const ORIGINAL_ARCH_ENV = process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];

/** ADR-022 Phase 4-3 (#2005) — flag ON 상태에서 evaluateMovement 가 항상 reliable=true 를 반환하는지 검증. */
function enableArchFlag(): void {
  process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
}

/** flag OFF (기본) — 명시적 해제해 다른 테스트 격리. */
function disableArchFlag(): void {
  delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
}

afterEach(() => {
  if (ORIGINAL_ARCH_ENV === undefined) {
    delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
  } else {
    process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = ORIGINAL_ARCH_ENV;
  }
});

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
    it('6개 MovementReason 모두 매핑 (#728: motion-stationary 추가)', () => {
      expect(MOVEMENT_TO_ALARM_LOG_REASON['no-location']).toBe('movement-no-location');
      expect(MOVEMENT_TO_ALARM_LOG_REASON['stale-timestamp']).toBe('movement-stale-timestamp');
      expect(MOVEMENT_TO_ALARM_LOG_REASON['low-accuracy']).toBe('movement-low-accuracy');
      expect(MOVEMENT_TO_ALARM_LOG_REASON['static-speed']).toBe('movement-static-speed');
      expect(MOVEMENT_TO_ALARM_LOG_REASON['static-position']).toBe('movement-static-position');
      expect(MOVEMENT_TO_ALARM_LOG_REASON['motion-stationary']).toBe('movement-motion-stationary');
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

    it('speed=null + positionStability 없으면 false (보수적 — 신호 부재 시 fusion 유지)', () => {
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

    it('#733 — speed=null + positionStability=static이면 true (fallback)', () => {
      expect(isStaticSpeedSignal(null, 50, 'static')).toBe(true);
      expect(isStaticSpeedSignal(undefined, 50, 'static')).toBe(true);
    });

    it('#733 — speed=null + positionStability=moving이면 false', () => {
      expect(isStaticSpeedSignal(null, 50, 'moving')).toBe(false);
    });

    it('#733 — speed=null + positionStability=unknown이면 false (보수적)', () => {
      expect(isStaticSpeedSignal(null, 50, 'unknown')).toBe(false);
    });

    it('#733 — speed 측정값이 있으면 positionStability 무시 (speed가 우선)', () => {
      // speed=2 → moving이지만 positionStability=static
      expect(isStaticSpeedSignal(2, 50, 'static')).toBe(false);
      // speed=0 → static + positionStability=moving
      expect(isStaticSpeedSignal(0, 50, 'moving')).toBe(true);
    });

    it('#733 — accuracy noise는 positionStability fallback에도 적용', () => {
      expect(isStaticSpeedSignal(null, MAX_ACCURACY_M + 1, 'static')).toBe(false);
    });
  });

  describe('isFusionDowngradeTarget', () => {
    it('fusion 승격 라벨 4종 모두 true (#733: arrival-arriving 추가)', () => {
      expect(isFusionDowngradeTarget('position-train')).toBe(true);
      expect(isFusionDowngradeTarget('boarding-lock')).toBe(true);
      expect(isFusionDowngradeTarget('boarding-lock-interp')).toBe(true);
      expect(isFusionDowngradeTarget('arrival-arriving')).toBe(true);
    });

    it('그 외 라벨은 false', () => {
      expect(isFusionDowngradeTarget('gps-only')).toBe(false);
      expect(isFusionDowngradeTarget('arrival-confirmed')).toBe(false);
      expect(isFusionDowngradeTarget('route-progress')).toBe(false);
      expect(isFusionDowngradeTarget('unknown')).toBe(false);
    });
  });

  describe('shouldDowngradeFusion', () => {
    it('#1363 — 승격 라벨 + ≥2 정적 신호 합의면 true (consensus 게이트)', () => {
      // speed + motionStationary 합의
      expect(
        shouldDowngradeFusion({
          confidence: 'position-train',
          speedMps: 0,
          accuracyM: 50,
          motionStationary: true,
        }),
      ).toBe(true);
      // speed + positionStability 합의
      expect(
        shouldDowngradeFusion({
          confidence: 'boarding-lock',
          speedMps: 0.1,
          accuracyM: 30,
          positionStability: 'static',
        }),
      ).toBe(true);
      // motionStationary + positionStability 합의 (speed 미측정)
      expect(
        shouldDowngradeFusion({
          confidence: 'boarding-lock-interp',
          speedMps: null,
          accuracyM: 30,
          motionStationary: true,
          positionStability: 'static',
        }),
      ).toBe(true);
    });

    it('#1363 — single signal alone은 강등 안 함 (fu jumping 회귀 차단)', () => {
      // speed 단독 — motion/positionStability 미보고(warmup) → 보류
      expect(
        shouldDowngradeFusion({ confidence: 'position-train', speedMps: 0, accuracyM: 50 }),
      ).toBe(false);
      // motionStationary 단독 — speed null + positionStability 미보고
      expect(
        shouldDowngradeFusion({
          confidence: 'position-train',
          speedMps: null,
          accuracyM: 50,
          motionStationary: true,
        }),
      ).toBe(false);
      // positionStability 단독 — speed null + motion 미보고
      expect(
        shouldDowngradeFusion({
          confidence: 'arrival-arriving',
          speedMps: null,
          accuracyM: 50,
          positionStability: 'static',
        }),
      ).toBe(false);
    });

    it('#733 — arrival-arriving + 합의 정적 신호면 true (snapshot 2 회귀 fix)', () => {
      expect(
        shouldDowngradeFusion({
          confidence: 'arrival-arriving',
          speedMps: 0,
          accuracyM: 50,
          motionStationary: true,
        }),
      ).toBe(true);
    });

    it('승격 라벨이지만 정적 신호 아니면 false', () => {
      expect(
        shouldDowngradeFusion({ confidence: 'position-train', speedMps: 5, accuracyM: 50 }),
      ).toBe(false);
      // accuracy noise → 정적 신호 인정 안 함 (합의 신호여도 차단)
      expect(
        shouldDowngradeFusion({
          confidence: 'position-train',
          speedMps: 0,
          accuracyM: 1500,
          motionStationary: true,
          positionStability: 'static',
        }),
      ).toBe(false);
    });

    it('정적 신호여도 승격 라벨 아니면 false', () => {
      expect(
        shouldDowngradeFusion({
          confidence: 'gps-only',
          speedMps: 0,
          accuracyM: 50,
          motionStationary: true,
        }),
      ).toBe(false);
      expect(
        shouldDowngradeFusion({
          confidence: 'arrival-confirmed',
          speedMps: 0,
          accuracyM: 50,
          motionStationary: true,
        }),
      ).toBe(false);
    });

    it('#1363 — positionStability=moving이면 정적 후보가 1개여도 false', () => {
      expect(
        shouldDowngradeFusion({
          confidence: 'position-train',
          speedMps: 0,
          accuracyM: 50,
          positionStability: 'moving',
        }),
      ).toBe(false);
    });

    it('#1363 — motionStationary=false + speed 정적 단독은 false (consensus 미달)', () => {
      expect(
        shouldDowngradeFusion({
          confidence: 'position-train',
          speedMps: 0,
          accuracyM: 50,
          motionStationary: false,
        }),
      ).toBe(false);
    });
  });

  describe('#733 — evaluateMovement positionStability fallback', () => {
    it('speed 없음 + positionStability=static이면 reliable=false reason=static-position', () => {
      const m = evaluateMovement({ accuracyM: 50 }, undefined, 'static');
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('static-position');
    });

    it('speed 없음 + positionStability=moving이면 reliable=true', () => {
      const m = evaluateMovement({ accuracyM: 50 }, undefined, 'moving');
      expect(m.reliable).toBe(true);
    });

    it('speed 없음 + positionStability=unknown + motionStationary 미전달이면 warmup으로 차단 (#1013)', () => {
      // fg-hydrate 직후 warmup: motion=undefined + speed=null + position=unknown = 신호 부재 구간 차단.
      const m = evaluateMovement({ accuracyM: 50 }, undefined, 'unknown');
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('motion-warmup');
    });

    it('speed 없음 + positionStability=unknown + motionStationary=false이면 reliable=true (권한 거절 후 정상 경로)', () => {
      // motion 권한 거절로 motionStationary=false 고정 → warmup 조건 미충족 → gate 통과.
      const m = evaluateMovement({ accuracyM: 50 }, undefined, 'unknown', false);
      expect(m.reliable).toBe(true);
    });

    it('speed 없음 + positionStability 미전달이면 reliable=true (기존 동작 유지)', () => {
      const m = evaluateMovement({ accuracyM: 50 });
      expect(m.reliable).toBe(true);
    });

    it('speed 측정값 있으면 positionStability 무시 — speed가 우선', () => {
      // speed 정적 → static-speed (positionStability=moving이어도)
      const m1 = evaluateMovement({ speedMps: 0, accuracyM: 50 }, undefined, 'moving');
      expect(m1.reason).toBe('static-speed');
      // speed 이동 → reliable (positionStability=static이어도)
      const m2 = evaluateMovement({ speedMps: 5, accuracyM: 50 }, undefined, 'static');
      expect(m2.reliable).toBe(true);
    });
  });

  // #728 — CMMotionActivity motion=stationary 신호 가드.
  // 핵심 동기: 16:14:22 디바이스 로그의 station-passed | 용마산 회귀.
  // snapshot speed=0.69 m/s (느린 도보)로 STATIC_SPEED_THRESHOLD_MPS=0.5 우회 → 잘못 발사.
  // motion=stationary 신호로 임계값 우회 케이스를 잡는다. 또한 destination/transfer 카테고리도 보호.
  describe('#728 — evaluateMovement motionStationary 가드', () => {
    it('motionStationary=true이면 reliable=false reason=motion-stationary (다른 신호 정상)', () => {
      const now = 1_000_000;
      const m = evaluateMovement(
        { timestamp: now, accuracyM: 50, speedMps: 1.5 },
        now,
        undefined,
        true,
      );
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('motion-stationary');
    });

    it('motionStationary=true 임계 우회 케이스 (16:14:22 회귀) — speed=0.69 m/s 차단', () => {
      const now = 1_000_000;
      const m = evaluateMovement(
        { timestamp: now, accuracyM: 50, speedMps: 0.69 },
        now,
        undefined,
        true,
      );
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('motion-stationary');
    });

    it('motionStationary=false면 차단 안 함 (다른 신호 정상)', () => {
      const now = 1_000_000;
      const m = evaluateMovement(
        { timestamp: now, accuracyM: 50, speedMps: 1.5 },
        now,
        undefined,
        false,
      );
      expect(m.reliable).toBe(true);
    });

    it('motionStationary=undefined면 기존 동작 유지 (미전달 graceful fallback)', () => {
      const now = 1_000_000;
      const m = evaluateMovement(
        { timestamp: now, accuracyM: 50, speedMps: 1.5 },
        now,
      );
      expect(m.reliable).toBe(true);
    });

    it('평가 순서: stale > accuracy > motion-stationary > speed > position', () => {
      const now = 1_000_000;
      // stale 위반 + motionStationary=true → stale이 먼저 잡혀야 함
      const m1 = evaluateMovement(
        { timestamp: now - STALE_AGE_MS - 1, accuracyM: 50, speedMps: 5 },
        now,
        undefined,
        true,
      );
      expect(m1.reason).toBe('stale-timestamp');

      // accuracy 위반 + motionStationary=true → accuracy가 먼저
      const m2 = evaluateMovement(
        { timestamp: now, accuracyM: 999, speedMps: 5 },
        now,
        undefined,
        true,
      );
      expect(m2.reason).toBe('low-accuracy');

      // stale/accuracy 정상 + motionStationary=true + speed=0(static-speed도 위반) → motion이 먼저
      // (motion이 speed보다 우선 — 임계 우회 회귀 차단이 핵심 동기)
      const m3 = evaluateMovement(
        { timestamp: now, accuracyM: 50, speedMps: 0 },
        now,
        undefined,
        true,
      );
      expect(m3.reason).toBe('motion-stationary');

      // motionStationary=true + speed=null + positionStability=static → motion이 먼저
      const m4 = evaluateMovement(
        { timestamp: now, accuracyM: 50 },
        now,
        'static',
        true,
      );
      expect(m4.reason).toBe('motion-stationary');
    });
  });

  describe('#728 — isStaticSpeedSignal motionStationary fallback', () => {
    it('motionStationary=true이면 speed=null이어도 true (positionStability 없이)', () => {
      expect(isStaticSpeedSignal(null, 50, undefined, true)).toBe(true);
      expect(isStaticSpeedSignal(undefined, 50, undefined, true)).toBe(true);
    });

    it('motionStationary=true는 speed 정상값보다 약함 (speed가 우선)', () => {
      // speed=5 정상이면 motionStationary=true여도 false (fusion downgrade는 명확한 정적만)
      expect(isStaticSpeedSignal(5, 50, undefined, true)).toBe(false);
    });

    it('motionStationary=false + speed=null이면 false (보수)', () => {
      expect(isStaticSpeedSignal(null, 50, undefined, false)).toBe(false);
    });

    it('motionStationary=true이지만 accuracy noise면 false (지하 GPS 노이즈 보호)', () => {
      expect(isStaticSpeedSignal(null, MAX_ACCURACY_M + 1, undefined, true)).toBe(false);
    });

    it('motionStationary=true + positionStability=moving이면 true (motion이 우선)', () => {
      // speed 미측정인 경우 motion이 positionStability보다 우선 — OS 가속도계가 더 신뢰성 있음
      expect(isStaticSpeedSignal(null, 50, 'moving', true)).toBe(true);
    });
  });

  // #1013 — fg-hydrate warmup window 보호: motionStationary=undefined(초기화 중) +
  // speedMps=null + positionStability='unknown' 동시 발생 시 'motion-warmup' 차단.
  describe('#1013 — evaluateMovement motion-warmup 보호', () => {
    it('motionStationary=undefined + speed=null + positionStability=unknown → motion-warmup', () => {
      const m = evaluateMovement({ accuracyM: 50 }, undefined, 'unknown', undefined);
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('motion-warmup');
    });

    it('motionStationary=false + speed=null + positionStability=unknown → reliable=true (권한 거절은 warmup 아님)', () => {
      // motion 권한 거절로 false 고정: warmup 조건(undefined) 미충족 → gate 통과.
      const m = evaluateMovement({ accuracyM: 50 }, undefined, 'unknown', false);
      expect(m.reliable).toBe(true);
    });

    it('motionStationary=undefined + speedMps 있음 → warmup 조건 미충족 → speed 게이트로 평가', () => {
      // speed가 있으면 warmup 방어선 도달 전에 speed 게이트에서 처리.
      const mStatic = evaluateMovement({ speedMps: 0, accuracyM: 50 }, undefined, 'unknown', undefined);
      expect(mStatic.reason).toBe('static-speed');
      const mMoving = evaluateMovement({ speedMps: 5, accuracyM: 50 }, undefined, 'unknown', undefined);
      expect(mMoving.reliable).toBe(true);
    });

    it('motionStationary=undefined + speed=null + positionStability=moving → reliable=true (이동 확정)', () => {
      // positionStability가 'moving'이면 warmup 조건 미충족 → gate 통과.
      const m = evaluateMovement({ accuracyM: 50 }, undefined, 'moving', undefined);
      expect(m.reliable).toBe(true);
    });

    it('motionStationary=undefined + speed=null + positionStability 미전달 → reliable=true (기존 동작 유지)', () => {
      // positionStability가 undefined면 'unknown'과 다름 → warmup 미발동.
      const m = evaluateMovement({ accuracyM: 50 }, undefined, undefined, undefined);
      expect(m.reliable).toBe(true);
    });

    it('평가 순서: motion-warmup은 static-position보다 앞에 도달하지 않음 (static-position이 우선)', () => {
      // positionStability='static' → static-position이 먼저 (warmup 조건=unknown).
      const m = evaluateMovement({ accuracyM: 50 }, undefined, 'static', undefined);
      expect(m.reason).toBe('static-position');
    });

    it('MOVEMENT_TO_ALARM_LOG_REASON에 motion-warmup 포함', () => {
      expect(MOVEMENT_TO_ALARM_LOG_REASON['motion-warmup']).toBe('movement-motion-warmup');
    });
  });

  describe('#728/#1363 — shouldDowngradeFusion motionStationary + consensus', () => {
    it('승격 라벨 + motionStationary=true + positionStability=static (speed=null) → true', () => {
      expect(
        shouldDowngradeFusion({
          confidence: 'position-train',
          speedMps: null,
          accuracyM: 50,
          motionStationary: true,
          positionStability: 'static',
        }),
      ).toBe(true);
    });

    it('승격 라벨 아니면 합의 정적 신호여도 false', () => {
      expect(
        shouldDowngradeFusion({
          confidence: 'gps-only',
          speedMps: null,
          accuracyM: 50,
          motionStationary: true,
          positionStability: 'static',
        }),
      ).toBe(false);
    });

    it('승격 라벨 + motionStationary=false (다른 신호도 정상) → false', () => {
      expect(
        shouldDowngradeFusion({
          confidence: 'position-train',
          speedMps: 5,
          accuracyM: 50,
          motionStationary: false,
        }),
      ).toBe(false);
    });
  });

  // #1401 — 열차 진행(trainProgressing) 신호가 정적 가드 3종(motion-stationary / static-speed /
  // static-position)을 우회시키는지 검증. device 모션/GPS speed가 지하철 내부에서 불신뢰하므로
  // fusion arc advance가 확인되면 reliable=true로 통과.
  describe('#1401 — evaluateMovement trainProgressing 우회', () => {
    it('trainProgressing=true + motionStationary=true(임계 우회 phantom)면 reliable=true (motion-stationary 우회)', () => {
      // 16:14:22 phantom 회귀와 같은 조건 + 열차 진행 확인 → device 정적 신호 무시.
      const now = 1_000_000;
      const m = evaluateMovement(
        { timestamp: now, accuracyM: 50, speedMps: 0.69 },
        now,
        undefined,
        true, // motionStationary
        true, // trainProgressing
      );
      expect(m.reliable).toBe(true);
      expect(m.speedMps).toBe(0.69);
      expect(m.accuracyM).toBe(50);
    });

    it('trainProgressing=true + speedMps=0(static-speed)이면 reliable=true', () => {
      // GPS speed=0인데 열차 진행 확인 → device 정적 무시.
      const now = 1_000_000;
      const m = evaluateMovement(
        { timestamp: now, accuracyM: 50, speedMps: 0 },
        now,
        undefined,
        undefined,
        true,
      );
      expect(m.reliable).toBe(true);
      expect(m.speedMps).toBe(0);
    });

    it('trainProgressing=true + speedMps=null + positionStability=static이면 reliable=true (static-position 우회)', () => {
      // 역삼 13:37 회귀와 같은 조건: GPS speed null + position=static 정적 판정 → 열차 진행 확인 시 우회.
      const m = evaluateMovement(
        { accuracyM: 50 },
        undefined,
        'static',
        undefined,
        true,
      );
      expect(m.reliable).toBe(true);
    });

    it('trainProgressing=true + speedMps=null + motionStationary=true이면 reliable=true', () => {
      // CMMotionActivity stationary 동시 + fusion advance 확인 → 우회.
      const m = evaluateMovement(
        { accuracyM: 50 },
        undefined,
        undefined,
        true,
        true,
      );
      expect(m.reliable).toBe(true);
    });

    it('trainProgressing=true여도 stale-timestamp는 차단 유지 (GPS 신뢰성 분리)', () => {
      // GPS lock 자체가 stale → fusion advance가 노이즈일 수 있으므로 stale 가드 유지.
      const now = 2_000_000;
      const m = evaluateMovement(
        { timestamp: now - STALE_AGE_MS - 1, accuracyM: 50, speedMps: 0 },
        now,
        undefined,
        true,
        true,
      );
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('stale-timestamp');
    });

    it('trainProgressing=true여도 low-accuracy는 차단 유지', () => {
      // accuracy noise는 fusion advance와 무관하게 GPS 자체 신뢰 불가 → 가드 유지.
      const now = 1_000_000;
      const m = evaluateMovement(
        { timestamp: now, accuracyM: MAX_ACCURACY_M + 1, speedMps: 0 },
        now,
        undefined,
        true,
        true,
      );
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('low-accuracy');
    });

    it('trainProgressing=true여도 no-location은 차단 유지', () => {
      // loc=null이면 fusion advance 평가 자체 불가 → no-location 우선.
      const m = evaluateMovement(null, undefined, undefined, undefined, true);
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('no-location');
    });

    it('trainProgressing=false면 기존 동작 그대로 (motion-stationary 차단)', () => {
      // false 명시 시 우회 X → device 정적 가드 그대로 동작.
      const now = 1_000_000;
      const m = evaluateMovement(
        { timestamp: now, accuracyM: 50, speedMps: 0.69 },
        now,
        undefined,
        true,
        false,
      );
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('motion-stationary');
    });

    it('trainProgressing=undefined면 기존 동작 그대로 (기본값 graceful)', () => {
      // 호출자가 미전달이면 기존 호출자와 호환 — 정적 가드 그대로.
      const now = 1_000_000;
      const m = evaluateMovement(
        { timestamp: now, accuracyM: 50, speedMps: 0 },
        now,
      );
      expect(m.reliable).toBe(false);
      expect(m.reason).toBe('static-speed');
    });

    it('trainProgressing=true + loc 최소 필드(모두 미전달)면 reliable=true (선택 필드 미주입)', () => {
      // 우회 분기 안에서 result에 timestamp/accuracy/speed가 conditional로 들어가는 분기 커버.
      // loc={} → 모든 선택 필드 미전달 → result에 아무 신호도 첨부되지 않음.
      const m = evaluateMovement({}, undefined, undefined, undefined, true);
      expect(m.reliable).toBe(true);
      expect(m.speedMps).toBeUndefined();
      expect(m.accuracyM).toBeUndefined();
      expect(m.ageMs).toBeUndefined();
    });
  });

  describe('#1401 — isStaticSpeedSignal trainProgressing 우회', () => {
    it('trainProgressing=true이면 speedMps=0(정적)이어도 false', () => {
      // fusion downgrade 강등 금지 — 열차 진행 확인되면 정적 신호 무효.
      expect(isStaticSpeedSignal(0, 50, undefined, undefined, true)).toBe(false);
      expect(isStaticSpeedSignal(0.3, 50, undefined, undefined, true)).toBe(false);
    });

    it('trainProgressing=true이면 motionStationary=true여도 false', () => {
      expect(isStaticSpeedSignal(null, 50, undefined, true, true)).toBe(false);
    });

    it('trainProgressing=true이면 positionStability=static이어도 false', () => {
      expect(isStaticSpeedSignal(null, 50, 'static', undefined, true)).toBe(false);
    });

    it('trainProgressing=true여도 accuracy noise(>MAX_ACCURACY_M)면 false 유지 (accuracy 우선)', () => {
      // accuracy 노이즈는 GPS 자체 신뢰 불가 → fusion advance 무관 false (정적 신호도 false).
      expect(isStaticSpeedSignal(0, MAX_ACCURACY_M + 1, undefined, undefined, true)).toBe(false);
    });

    it('trainProgressing=false면 기존 동작 (정적 신호 그대로)', () => {
      expect(isStaticSpeedSignal(0, 50, undefined, undefined, false)).toBe(true);
    });

    it('trainProgressing=undefined면 기존 동작 (기본값 graceful)', () => {
      expect(isStaticSpeedSignal(0, 50)).toBe(true);
    });
  });

  describe('#1401 — shouldDowngradeFusion trainProgressing 우회', () => {
    it('승격 라벨 + 합의 정적 신호 + trainProgressing=true → false (강등 금지)', () => {
      // fu jumping과 비슷한 합의 정적 입력이지만 fusion advance 확인 → 강등 금지.
      expect(
        shouldDowngradeFusion({
          confidence: 'position-train',
          speedMps: 0,
          accuracyM: 50,
          motionStationary: true,
          trainProgressing: true,
        }),
      ).toBe(false);
      expect(
        shouldDowngradeFusion({
          confidence: 'boarding-lock-interp',
          speedMps: null,
          accuracyM: 50,
          motionStationary: true,
          positionStability: 'static',
          trainProgressing: true,
        }),
      ).toBe(false);
    });

    it('승격 라벨 + 합의 정적 신호 + trainProgressing=false → 기존 동작 (강등 적용)', () => {
      expect(
        shouldDowngradeFusion({
          confidence: 'position-train',
          speedMps: 0,
          accuracyM: 50,
          motionStationary: true,
          trainProgressing: false,
        }),
      ).toBe(true);
    });

    it('승격 라벨 + 합의 정적 신호 + trainProgressing=undefined → 기존 동작 (graceful)', () => {
      expect(
        shouldDowngradeFusion({
          confidence: 'position-train',
          speedMps: 0,
          accuracyM: 50,
          motionStationary: true,
        }),
      ).toBe(true);
    });

    it('trainProgressing=true여도 accuracy noise면 false (accuracy 가드 우선)', () => {
      // accuracy 가드는 trainProgressing 평가 전 — fusion advance와 무관하게 강등 보류 (기본 false).
      expect(
        shouldDowngradeFusion({
          confidence: 'position-train',
          speedMps: 0,
          accuracyM: 1500,
          motionStationary: true,
          trainProgressing: true,
        }),
      ).toBe(false);
    });
  });

  describe('#1357 (S1) — isStaticMovementResult', () => {
    it.each([
      ['motion-stationary' as const],
      ['static-speed' as const],
      ['static-position' as const],
    ])('정적 확정 reason "%s"에 대해 true', (reason) => {
      expect(isStaticMovementResult(reason)).toBe(true);
    });

    it.each([
      ['no-location' as const],
      ['stale-timestamp' as const],
      ['low-accuracy' as const],
      ['motion-warmup' as const],
    ])('정적 확정 아닌 reason "%s"에 대해 false', (reason) => {
      expect(isStaticMovementResult(reason)).toBe(false);
    });

    it('reason=undefined(reliable=true 결과)에 대해 false', () => {
      expect(isStaticMovementResult(undefined)).toBe(false);
    });
  });

  // ADR-022 Phase 4-3 (#2005) — arrival API SSoT flag guard 검증.
  // flag ON 시 evaluateMovement 가 loc/신호와 무관하게 { reliable: true } 를 반환해
  // motion gate 를 전면 bypass 하는지 확인. flag OFF (기본) 시 기존 로직 100% 유지.
  describe('evaluateMovement — arch flag guard (Phase 4-3)', () => {
    describe('flag OFF (기본) — 기존 로직 유지', () => {
      beforeEach(() => {
        disableArchFlag();
      });

      it('flag OFF + loc=null → 기존 no-location 판정 유지', () => {
        expect(evaluateMovement(null)).toEqual({ reliable: false, reason: 'no-location' });
      });

      it('flag OFF + motionStationary=true → 기존 motion-stationary 판정 유지', () => {
        const m = evaluateMovement({}, undefined, undefined, true);
        expect(m).toEqual({ reliable: false, reason: 'motion-stationary' });
      });

      it('flag OFF + speedMps < 임계 → 기존 static-speed 판정 유지', () => {
        const m = evaluateMovement({ speedMps: 0 });
        expect(m.reliable).toBe(false);
        expect(m.reason).toBe('static-speed');
      });
    });

    describe('flag ON — motion gate 전면 bypass (arrival API SSoT)', () => {
      beforeEach(() => {
        enableArchFlag();
      });

      it('flag ON + loc=null → no-location 대신 reliable=true', () => {
        expect(evaluateMovement(null)).toEqual({ reliable: true });
      });

      it('flag ON + motionStationary=true → motion-stationary 대신 reliable=true', () => {
        const m = evaluateMovement({}, undefined, undefined, true);
        expect(m).toEqual({ reliable: true });
      });

      it('flag ON + speedMps=0 (정적) → static-speed 대신 reliable=true', () => {
        const m = evaluateMovement({ speedMps: 0 });
        expect(m).toEqual({ reliable: true });
      });

      it('flag ON + positionStability=static → static-position 대신 reliable=true', () => {
        const m = evaluateMovement({}, undefined, 'static');
        expect(m).toEqual({ reliable: true });
      });

      it('flag ON + warmup 조건 (motion=undefined + speed=null + positionStability=unknown) → motion-warmup 대신 reliable=true', () => {
        const m = evaluateMovement({}, undefined, 'unknown', undefined);
        expect(m).toEqual({ reliable: true });
      });

      it('flag ON + stale timestamp → stale-timestamp 대신 reliable=true', () => {
        const now = 2_000_000;
        const m = evaluateMovement({ timestamp: now - STALE_AGE_MS - 1 }, now);
        expect(m).toEqual({ reliable: true });
      });

      it('flag ON + accuracyM > MAX_ACCURACY_M → low-accuracy 대신 reliable=true', () => {
        const m = evaluateMovement({ accuracyM: MAX_ACCURACY_M + 1 });
        expect(m).toEqual({ reliable: true });
      });

      it('flag ON + 모든 신호 정상 (기존에도 reliable=true) → reliable=true 유지', () => {
        const now = 1_000_000;
        const m = evaluateMovement(
          { timestamp: now - 5_000, accuracyM: 50, speedMps: 3 },
          now,
        );
        expect(m).toEqual({ reliable: true });
      });
    });
  });
});
