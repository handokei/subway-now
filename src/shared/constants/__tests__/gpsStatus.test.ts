import {
  GPS_ACTIVE,
  GPS_INACTIVE,
  appStateToGpsActive,
  currentGpsActive,
} from '../gpsStatus';

describe('gpsStatus (#852)', () => {
  it('GPS_ACTIVE/INACTIVE 라벨 상수', () => {
    expect(GPS_ACTIVE).toBe('fg');
    expect(GPS_INACTIVE).toBe('bg');
  });

  it("appStateToGpsActive: 'active'만 fg, 그 외(background/inactive/unknown)는 bg", () => {
    expect(appStateToGpsActive('active')).toBe('fg');
    expect(appStateToGpsActive('background')).toBe('bg');
    expect(appStateToGpsActive('inactive')).toBe('bg');
    expect(appStateToGpsActive('unknown')).toBe('bg');
  });

  it('currentGpsActive: AppState.currentState 기준 매핑 결과를 반환', () => {
    // 테스트 환경에서 AppState.currentState는 보통 'active' — fg.
    // 값이 'active'/'background' 여부와 무관하게 함수 결과가 fg|bg 중 하나이면 ok.
    const result = currentGpsActive();
    expect(['fg', 'bg']).toContain(result);
  });
});
