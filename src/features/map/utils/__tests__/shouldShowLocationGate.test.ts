import { shouldShowLocationGate } from '../shouldShowLocationGate';

const ok = { permissionDenied: false, loading: false, userLocation: { lat: 1, lng: 2 }, error: null };
const cases: [string, typeof ok | Record<string, unknown>][] = [
  ['permissionDenied', { ...ok, permissionDenied: true }],
  ['loading', { ...ok, loading: true }],
  ['위치 없음', { ...ok, userLocation: null }],
  ['error', { ...ok, error: 'x' }],
];

describe('shouldShowLocationGate', () => {
  it('지도 모드: 정상이면 게이트 없음', () => {
    expect(shouldShowLocationGate('map', ok)).toBe(false);
  });

  it.each(cases)('지도 모드: %s → 게이트(기존 동작 불변)', (_n, input) => {
    expect(shouldShowLocationGate('map', input as never)).toBe(true);
  });

  it.each(cases)('노선도 모드: %s여도 게이트 우회', (_n, input) => {
    expect(shouldShowLocationGate('schematic', input as never)).toBe(false);
  });
});
