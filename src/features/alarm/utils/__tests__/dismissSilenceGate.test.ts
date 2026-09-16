import { evaluateDismissSilence } from '../dismissSilenceGate';
import {
  DISMISS_SILENCE_MS,
  DISMISS_SILENCE_RADIUS_M,
} from '../../../../shared/constants/alarmSilence';

const SEOUL = { lat: 37.5665, lng: 126.978 };

describe('evaluateDismissSilence', () => {
  it('state가 null이면 silence 없음, expired=false', () => {
    const decision = evaluateDismissSilence(null, 1_000, SEOUL);
    expect(decision).toEqual({ silenced: false, expired: false });
  });

  it('5분 미만 + 좌표 미공급(state null lat/lng)이면 시간만 평가해 silenced=true', () => {
    const state = { sinceTs: 0, sinceLat: null, sinceLng: null };
    const decision = evaluateDismissSilence(state, DISMISS_SILENCE_MS - 1, null);
    expect(decision).toEqual({ silenced: true });
  });

  it('5분 미만 + state 좌표 + 현재 좌표 동일이면 silenced=true', () => {
    const state = { sinceTs: 0, sinceLat: SEOUL.lat, sinceLng: SEOUL.lng };
    const decision = evaluateDismissSilence(state, 60_000, SEOUL);
    expect(decision).toEqual({ silenced: true });
  });

  it('정확히 5분 경과면 시간 만료 — silenced=false, expired=true', () => {
    const state = { sinceTs: 0, sinceLat: null, sinceLng: null };
    const decision = evaluateDismissSilence(state, DISMISS_SILENCE_MS, null);
    expect(decision).toEqual({ silenced: false, expired: true });
  });

  it('5분 초과면 시간 만료', () => {
    const state = { sinceTs: 0, sinceLat: SEOUL.lat, sinceLng: SEOUL.lng };
    const decision = evaluateDismissSilence(state, DISMISS_SILENCE_MS + 1, SEOUL);
    expect(decision).toEqual({ silenced: false, expired: true });
  });

  it('200m 이상 이동하면 거리 만료', () => {
    // 위도 1도 ≈ 111km → 0.003도 ≈ 333m
    const state = { sinceTs: 0, sinceLat: SEOUL.lat, sinceLng: SEOUL.lng };
    const farther = { lat: SEOUL.lat + 0.003, lng: SEOUL.lng };
    const decision = evaluateDismissSilence(state, 60_000, farther);
    expect(decision).toEqual({ silenced: false, expired: true });
  });

  it('200m 미만 이동 + 시간 미경과면 여전히 silenced', () => {
    // 0.001도 ≈ 111m
    const state = { sinceTs: 0, sinceLat: SEOUL.lat, sinceLng: SEOUL.lng };
    const closer = { lat: SEOUL.lat + 0.001, lng: SEOUL.lng };
    const decision = evaluateDismissSilence(state, 60_000, closer);
    expect(decision).toEqual({ silenced: true });
  });

  it('state에 좌표 있지만 현재 좌표 null이면 거리 평가 skip — 시간만 본다', () => {
    const state = { sinceTs: 0, sinceLat: SEOUL.lat, sinceLng: SEOUL.lng };
    const decision = evaluateDismissSilence(state, 60_000, null);
    expect(decision).toEqual({ silenced: true });
  });

  it('200m + 1cm 거리 = 거리 만료(>= 임계)', () => {
    // 위도 1도 ≈ 111.19km/도. 임계 + 0.01m 만큼만 띄워 부동소수 부정확성에 안전한 경계 케이스.
    const metersPerDegree = 111_194.93;
    const deltaLat = (DISMISS_SILENCE_RADIUS_M + 0.01) / metersPerDegree;
    const state = { sinceTs: 0, sinceLat: SEOUL.lat, sinceLng: SEOUL.lng };
    const justOver = { lat: SEOUL.lat + deltaLat, lng: SEOUL.lng };
    const decision = evaluateDismissSilence(state, 60_000, justOver);
    expect(decision).toEqual({ silenced: false, expired: true });
  });
});
