import { shouldSsotOverrideCustomOrigin } from '../shouldSsotOverrideCustomOrigin';
import type { Station } from '../../shared/types/station';

// #2826 — 지도탭에서 출발역을 직접 설정(customOrigin)해도 fusion SSOT가 강 confidence로
// 다른 역(예: 용마산)을 가리키면 #1541 override가 방금 설정한 customOrigin을 즉시 unlock해
// stuck 회귀가 재발한다. 원 #1541 의도는 "trip 진행 중" stuck 차단이지 planning 단계
// (trip 시작 전, inTrip=false) clobber가 아니다.
//
// shouldSsotOverrideCustomOrigin는 이 판정을 HomeScreen에서 분리한 순수 predicate로,
// inTrip=false일 때는 override를 거부해야 한다.
describe('shouldSsotOverrideCustomOrigin', () => {
  const customOrigin: Station = { id: 'X', name: 'X역', line: '7', lineColor: '#000', lat: 0, lng: 0 };
  const ssotStation: Station = { id: 'Y', name: '용마산', line: '7', lineColor: '#000', lat: 0, lng: 0 };

  it('RED 보호: customOrigin 설정 + 강 confidence + inTrip=false → override 미적용 (X 유지)', () => {
    const result = shouldSsotOverrideCustomOrigin({
      customOrigin,
      ssotStation,
      confidence: 'arrival-confirmed',
      inTrip: false,
    });

    // 실패 사유까지 assert: inTrip=false인데 override 발생하면 이 값이 true가 되어 실패한다.
    expect(result).toBe(false);
  });

  it('inTrip=true → override 적용 (trip 중 stuck 차단, 원 #1541 의도 보존)', () => {
    const result = shouldSsotOverrideCustomOrigin({
      customOrigin,
      ssotStation,
      confidence: 'arrival-confirmed',
      inTrip: true,
    });

    expect(result).toBe(true);
  });

  it('cold-start(customOrigin=null) → override 불필요 (false)', () => {
    const result = shouldSsotOverrideCustomOrigin({
      customOrigin: null,
      ssotStation,
      confidence: 'arrival-confirmed',
      inTrip: false,
    });

    expect(result).toBe(false);
  });

  it('ssotStation=null → override 불가 (false)', () => {
    const result = shouldSsotOverrideCustomOrigin({
      customOrigin,
      ssotStation: null,
      confidence: 'arrival-confirmed',
      inTrip: true,
    });

    expect(result).toBe(false);
  });

  it('약 confidence(gps-only) → override 미적용', () => {
    const result = shouldSsotOverrideCustomOrigin({
      customOrigin,
      ssotStation,
      confidence: 'gps-only',
      inTrip: true,
    });

    expect(result).toBe(false);
  });

  it('customOrigin === ssotStation(동일 역) → override 불필요', () => {
    const result = shouldSsotOverrideCustomOrigin({
      customOrigin,
      ssotStation: customOrigin,
      confidence: 'arrival-confirmed',
      inTrip: true,
    });

    expect(result).toBe(false);
  });
});
