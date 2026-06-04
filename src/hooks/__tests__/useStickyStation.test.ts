/**
 * #876 — useStickyStation 훅 테스트.
 *
 * 동작:
 *   1. 좋은 fix(accuracy ≤ 50m, speed < 1 m/s) + 같은 역 N(=3)회 연속 → lock
 *   2. lock 상태에서 매 fix마다 unlock 평가:
 *      - 좋은 fix(≤50m)가 lock된 역에서 1km+ → unlock-distance
 *      - automotive motion → unlock-motion
 *      - TTL 30분 경과 → unlock-ttl
 *      - 더 좋은 fix(≤50m)가 N(=3)회 연속 다른 역 → 즉시 갱신(unlock-better-fix + lock 새 역)
 *   3. AsyncStorage persist — 앱 재시작 시 hydrate
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderHook, waitFor } from '@testing-library/react-native';
import { useStickyStation, type StickyFixInput, type StickyMotionInput } from '../useStickyStation';
import { STICKY_TTL_MS } from '../../constants/stickyStation';
import { STICKY_STATION_KEY } from '../../constants/storageKeys';
import * as fusionDebugBuffer from '../../utils/fusionDebugBuffer';
import type { Station } from '../../types/station';

interface RenderProps { fix: StickyFixInput; motion?: StickyMotionInput }
const renderSticky = (initialProps: RenderProps) =>
  renderHook(({ fix, motion }: RenderProps) => useStickyStation(fix, motion), { initialProps });

const seoul: Station = {
  id: '0150', name: '서울역', line: '1', lineColor: '#0d3692', lat: 37.5547, lng: 126.9707,
};
// 서울역 근방(~200m) 가상 인접역 — better-fix 전이를 distance unlock과 분리해 검증.
const seoulNearby: Station = {
  id: '0150B', name: '서울역인접', line: '4', lineColor: '#00a4e3',
  lat: 37.5565, lng: 126.9707,
};
const gangnam: Station = {
  id: '0222', name: '강남', line: '2', lineColor: '#00a84d', lat: 37.4979, lng: 127.0276,
};

const fixAt = (
  station: Station | null,
  opts: { accuracy?: number | null; speed?: number | null } = {},
) => ({
  candidate: station ? { station, distanceKm: 0.05 } : null,
  accuracyMeters: opts.accuracy ?? 20,
  speedMps: opts.speed ?? 0,
});

describe('useStickyStation (#876)', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await AsyncStorage.clear();
    // hydrate 시 setItem 호출은 측정에서 분리하기 위해 spy clear는 hydrate 후 각 it 안에서.
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('초기 상태 — locked=null', async () => {
    const { result } = renderHook(() => useStickyStation(fixAt(null)));
    expect(result.current.locked).toBeNull();
  });

  it('좋은 fix가 같은 역 3회 연속 → lock', async () => {
    const pushSpy = jest.spyOn(fusionDebugBuffer, 'pushFusionDebugEntry');
    const { result, rerender } = renderSticky({ fix: fixAt(seoul) });
    // hydrate effect 대기
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(STICKY_STATION_KEY));
    expect(result.current.locked).toBeNull();
    rerender({ fix: fixAt(seoul) });
    expect(result.current.locked).toBeNull();
    rerender({ fix: fixAt(seoul) });
    // 3회째에 lock
    await waitFor(() => expect(result.current.locked?.id).toBe(seoul.id));
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'sticky', event: 'locked', stationName: '서울역' }),
    );
  });

  it('나쁜 fix(accuracy > 50m)는 카운트 안 함', async () => {
    const { result, rerender } = renderSticky({ fix: fixAt(seoul, { accuracy: 80 }) });
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    rerender({ fix: fixAt(seoul, { accuracy: 80 }) });
    rerender({ fix: fixAt(seoul, { accuracy: 80 }) });
    rerender({ fix: fixAt(seoul, { accuracy: 80 }) });
    expect(result.current.locked).toBeNull();
  });

  it('이동 중(speed ≥ 1) fix는 카운트 안 함', async () => {
    const { result, rerender } = renderSticky({ fix: fixAt(seoul, { speed: 5 }) });
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    rerender({ fix: fixAt(seoul, { speed: 5 }) });
    rerender({ fix: fixAt(seoul, { speed: 5 }) });
    expect(result.current.locked).toBeNull();
  });

  it('다른 역으로 바뀌면 카운트 리셋', async () => {
    const { result, rerender } = renderSticky({ fix: fixAt(seoul) });
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    rerender({ fix: fixAt(seoul) });
    rerender({ fix: fixAt(seoulNearby) }); // 카운트 리셋
    rerender({ fix: fixAt(seoulNearby) });
    expect(result.current.locked).toBeNull();
    rerender({ fix: fixAt(seoulNearby) });
    await waitFor(() => expect(result.current.locked?.id).toBe(seoulNearby.id));
  });

  it('locked 상태에서 좋은 fix가 1km+ 떨어진 다른 역 → unlock-distance', async () => {
    const pushSpy = jest.spyOn(fusionDebugBuffer, 'pushFusionDebugEntry');
    const { result, rerender } = renderSticky({ fix: fixAt(seoul) });
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    rerender({ fix: fixAt(seoul) });
    rerender({ fix: fixAt(seoul) });
    await waitFor(() => expect(result.current.locked?.id).toBe(seoul.id));
    pushSpy.mockClear();

    // 강남역(10km+) 좋은 fix 1회 → unlock (다른 역으로 lock 갱신은 N회 필요하지만 unlock-distance는 즉시)
    rerender({ fix: fixAt(gangnam) });
    await waitFor(() => expect(result.current.locked).toBeNull());
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'sticky', event: 'unlocked-distance' }),
    );
  });

  it('locked 상태에서 automotive motion → unlock-motion', async () => {
    const pushSpy = jest.spyOn(fusionDebugBuffer, 'pushFusionDebugEntry');
    const { result, rerender } = renderSticky({ fix: fixAt(seoul), motion: { automotive: false } });
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    rerender({ fix: fixAt(seoul), motion: { automotive: false } });
    rerender({ fix: fixAt(seoul), motion: { automotive: false } });
    await waitFor(() => expect(result.current.locked?.id).toBe(seoul.id));
    pushSpy.mockClear();

    rerender({ fix: fixAt(seoul), motion: { automotive: true } });
    await waitFor(() => expect(result.current.locked).toBeNull());
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'sticky', event: 'unlocked-motion' }),
    );
  });

  it('locked 상태에서 TTL 경과 → unlock-ttl', async () => {
    const pushSpy = jest.spyOn(fusionDebugBuffer, 'pushFusionDebugEntry');
    const realNow = Date.now();
    jest.setSystemTime(realNow);
    const { result, rerender } = renderSticky({ fix: fixAt(seoul) });
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    rerender({ fix: fixAt(seoul) });
    rerender({ fix: fixAt(seoul) });
    await waitFor(() => expect(result.current.locked?.id).toBe(seoul.id));
    pushSpy.mockClear();

    // 31분 경과 후 같은 역 fix → TTL unlock 평가
    jest.setSystemTime(realNow + STICKY_TTL_MS + 60_000);
    rerender({ fix: fixAt(seoul) });
    await waitFor(() => expect(result.current.locked).toBeNull());
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'sticky', event: 'unlocked-ttl' }),
    );
  });

  it('더 좋은 fix가 다른 역 3회 연속 → 즉시 갱신(unlock-better-fix + 새 lock)', async () => {
    const pushSpy = jest.spyOn(fusionDebugBuffer, 'pushFusionDebugEntry');
    const { result, rerender } = renderSticky({ fix: fixAt(seoul) });
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    rerender({ fix: fixAt(seoul) });
    rerender({ fix: fixAt(seoul) });
    await waitFor(() => expect(result.current.locked?.id).toBe(seoul.id));
    pushSpy.mockClear();

    // 서대문(서울 인접, ~1km 미만 — distance unlock 안 됨)으로 3회 좋은 fix
    rerender({ fix: fixAt(seoulNearby) });
    rerender({ fix: fixAt(seoulNearby) });
    rerender({ fix: fixAt(seoulNearby) });
    await waitFor(() => expect(result.current.locked?.id).toBe(seoulNearby.id));
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'sticky', event: 'unlocked-better-fix' }),
    );
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'sticky', event: 'locked', stationName: '서울역인접' }),
    );
  });

  it('AsyncStorage hydrate — 앱 시작 시 저장된 lock 복원', async () => {
    const lockedAt = Date.now() - 60_000; // 1분 전
    await AsyncStorage.setItem(
      STICKY_STATION_KEY,
      JSON.stringify({ station: seoul, lockedAt }),
    );
    const { result } = renderHook(() => useStickyStation(fixAt(null)));
    await waitFor(() => expect(result.current.locked?.id).toBe(seoul.id));
  });

  it('AsyncStorage hydrate — TTL 만료된 lock은 무시', async () => {
    const lockedAt = Date.now() - STICKY_TTL_MS - 60_000;
    await AsyncStorage.setItem(
      STICKY_STATION_KEY,
      JSON.stringify({ station: seoul, lockedAt }),
    );
    const { result } = renderHook(() => useStickyStation(fixAt(null)));
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    expect(result.current.locked).toBeNull();
  });

  it('AsyncStorage hydrate — parse 실패 시 graceful null', async () => {
    await AsyncStorage.setItem(STICKY_STATION_KEY, '{not json');
    const { result } = renderHook(() => useStickyStation(fixAt(null)));
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    expect(result.current.locked).toBeNull();
  });

  it.each([
    ['null primitive', 'null'],
    ['number primitive', '42'],
    ['lockedAt 누락', JSON.stringify({ station: seoul })],
    ['station 누락', JSON.stringify({ lockedAt: Date.now() })],
    ['station type 불일치', JSON.stringify({ station: 'string', lockedAt: Date.now() })],
    ['station.id 누락', JSON.stringify({
      station: { name: 'X', lat: 1, lng: 1 },
      lockedAt: Date.now(),
    })],
  ])('AsyncStorage hydrate — %s 형식 검증 실패 시 graceful null', async (_label, raw) => {
    await AsyncStorage.setItem(STICKY_STATION_KEY, raw);
    const { result } = renderHook(() => useStickyStation(fixAt(null)));
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    expect(result.current.locked).toBeNull();
  });

  it('writePersistedLock setItem 실패는 silent — 외부에서 throw 안 함', async () => {
    const setSpy = jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk'));
    const { result, rerender } = renderSticky({ fix: fixAt(seoul) });
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    rerender({ fix: fixAt(seoul) });
    rerender({ fix: fixAt(seoul) });
    // setItem reject가 unhandled rejection으로 새지 않고 lock은 in-memory에 정상 반영.
    await waitFor(() => expect(result.current.locked?.id).toBe(seoul.id));
    expect(setSpy).toHaveBeenCalledWith(STICKY_STATION_KEY, expect.any(String));
  });

  it('clearPersistedLock removeItem 실패는 silent', async () => {
    const lockedAt = Date.now() - STICKY_TTL_MS - 60_000; // 만료된 lock
    await AsyncStorage.setItem(
      STICKY_STATION_KEY,
      JSON.stringify({ station: seoul, lockedAt }),
    );
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('disk'));
    const { result } = renderHook(() => useStickyStation(fixAt(null)));
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    // 만료 lock은 removeItem 호출 시도 → reject 발생해도 hydrate 결과는 locked=null.
    expect(result.current.locked).toBeNull();
  });

  it('mount 직후 즉시 unmount — cancelled 플래그로 hydrate 결과 무시', async () => {
    const persisted = { station: seoul, lockedAt: Date.now() };
    await AsyncStorage.setItem(STICKY_STATION_KEY, JSON.stringify(persisted));
    const { unmount } = renderHook(() => useStickyStation(fixAt(null)));
    unmount(); // hydrate Promise resolve 전에 unmount
    // jest.useFakeTimers는 setImmediate를 잡으므로 advanceTimers로 flush.
    // unhandled state set이 발생하면 cancelled gate가 막아 console error가 뜨지 않아야 한다.
    await jest.runAllTimersAsync();
  });

  it('lock 시 AsyncStorage persist', async () => {
    const setSpy = jest.spyOn(AsyncStorage, 'setItem');
    const { rerender } = renderSticky({ fix: fixAt(seoul) });
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    rerender({ fix: fixAt(seoul) });
    rerender({ fix: fixAt(seoul) });
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith(STICKY_STATION_KEY, expect.any(String)));
  });

  it('unlock 시 AsyncStorage remove', async () => {
    const removeSpy = jest.spyOn(AsyncStorage, 'removeItem');
    const { result, rerender } = renderSticky({ fix: fixAt(seoul) });
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    rerender({ fix: fixAt(seoul) });
    rerender({ fix: fixAt(seoul) });
    await waitFor(() => expect(result.current.locked?.id).toBe(seoul.id));

    rerender({ fix: fixAt(gangnam) });
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith(STICKY_STATION_KEY));
  });

  it('candidate=null 상태에서는 카운트 안 함', async () => {
    const { result, rerender } = renderSticky({ fix: fixAt(null) });
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    rerender({ fix: fixAt(null) });
    rerender({ fix: fixAt(null) });
    expect(result.current.locked).toBeNull();
  });
});
