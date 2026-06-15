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
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useStickyStation, type StickyFixInput, type StickyMotionInput } from '../useStickyStation';
import {
  STICKY_DEGRADED_UNLOCK_COUNT,
  STICKY_TTL_MS,
} from '../../../../shared/constants/stickyStation';
import { STICKY_STATION_KEY } from '../../../../shared/constants/storageKeys';
import * as fusionDebugBuffer from '../../utils/fusionDebugBuffer';
import type { Station } from '../../../../shared/types/station';

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
// #1317 — 용마산 trip의 "여러 역 통과"(군자/건대입구/성수)를 모사하는 distinct far 역들.
// 모두 서울역에서 1km+ 떨어진 다른 역. 저품질 accuracy(52.7m)와 함께 사용.
const gunja: Station = {
  id: '5-616', name: '군자', line: '5', lineColor: '#996cac', lat: 37.557345, lng: 127.079527,
};
const konkuk: Station = {
  id: '2-212', name: '건대입구', line: '2', lineColor: '#00a84d', lat: 37.540408, lng: 127.070061,
};
const seongsu: Station = {
  id: '2-211', name: '성수', line: '2', lineColor: '#00a84d', lat: 37.544581, lng: 127.055961,
};
// 용마산 trip의 저품질 GPS(accuracy 52.7m, strict 게이트 50m 초과)를 모사한 fix.
const degradedFixAt = (station: Station | null) =>
  fixAt(station, { accuracy: 52.7 });

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

  // D6 (#1212) — trip 활성 + 지하 시 sticky 유지 검증.
  describe('D6 (#1212) — trip 활성 + 지하 시 sticky 유지', () => {
    const lockSeoul = async (motion: StickyMotionInput) => {
      const hook = renderSticky({ fix: fixAt(seoul), motion });
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      hook.rerender({ fix: fixAt(seoul), motion });
      hook.rerender({ fix: fixAt(seoul), motion });
      await waitFor(() => expect(hook.result.current.locked?.id).toBe(seoul.id));
      return hook;
    };

    it('지하 + trip 활성 + automotive → unlock 보류 (lock 유지)', async () => {
      const motion: StickyMotionInput = { subsurface: true, tripActive: true };
      const { result, rerender } = await lockSeoul(motion);
      // automotive=true가 들어와도 subsurface+tripActive 동시 → unlock 안 함.
      rerender({ fix: fixAt(seoul), motion: { ...motion, automotive: true } });
      expect(result.current.locked?.id).toBe(seoul.id);
    });

    it('지하 + trip 활성 + 멀리 떨어진 좋은 fix → distance unlock 보류', async () => {
      const motion: StickyMotionInput = { subsurface: true, tripActive: true };
      const { result, rerender } = await lockSeoul(motion);
      // 강남역(10km+) 좋은 fix가 들어와도 지하 dead-zone 의심 → unlock 안 함.
      rerender({ fix: fixAt(gangnam), motion });
      expect(result.current.locked?.id).toBe(seoul.id);
    });

    it('지하 + trip 미활성 + automotive → 기존 unlock 동작 (lock 해제)', async () => {
      const { result, rerender } = await lockSeoul({});
      rerender({ fix: fixAt(seoul), motion: { automotive: true, subsurface: true, tripActive: false } });
      await waitFor(() => expect(result.current.locked).toBeNull());
    });

    it('지상 + trip 활성 + automotive → 기존 unlock 동작 (차/도보 환승 가능)', async () => {
      const { result, rerender } = await lockSeoul({});
      rerender({ fix: fixAt(seoul), motion: { automotive: true, subsurface: false, tripActive: true } });
      await waitFor(() => expect(result.current.locked).toBeNull());
    });
  });

  // #1317 — 저품질 GPS에서 출발역 sticky 고착 회귀 + 명시적 unlock.
  describe('#1317 — 저품질 GPS moved-away unlock', () => {
    // 서울역에 lock된 상태를 만드는 헬퍼(좋은 fix 3회).
    const lockSeoul = async () => {
      const hook = renderSticky({ fix: fixAt(seoul) });
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      hook.rerender({ fix: fixAt(seoul) });
      hook.rerender({ fix: fixAt(seoul) });
      await waitFor(() => expect(hook.result.current.locked?.id).toBe(seoul.id));
      return hook;
    };

    it('lock역에서 1km+ 이동 + 여러 역 통과(저품질) → moved-away unlock', async () => {
      const pushSpy = jest.spyOn(fusionDebugBuffer, 'pushFusionDebugEntry');
      const { result, rerender } = await lockSeoul();
      pushSpy.mockClear();

      // 저품질(52.7m) far 역 fix를 N회 연속 — 군자/건대입구/성수 통과 모사.
      // strict distance/better-fix는 ≤50m를 요구해 막히지만 moved-away는 누적된다.
      const movedFixes = [gunja, konkuk, seongsu];
      for (let i = 0; i < STICKY_DEGRADED_UNLOCK_COUNT; i += 1) {
        rerender({ fix: degradedFixAt(movedFixes[i % movedFixes.length]) });
      }
      await waitFor(() => expect(result.current.locked).toBeNull());
      expect(pushSpy).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'sticky', event: 'unlocked-moved-away' }),
      );
    });

    it('단발성 far fix 1회로는 unlock하지 않음 (false unlock 방지)', async () => {
      const { result, rerender } = await lockSeoul();
      // 저품질 far fix 1회만 — 임계(N) 미만이라 lock 유지.
      rerender({ fix: degradedFixAt(gunja) });
      expect(result.current.locked?.id).toBe(seoul.id);
    });

    it('far fix 사이에 lock역 근처 fix가 끼면 카운터 리셋 → unlock 안 됨', async () => {
      const { result, rerender } = await lockSeoul();
      // far(군자) → 근처(서울) → far(건대) 패턴: 연속이 끊겨 카운터가 리셋된다.
      rerender({ fix: degradedFixAt(gunja) });
      rerender({ fix: degradedFixAt(seoul) }); // 같은 역 → moved-away 아님 → 리셋
      rerender({ fix: degradedFixAt(konkuk) });
      // 누적이 1로 떨어져 임계 미달 — lock 유지.
      expect(result.current.locked?.id).toBe(seoul.id);
    });

    it('지하 + trip 활성에서는 저품질 far fix가 누적돼도 moved-away 보류 (D6 hold)', async () => {
      const motion: StickyMotionInput = { subsurface: true, tripActive: true };
      const hook = renderSticky({ fix: fixAt(seoul), motion });
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      hook.rerender({ fix: fixAt(seoul), motion });
      hook.rerender({ fix: fixAt(seoul), motion });
      await waitFor(() => expect(hook.result.current.locked?.id).toBe(seoul.id));

      const movedFixes = [gunja, konkuk, seongsu];
      for (let i = 0; i < STICKY_DEGRADED_UNLOCK_COUNT; i += 1) {
        hook.rerender({ fix: degradedFixAt(movedFixes[i % movedFixes.length]), motion });
      }
      // 지하 dead-zone 의심 → 누적해도 unlock 안 함.
      expect(hook.result.current.locked?.id).toBe(seoul.id);
    });

    it('releaseLock() 호출 → 즉시 unlock + unlocked-manual 이벤트', async () => {
      const pushSpy = jest.spyOn(fusionDebugBuffer, 'pushFusionDebugEntry');
      const { result, rerender } = await lockSeoul();
      pushSpy.mockClear();

      act(() => { result.current.releaseLock(); });
      await waitFor(() => expect(result.current.locked).toBeNull());
      expect(pushSpy).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'sticky', event: 'unlocked-manual', stationName: '서울역' }),
      );
      // unlock 후 persistence도 정리.
      rerender({ fix: fixAt(null) });
      await waitFor(() => expect(AsyncStorage.removeItem).toHaveBeenCalledWith(STICKY_STATION_KEY));
    });

    it('releaseLock() — lock 없을 때 no-op (이벤트 emit 안 함)', async () => {
      const pushSpy = jest.spyOn(fusionDebugBuffer, 'pushFusionDebugEntry');
      const { result } = renderSticky({ fix: fixAt(null) });
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      pushSpy.mockClear();

      act(() => { result.current.releaseLock(); });
      expect(result.current.locked).toBeNull();
      expect(pushSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'unlocked-manual' }),
      );
    });
  });

  it('candidate=null 상태에서는 카운트 안 함', async () => {
    const { result, rerender } = renderSticky({ fix: fixAt(null) });
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    rerender({ fix: fixAt(null) });
    rerender({ fix: fixAt(null) });
    expect(result.current.locked).toBeNull();
  });
});
