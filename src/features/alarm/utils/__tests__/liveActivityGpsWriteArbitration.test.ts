import {
  markDeviceGpsLiveActivityWrite,
  isDeviceGpsLiveActivityWriteRecent,
  GPS_WRITE_ARBITRATION_WINDOW_MS,
  __test__,
} from '../liveActivityGpsWriteArbitration';

describe('liveActivityGpsWriteArbitration', () => {
  beforeEach(() => {
    __test__.reset();
  });

  it('초기 상태(마킹 없음)는 최근 쓰기 아님', () => {
    expect(isDeviceGpsLiveActivityWriteRecent(1_000_000)).toBe(false);
  });

  it('마킹 직후 arbitration 창 내부(now 인자 명시)는 최근 쓰기', () => {
    markDeviceGpsLiveActivityWrite(1_000_000);
    expect(isDeviceGpsLiveActivityWriteRecent(1_000_000 + GPS_WRITE_ARBITRATION_WINDOW_MS)).toBe(
      true,
    );
  });

  it('arbitration 창을 넘기면(now 인자 명시) 최근 쓰기 아님', () => {
    markDeviceGpsLiveActivityWrite(1_000_000);
    expect(
      isDeviceGpsLiveActivityWriteRecent(1_000_000 + GPS_WRITE_ARBITRATION_WINDOW_MS + 1),
    ).toBe(false);
  });

  it('인자 생략 시 기본값 Date.now() 사용 (mark/check 둘 다)', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    markDeviceGpsLiveActivityWrite();
    expect(isDeviceGpsLiveActivityWriteRecent()).toBe(true);
    jest.spyOn(Date, 'now').mockReturnValue(now + GPS_WRITE_ARBITRATION_WINDOW_MS + 1_000);
    expect(isDeviceGpsLiveActivityWriteRecent()).toBe(false);
    jest.restoreAllMocks();
  });

  it('reset 후에는 다시 최근 쓰기 아님', () => {
    markDeviceGpsLiveActivityWrite(Date.now());
    __test__.reset();
    expect(isDeviceGpsLiveActivityWriteRecent()).toBe(false);
  });
});
