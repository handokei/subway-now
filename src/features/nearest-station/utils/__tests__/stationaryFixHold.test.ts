/**
 * #3191 PR-1 — shouldHoldStationaryFix 단위 table 테스트.
 *
 * 입력 값은 10/21 실측(tasks/rca-2026-10-21-sagajeong-jump.md §1 표 행 1~5, plan §7)에서
 * 그대로 가져왔다 — 통과시키려고 조정 금지.
 *  - T L635-633: L=21:25:25 (acc 8, speed null). 행1~4 = fix age 16 / 24 / 28 / 139s.
 *  - T L616: L=21:30:15 (acc 5). 행5 = fix age 15s.
 * 거부 행: plan §7 "거부되어야 하는 행"(F9 acc 44, 5B/E7 acc 50, B #8 acc 61, T 오전 L882 13.9 m/s,
 * E7 06:29:33 lookback) + 하강(sub=true) + 새 fix.
 */
import { shouldHoldStationaryFix, type StationaryHoldInput } from '../stationaryFixHold';
import {
  STATIONARY_HOLD_BARO_LOOKBACK_MS,
  STATIONARY_HOLD_MAX_ACCURACY_M,
  STATIONARY_HOLD_MAX_SPEED_MPS,
} from '../../../../shared/constants/stationaryFixHold';

const L_AT = 1_700_000_000_000;

function input(extra: Partial<StationaryHoldInput> = {}): StationaryHoldInput {
  return {
    fix: { accuracyMeters: 8, speedMps: null, atMs: L_AT },
    hasNewerFix: false,
    subsurface: false,
    baroEventAtMs: null,
    barometerAvailable: true,
    lockActive: false,
    ...extra,
  };
}

describe('shouldHoldStationaryFix (#3191 PR-1)', () => {
  it('상수: 30m / 0.5 m/s / 3분', () => {
    expect(STATIONARY_HOLD_MAX_ACCURACY_M).toBe(30);
    expect(STATIONARY_HOLD_MAX_SPEED_MPS).toBe(0.5);
    expect(STATIONARY_HOLD_BARO_LOOKBACK_MS).toBe(180_000);
  });

  describe('10/21 실측 긍정 행 — 유지=true', () => {
    it.each([
      ['T 행1 21:25:41 (age 16s)', { accuracyMeters: 8, speedMps: null }],
      ['T 행2 21:25:49 (age 24s)', { accuracyMeters: 8, speedMps: null }],
      ['T 행3 21:25:53 (age 28s)', { accuracyMeters: 8, speedMps: null }],
      ['T 행4 21:27:44 (age 139s)', { accuracyMeters: 8, speedMps: null }],
      ['T 행5 21:30:30 (L 21:30:15 acc 5, age 15s)', { accuracyMeters: 5, speedMps: null }],
    ])('%s', (_label, fix) => {
      // 나이(age)는 술어 입력이 아니다 — 라벨의 age가 어떻든 이동 증거가 없으면 유지.
      expect(shouldHoldStationaryFix(input({ fix: { ...fix, atMs: L_AT } }))).toBe(true);
    });
  });

  describe('거부 — 유지=false', () => {
    it('새 fix가 들어왔다 (행 직후 fresh fix)', () => {
      expect(shouldHoldStationaryFix(input({ hasNewerFix: true }))).toBe(false);
    });

    it('기압 하강 중 (subsurface===true)', () => {
      expect(shouldHoldStationaryFix(input({ subsurface: true }))).toBe(false);
    });

    it('fix 정보가 없다', () => {
      expect(shouldHoldStationaryFix(input({ fix: null }))).toBe(false);
    });

    it.each([
      ['F9 acc 44', 44],
      ['5B/E7 acc 50', 50],
      ['B #8 acc 61', 61],
      ['경계 30m 초과 30.1', 30.1],
    ])('정확도 초과 — %s', (_l, accuracyMeters) => {
      expect(
        shouldHoldStationaryFix(input({ fix: { accuracyMeters, speedMps: null, atMs: L_AT } })),
      ).toBe(false);
    });

    it('정확도 null', () => {
      expect(
        shouldHoldStationaryFix(input({ fix: { accuracyMeters: null, speedMps: null, atMs: L_AT } })),
      ).toBe(false);
    });

    it.each([
      ['T 오전 L882 13.9 m/s', 13.9],
      ['경계 0.5 m/s', 0.5],
    ])('속도 초과 — %s', (_l, speedMps) => {
      expect(
        shouldHoldStationaryFix(input({ fix: { accuracyMeters: 8, speedMps, atMs: L_AT } })),
      ).toBe(false);
    });

    it('기압 이벤트가 L 직전 3분 이내 (E7 06:29:33 → L 06:29:34, 1초 전)', () => {
      expect(shouldHoldStationaryFix(input({ baroEventAtMs: L_AT - 1_000 }))).toBe(false);
    });

    it('기압 이벤트가 L 이후 (K 06:29–06:31 상승)', () => {
      expect(shouldHoldStationaryFix(input({ baroEventAtMs: L_AT + 10_000 }))).toBe(false);
    });

    it('lookback 경계: 정확히 L-3분 이벤트는 증거', () => {
      expect(
        shouldHoldStationaryFix(input({ baroEventAtMs: L_AT - STATIONARY_HOLD_BARO_LOOKBACK_MS })),
      ).toBe(false);
    });

    it('기압계가 볼 수 없는 상태 (unavailable / 워밍업)', () => {
      expect(shouldHoldStationaryFix(input({ barometerAvailable: false }))).toBe(false);
    });

    it('lock 활성 (PR-3 범위 밖 — 현행 유지)', () => {
      expect(shouldHoldStationaryFix(input({ lockActive: true }))).toBe(false);
    });
  });

  describe('허용 경계', () => {
    it('정확도 정확히 30m / 속도 0 / 기압 이벤트가 L-3분보다 1ms 전이면 유지', () => {
      expect(
        shouldHoldStationaryFix(
          input({
            fix: { accuracyMeters: 30, speedMps: 0, atMs: L_AT },
            baroEventAtMs: L_AT - STATIONARY_HOLD_BARO_LOOKBACK_MS - 1,
          }),
        ),
      ).toBe(true);
    });

    it('speed 0.49 유지', () => {
      expect(
        shouldHoldStationaryFix(input({ fix: { accuracyMeters: 8, speedMps: 0.49, atMs: L_AT } })),
      ).toBe(true);
    });
  });
});
