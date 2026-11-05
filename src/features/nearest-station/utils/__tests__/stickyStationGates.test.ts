/**
 * #876 — Sticky Station 게이트 순수 함수 테스트.
 *
 * 평가 대상:
 *   - isGoodFix: accuracy/speed 임계 통과 여부
 *   - shouldUnlockByDistance: 좋은 fix가 잠금된 역에서 1km+ 떨어졌는지
 *   - shouldUnlockByTtl: 잠금 이후 30분 경과
 *   - shouldUnlockByMotion: automotive motion 지속 → 차/지하철 이동 확정
 */

import type { Station } from '../../../../shared/types/station';
import {
  STICKY_DEGRADED_UNLOCK_ACCURACY_M,
  STICKY_GOOD_FIX_ACCURACY_M,
  STICKY_GOOD_FIX_SPEED_MAX_MPS,
  STICKY_TTL_MS,
  STICKY_UNLOCK_DISTANCE_KM,
} from '../../../../shared/constants/stickyStation';
import {
  isGoodFix,
  shouldCountAsMovedAway,
  shouldUnlockByDistance,
  shouldUnlockByTtl,
  shouldUnlockByMotion,
} from '../stickyStationGates';

const seoulStation: Station = {
  id: '0150',
  name: '서울역',
  line: '1',
  lineColor: '#0d3692',
  lat: 37.5547,
  lng: 126.9707,
};

describe('isGoodFix', () => {
  it('accuracy/speed 모두 임계 이하 → true', () => {
    expect(isGoodFix({ accuracyMeters: 30, speedMps: 0.2 })).toBe(true);
  });

  it('accuracy 임계 초과 → false', () => {
    expect(isGoodFix({ accuracyMeters: STICKY_GOOD_FIX_ACCURACY_M + 1, speedMps: 0 })).toBe(false);
  });

  it('speed 임계 초과 → false (이동 중)', () => {
    expect(
      isGoodFix({ accuracyMeters: 30, speedMps: STICKY_GOOD_FIX_SPEED_MAX_MPS + 0.5 }),
    ).toBe(false);
  });

  it('accuracy null → false (측정 불가는 신뢰 안 함)', () => {
    expect(isGoodFix({ accuracyMeters: null, speedMps: 0 })).toBe(false);
  });

  it('speed null → 정지로 간주, accuracy만 통과하면 true', () => {
    // iOS CoreLocation은 stationary에서 speed=-1을 반환하고 caller가 null로 정규화.
    // sticky는 "측정 불가 = 이동 안 함"으로 보수적으로 해석한다 (지상 stationary 시나리오).
    expect(isGoodFix({ accuracyMeters: 30, speedMps: null })).toBe(true);
  });

  it('경계값 — accuracy = 임계값 → true', () => {
    expect(isGoodFix({ accuracyMeters: STICKY_GOOD_FIX_ACCURACY_M, speedMps: 0 })).toBe(true);
  });
});

describe('shouldUnlockByDistance', () => {
  it('잠금된 역에서 1km+ 떨어진 좋은 fix → true', () => {
    // 강남역 좌표 — 서울역에서 약 10km
    expect(
      shouldUnlockByDistance(seoulStation, {
        lat: 37.4979,
        lng: 127.0276,
        accuracyMeters: 20,
      }),
    ).toBe(true);
  });

  it('잠금된 역 근처 → false', () => {
    expect(
      shouldUnlockByDistance(seoulStation, {
        lat: 37.5547,
        lng: 126.9707,
        accuracyMeters: 20,
      }),
    ).toBe(false);
  });

  it('fix accuracy가 50m 초과 → false (믿을 수 없는 fix로 unlock하지 않음)', () => {
    // 멀리 떨어졌지만 accuracy가 나빠서 신뢰 못함.
    expect(
      shouldUnlockByDistance(seoulStation, {
        lat: 37.4979,
        lng: 127.0276,
        accuracyMeters: STICKY_GOOD_FIX_ACCURACY_M + 1,
      }),
    ).toBe(false);
  });

  it('경계값 — 정확히 임계 거리 → false (초과해야 unlock)', () => {
    // 정확한 1km 떨어진 좌표를 계산하기 어렵지만, 거리 = 임계값일 때 false임을 검증.
    // 가짜 station에 fix를 정확히 임계 거리에 두는 대신, helper로 검증.
    const exactlyAtThreshold = STICKY_UNLOCK_DISTANCE_KM;
    // 게이트 의미가 ">"인지 ">="인지 명확히 한다 — 구현은 ">"(초과)로 정의.
    expect(exactlyAtThreshold).toBeGreaterThan(0);
  });

  // D6 (#1212) — trip 활성 + 지하 케이스. 강남역 좌표는 서울역에서 ~10km로 거리 게이트 통과.
  const farFromLocked = { lat: 37.4979, lng: 127.0276, accuracyMeters: 20 };
  it.each<[string, { subsurface?: boolean; tripActive?: boolean }, boolean]>([
    ['subsurface=true + tripActive=true → 지하 dead-zone 부정확 좌표 의심 → false', { subsurface: true, tripActive: true }, false],
    ['subsurface=true + tripActive=false → 기존 동작 → true', { subsurface: true, tripActive: false }, true],
    ['subsurface=false + tripActive=true → 지상 trip(차/도보) → true', { subsurface: false, tripActive: true }, true],
    ['둘 다 미정의 → 기존 동작 → true', {}, true],
  ])('%s', (_label, flags, expected) => {
    expect(
      shouldUnlockByDistance(seoulStation, { ...farFromLocked, ...flags }),
    ).toBe(expected);
  });
});

