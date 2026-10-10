/**
 * #913 (F2) — useWifiStation 훅 테스트.
 *
 * 동작:
 *   1. mount 시 즉시 1회 호출, 이후 인터벌(15s)로 폴링
 *   2. SSID → lookupStationBySsid → Station 또는 null
 *   3. 같은 결과 재반환 시 state 갱신 skip (참조 안정성)
 *   4. unmount 시 polling cleanup
 */

const mockGetSsid = jest.fn();
const mockLookup = jest.fn();

jest.mock('../../utils/wifiSsidNative', () => ({
  getCurrentWifiSsid: () => mockGetSsid(),
}));

jest.mock('../../utils/wifiSsidLookup', () => ({
  lookupStationBySsid: (...args: unknown[]) => mockLookup(...args),
}));

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useWifiStation } from '../useWifiStation';
import { SIMPLE_ARRIVAL_ARCH_ENV_KEY } from '../../../../shared/config/archFlag';
import type { Station } from '../../../../shared/types/station';

const yongmasan: Station = { id: '7-yongmasan', name: '용마산', line: '7', lineColor: '#747F00', lat: 37.5, lng: 127 };
const junggok: Station = { id: '7-junggok', name: '중곡', line: '7', lineColor: '#747F00', lat: 37.5, lng: 127.1 };

const ORIGINAL_ARCH_ENV = process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];

describe('useWifiStation (#913)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGetSsid.mockReset();
    mockLookup.mockReset();
    // #2006 — 각 테스트 전 flag 초기화 (기본 OFF).
    delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    if (ORIGINAL_ARCH_ENV === undefined) {
      delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
    } else {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = ORIGINAL_ARCH_ENV;
    }
  });

  it('초기 1회 호출 — SSID 매칭 시 station 반환', async () => {
    mockGetSsid.mockResolvedValue('T_subway_용마산');
    mockLookup.mockReturnValue(yongmasan);

    const { result } = renderHook(() => useWifiStation());
    await waitFor(() => expect(result.current).toBe(yongmasan));
    expect(mockGetSsid).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledWith('T_subway_용마산');
  });

  it('SSID 없음 — null 유지', async () => {
    mockGetSsid.mockResolvedValue(null);
    mockLookup.mockReturnValue(null);

    const { result } = renderHook(() => useWifiStation());
    await waitFor(() => expect(mockGetSsid).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('인터벌마다 폴링 — SSID 변경 시 station 갱신', async () => {
    mockGetSsid.mockResolvedValue('T_subway_용마산');
    mockLookup.mockReturnValue(yongmasan);

    const { result } = renderHook(() => useWifiStation());
    await waitFor(() => expect(result.current).toBe(yongmasan));

    // 다른 역 SSID로 변경
    mockGetSsid.mockResolvedValue('T_subway_중곡');
    mockLookup.mockReturnValue(junggok);

    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await waitFor(() => expect(result.current).toBe(junggok));
  });

  it('같은 station 재반환 — 참조 동일 유지', async () => {
    mockGetSsid.mockResolvedValue('T_subway_용마산');
    mockLookup.mockReturnValue(yongmasan);

    const { result } = renderHook(() => useWifiStation());
    await waitFor(() => expect(result.current).toBe(yongmasan));

    const before = result.current;

    // 같은 SSID/station 다시 반환 (참조는 다른 객체일 수 있지만 name 같음 → prev 유지)
    mockLookup.mockReturnValue({ ...yongmasan });
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });

    expect(result.current).toBe(before);
  });

  it('station → null로 전환', async () => {
    mockGetSsid.mockResolvedValue('T_subway_용마산');
    mockLookup.mockReturnValue(yongmasan);

    const { result } = renderHook(() => useWifiStation());
    await waitFor(() => expect(result.current).toBe(yongmasan));

    mockGetSsid.mockResolvedValue(null);
    mockLookup.mockReturnValue(null);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await waitFor(() => expect(result.current).toBeNull());
  });

  it('unmount 시 cleanup — 이후 인터벌 호출 없음', async () => {
    mockGetSsid.mockResolvedValue(null);
    mockLookup.mockReturnValue(null);

    const { unmount } = renderHook(() => useWifiStation());
    await waitFor(() => expect(mockGetSsid).toHaveBeenCalled());

    unmount();
    const callsBefore = mockGetSsid.mock.calls.length;

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });

    expect(mockGetSsid.mock.calls.length).toBe(callsBefore);
  });

  it('async tick 진행 중 unmount — cancelled 가드로 setState skip', async () => {
    let resolveSsid: ((v: string | null) => void) | null = null;
    mockGetSsid.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveSsid = resolve;
        }),
    );
    mockLookup.mockReturnValue(yongmasan);

    const { result, unmount } = renderHook(() => useWifiStation());

    // unmount 먼저, 이후 in-flight tick의 ssid resolve
    unmount();
    await act(async () => {
      resolveSsid?.('T_subway_용마산');
    });

    // unmount 후엔 result.current는 last render인 null 유지 — lookup 호출 안 됨
    expect(result.current).toBeNull();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('mount 직후 polled = null인데 곧 station이 들어오는 케이스', async () => {
    // first call null
    mockGetSsid.mockResolvedValueOnce(null);
    mockLookup.mockReturnValueOnce(null);
    // 다음 tick에 SSID 잡힘
    mockGetSsid.mockResolvedValueOnce('T_subway_용마산');
    mockLookup.mockReturnValueOnce(yongmasan);

    const { result } = renderHook(() => useWifiStation());
    await waitFor(() => expect(result.current).toBeNull());

    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await waitFor(() => expect(result.current).toBe(yongmasan));
  });

  // #2006 (ADR-022 Phase 4-4) — flag ON 시 폴링 자체 skip. 배터리·권한 비용 0.
  describe('flag guard (#2006)', () => {
    it('flag ON — mount 시 getCurrentWifiSsid 호출 0 (폴링 skip)', async () => {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
      const { result } = renderHook(() => useWifiStation());

      // mount 직후 즉시 확인 — flag ON 이면 tick 이 등록되지 않아 getCurrentWifiSsid 호출 0.
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockGetSsid).not.toHaveBeenCalled();
      expect(mockLookup).not.toHaveBeenCalled();
      expect(result.current).toBeNull();
    });

    it('flag ON — 15s / 60s 경과 후에도 폴링 호출 0 (인터벌 skip)', async () => {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
      renderHook(() => useWifiStation());

      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      expect(mockGetSsid).not.toHaveBeenCalled();
    });

    it('flag OFF 명시 — 기존 폴링 동작 유지', async () => {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'false';
      mockGetSsid.mockResolvedValue('T_subway_용마산');
      mockLookup.mockReturnValue(yongmasan);

      const { result } = renderHook(() => useWifiStation());
      await waitFor(() => expect(result.current).toBe(yongmasan));
      expect(mockGetSsid).toHaveBeenCalled();
    });
  });
});
