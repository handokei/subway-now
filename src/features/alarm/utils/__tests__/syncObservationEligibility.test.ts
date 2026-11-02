import { isSyncObservationEligible } from '../syncObservationEligibility';
import type { FusionSource } from '../../../../shared/types/fusion';

/**
 * #3191 PR-S — 표시용 현재역이 backend 판단 입력(/boarding-lock/sync 관측역)으로 새는 것을 차단.
 * 실측 행(덤프 텍스트-3DCCD7F760F6-1.txt L623, 텍스트-AB2FB85C916A-1.txt L633)은 source·fix 시각 차를
 * 원문 그대로 옮겼고, 그 외 입력은 "합성" 라벨.
 */
const NOW = 1_800_000_000_000;
const at = (ageMs: number) => NOW - ageMs;

describe('isSyncObservationEligible (#3191 PR-S)', () => {
  it('실측 10/31 09:37:38 사가정 행 — source=arrival, fix 09:37:23(15s 묵음), acc 86 → 미송신', () => {
    expect(isSyncObservationEligible({ source: 'arrival', lastFixAtMs: at(15_000), nowMs: NOW })).toBe(false);
  });

  it('실측 11/02 19:44:34 성수 행 — source=position, fix 19:44:18(16s 묵음), acc 19 → 미송신', () => {
    expect(isSyncObservationEligible({ source: 'position', lastFixAtMs: at(16_000), nowMs: NOW })).toBe(false);
  });

  it('합성: 신선 fix(5s) 정상 이동은 source가 gps여도 arrival이어도 송신', () => {
    expect(isSyncObservationEligible({ source: 'gps', lastFixAtMs: at(5_000), nowMs: NOW })).toBe(true);
    expect(isSyncObservationEligible({ source: 'arrival', lastFixAtMs: at(5_000), nowMs: NOW })).toBe(true);
  });

  it('합성: 묵은 fix여도 WiFi SSID 출처는 송신 (GPS 무관 확정)', () => {
    expect(isSyncObservationEligible({ source: 'wifi-ssid', lastFixAtMs: at(600_000), nowMs: NOW })).toBe(true);
  });

  it('합성: 묵은 fix여도 lock 출처(boarding-lock / boarding-lock-interp)는 송신', () => {
    expect(isSyncObservationEligible({ source: 'boarding-lock', lastFixAtMs: at(600_000), nowMs: NOW })).toBe(true);
    expect(isSyncObservationEligible({ source: 'boarding-lock-interp', lastFixAtMs: null, nowMs: NOW })).toBe(true);
  });

  it('합성: fix 시각 없음(null)은 신선 증명 불가 → GPS 출처 미송신', () => {
    expect(isSyncObservationEligible({ source: 'gps', lastFixAtMs: null, nowMs: NOW })).toBe(false);
  });

  it.each<FusionSource>(['backend-ssot', 'position-train', 'position', 'arrival', 'route-progress', 'gps'])(
    '합성: 묵은 fix + %s → 미송신 (backend-ssot는 backend 값의 되먹임이라 자격 없음)',
    (source) => {
      expect(isSyncObservationEligible({ source, lastFixAtMs: at(20_000), nowMs: NOW })).toBe(false);
    },
  );

  it('경계: 나이 14_999ms는 신선, 15_000ms는 묵음 (GPS_QUALITY_GATE_MAX_AGE_MS와 동일)', () => {
    expect(isSyncObservationEligible({ source: 'gps', lastFixAtMs: at(14_999), nowMs: NOW })).toBe(true);
    expect(isSyncObservationEligible({ source: 'gps', lastFixAtMs: at(15_000), nowMs: NOW })).toBe(false);
  });
});