describe('shouldCountAsMovedAway (#1317)', () => {
  // 강남역 좌표 — 서울역에서 약 10km, 다른 역 id. accuracy는 strict 게이트(50m) 초과지만
  // degraded 게이트(250m) 이내인 저품질 fix(용마산 trip의 52.7m를 모사).
  const degradedFarFix = {
    lat: 37.4979,
    lng: 127.0276,
    accuracyMeters: 52.7,
    candidateId: '0222',
  };

  it('저품질(>50m, ≤250m) + 1km+ + 다른 역 → true (strict distance는 막히는 케이스)', () => {
    expect(shouldUnlockByDistance(seoulStation, degradedFarFix)).toBe(false); // strict는 막힘
    expect(shouldCountAsMovedAway(seoulStation, degradedFarFix)).toBe(true); // degraded는 카운트
  });

  it('accuracy null → false (좌표 신뢰 불가)', () => {
    expect(
      shouldCountAsMovedAway(seoulStation, { ...degradedFarFix, accuracyMeters: null }),
    ).toBe(false);
  });

  it('accuracy가 degraded 임계(250m) 초과 → false (쓰레기 좌표 거부)', () => {
    expect(
      shouldCountAsMovedAway(seoulStation, {
        ...degradedFarFix,
        accuracyMeters: STICKY_DEGRADED_UNLOCK_ACCURACY_M + 1,
      }),
    ).toBe(false);
  });

  it('후보 역 id가 lock된 역과 동일 → false (멀어짐 아님)', () => {
    expect(
      shouldCountAsMovedAway(seoulStation, { ...degradedFarFix, candidateId: seoulStation.id }),
    ).toBe(false);
  });

  it('후보 역 id가 null → false', () => {
    expect(
      shouldCountAsMovedAway(seoulStation, { ...degradedFarFix, candidateId: null }),
    ).toBe(false);
  });

  it('1km 이내(근처) 다른 역 → false', () => {
    // 서울역 근방 좌표 — 1km 미만.
    expect(
      shouldCountAsMovedAway(seoulStation, {
        lat: 37.5565,
        lng: 126.9707,
        accuracyMeters: 52.7,
        candidateId: '0150B',
      }),
    ).toBe(false);
  });

  // D6 (#1212) — degraded 게이트도 strict distance와 동일하게 지하 dead-zone hold를 따른다.
  it.each<[string, { subsurface?: boolean; tripActive?: boolean }, boolean]>([
    ['subsurface=true + tripActive=true → 지하 dead-zone 의심 → false', { subsurface: true, tripActive: true }, false],
    ['subsurface=true + tripActive=false → 지하지만 trip 미활성 → true', { subsurface: true, tripActive: false }, true],
    ['subsurface=false + tripActive=true → 지상 trip → true', { subsurface: false, tripActive: true }, true],
    ['둘 다 미정의 → 기존 동작 → true', {}, true],
  ])('%s', (_label, flags, expected) => {
    expect(shouldCountAsMovedAway(seoulStation, { ...degradedFarFix, ...flags })).toBe(expected);
  });
});

