/**
 * #3191 PR-0 — 앱 launch 표식(콜드 스타트 시각 + 첫 hPa 기준선)을 Raw에 프로세스당 1회 기록
 * (별도 entry를 만들지 않고 첫 entry에 부착 — trip 목록/FIFO 점유에 영향 없음).
 * §14-5(콜드 스타트 지하 + 첫 fix acc<=30) 판정용 데이터. 관측 전용 — 기존 entry는 그대로.
 */
import {
  pushRawSignal,
  getRawSignalEntries,
  __resetRawSignalForTests__,
  type RawSignalEntry,
} from '../rawSignalBuffer';
import {
  appendBarometerReading,
  resetBarometerInstrumentationForTest,
  resetBarometerState,
} from '../../../../shared/utils/barometerState';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function entry(overrides?: Partial<RawSignalEntry>): RawSignalEntry {
  return {
    ts: 1_700_000_100_000,
    corrId: null,
    kind: 'cycle',
    gps: null,
    motion: null,
    accelPattern: null,
    cellular: null,
    subsurface: null,
    barometerHpa: null,
    arvlCd: null,
    line: null,
    dir: null,
    arcIdx: null,
    arcProgress: null,
    stationId: '2-022',
    source: null,
    confidence: null,
    pushReceipt: null,
    ...overrides,
  };
}

describe('rawSignalBuffer launch 표식 (#3191 PR-0)', () => {
  beforeEach(() => {
    __resetRawSignalForTests__();
    resetBarometerState();
    resetBarometerInstrumentationForTest();
  });

  it('기압 reading이 아직 없으면 launch 표식을 쓰지 않는다 (기준선 없음)', () => {
    pushRawSignal(entry());
    expect(getRawSignalEntries().map((e) => e.kind)).toEqual(['cycle']);
  });

  it('첫 hPa가 생긴 뒤 첫 push entry에 launch 표식을 부착한다 (별도 entry 없음)', () => {
    appendBarometerReading({ t: 1_700_000_050_000, pressureHpa: 1012.5 });
    pushRawSignal(entry());
    const entries = getRawSignalEntries();
    expect(entries.map((e) => e.kind)).toEqual(['cycle']);
    expect(entries[0].launch).toEqual({
      coldStartAtMs: expect.any(Number),
      firstHpa: 1012.5,
      firstHpaAtMs: 1_700_000_050_000,
    });
  });

  it('두 번째 push부터는 launch 표식을 다시 붙이지 않는다', () => {
    appendBarometerReading({ t: 1_700_000_050_000, pressureHpa: 1012.5 });
    pushRawSignal(entry());
    pushRawSignal(entry({ stationId: '2-023' }));
    expect(getRawSignalEntries().filter((e) => e.launch !== undefined)).toHaveLength(1);
  });

  it('launch 부착 외 기존 entry 내용은 그대로 보존된다', () => {
    appendBarometerReading({ t: 1_700_000_050_000, pressureHpa: 1012.5 });
    const original = entry({ stationId: '2-099' });
    pushRawSignal(original);
    const { launch, ...rest } = getRawSignalEntries()[0];
    expect(launch).toBeDefined();
    expect(rest).toEqual(original);
  });
});