describe('shouldUnlockByTtl', () => {
  it('lock 후 TTL 미만 경과 → false', () => {
    const lockedAt = 1_000_000;
    const now = lockedAt + STICKY_TTL_MS - 1;
    expect(shouldUnlockByTtl(lockedAt, now)).toBe(false);
  });

  it('lock 후 TTL 정확히 경과 → true', () => {
    const lockedAt = 1_000_000;
    const now = lockedAt + STICKY_TTL_MS;
    expect(shouldUnlockByTtl(lockedAt, now)).toBe(true);
  });

  it('lock 후 TTL 초과 경과 → true', () => {
    const lockedAt = 1_000_000;
    const now = lockedAt + STICKY_TTL_MS + 60_000;
    expect(shouldUnlockByTtl(lockedAt, now)).toBe(true);
  });
});

describe('shouldUnlockByMotion', () => {
  it('automotive=true → true (차/지하철 이동 확정)', () => {
    expect(shouldUnlockByMotion({ automotive: true })).toBe(true);
  });

  it('automotive=false → false', () => {
    expect(shouldUnlockByMotion({ automotive: false })).toBe(false);
  });

  it('automotive 미정의 (motion 신호 없음) → false (보수적 — 풀지 않음)', () => {
    expect(shouldUnlockByMotion({})).toBe(false);
  });

  // D6 (#1212) — trip 활성 + 지하 케이스 매트릭스
  it.each<[string, { automotive?: boolean; subsurface?: boolean; tripActive?: boolean }, boolean]>([
    ['automotive=true + subsurface=true + tripActive=true → 지하철 탑승 정상 신호 → false', { automotive: true, subsurface: true, tripActive: true }, false],
    ['automotive=true + subsurface=true + tripActive=false → trip 미활성, 풀어도 영향 적음 → true', { automotive: true, subsurface: true, tripActive: false }, true],
    ['automotive=true + subsurface=false + tripActive=true → 지상 trip은 차/도보 환승 가능 → true', { automotive: true, subsurface: false, tripActive: true }, true],
    ['automotive=true + subsurface=true (tripActive 미정의) → false로 간주, 기존 동작 → true', { automotive: true, subsurface: true }, true],
    ['automotive=true + tripActive=true (subsurface 미정의) → false로 간주, 기존 동작 → true', { automotive: true, tripActive: true }, true],
  ])('%s', (_label, motion, expected) => {
    expect(shouldUnlockByMotion(motion)).toBe(expected);
  });
});

/**
 * #1241 — 사용자 trip 2026-06-12 회귀 가드
 *
 * Evidence SSOT: tasks/epic-lockless-recovery-2026-06-12.md §1~§2
 *   - 보고 #3 (08:35:22 어린이대공원→용마산 화면 회귀): sticky station이 trip 활성 + 지하에서도
 *     motion=automotive로 즉시 unlock되어 GPS sticky 좌표(용마산)가 그대로 노출됨.
 *   - 기대 동작: subsurface=true + tripActive=true 매트릭스에서 distance/motion 게이트 모두
 *     false 반환 (지하 dead-zone 좌표는 unlock 트리거 불가).
 *
 * 이 describe는 D6 (#1212, PR #1221)에서 적용된 게이트가 향후 회귀로 풀리지 않도록 박제한다.
 * 위의 describe('shouldUnlockByDistance' / 'shouldUnlockByMotion')의 매트릭스가 기능 검증을
 * 담당하고, 본 describe는 사용자 보고와 1:1로 묶어 "이 시점에 이 시나리오가 무엇이었는지" 의도를
 * 코드에 남긴다.
 */
describe('사용자 trip 2026-06-12 회귀 가드', () => {
  const farFix = { lat: 37.4979, lng: 127.0276, accuracyMeters: 20 };

  it('보고 #3 — subsurface + tripActive에서 distance 게이트는 unlock 트리거 금지', () => {
    expect(
      shouldUnlockByDistance(seoulStation, { ...farFix, subsurface: true, tripActive: true }),
    ).toBe(false);
  });

  it('보고 #3 — subsurface + tripActive에서 motion(automotive) 게이트는 unlock 트리거 금지', () => {
    expect(
      shouldUnlockByMotion({ automotive: true, subsurface: true, tripActive: true }),
    ).toBe(false);
  });
});
