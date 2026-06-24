/**
 * #1573 (T10) — clearBackendSsotMirror unit test.
 * #1534 (S1, T9b) — lockSuggestion parse 검증 추가.
 *
 * persist는 silentPushTask.test.ts에서 검증. 본 파일은 T10 신규 helper(clearBackendSsotMirror)
 * + lockSuggestion 형식 검증(readBackendSsotMirror)을 다룬다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearBackendSsotMirror,
  persistBackendSsotMirror,
  readBackendSsotMirror,
} from '../backendSsotMirror';
import { BACKEND_SSOT_MIRROR_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    removeItem: jest.fn(),
    getItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

const mockRemoveItem = AsyncStorage.removeItem as jest.Mock;
const mockGetItem = AsyncStorage.getItem as jest.Mock;
const mockSetItem = AsyncStorage.setItem as jest.Mock;

describe('clearBackendSsotMirror (#1573 T10)', () => {
  beforeEach(() => {
    mockRemoveItem.mockReset();
  });

  it('BACKEND_SSOT_MIRROR_KEY를 제거한다', async () => {
    mockRemoveItem.mockResolvedValue(undefined);
    await clearBackendSsotMirror();
    expect(mockRemoveItem).toHaveBeenCalledWith(BACKEND_SSOT_MIRROR_KEY);
  });

  it('AsyncStorage 실패 시 graceful (throw 안 함)', async () => {
    mockRemoveItem.mockRejectedValue(new Error('io'));
    await expect(clearBackendSsotMirror()).resolves.toBeUndefined();
  });
});

describe('readBackendSsotMirror lockSuggestion parse (#1534 S1 T9b)', () => {
  const baseEntry = {
    currentStationId: '용마산',
    motionState: 'moving',
    lastAdvanceEvidence: 'arvlcd-confirmed-train',
    lastAdvanceAt: 1_700_000_000_000,
    passedStations: ['중곡'],
    receivedAt: 1_700_000_010_000,
  };

  beforeEach(() => {
    mockGetItem.mockReset();
  });

  it('valid lockSuggestion forward 시 결과에 포함', async () => {
    const lockSuggestion = {
      stationId: '용마산',
      trainCode: '7246',
      lineId: '7',
      confidence: 'high' as const,
      decidedAt: 1_700_000_005_000,
    };
    mockGetItem.mockResolvedValue(JSON.stringify({ ...baseEntry, lockSuggestion }));
    const got = await readBackendSsotMirror();
    expect(got?.lockSuggestion).toEqual(lockSuggestion);
  });

  it('lockSuggestion 부재 → 결과 lockSuggestion=undefined (legacy/graceful)', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify(baseEntry));
    const got = await readBackendSsotMirror();
    expect(got?.lockSuggestion).toBeUndefined();
  });

  it.each([
    ['stationId missing', { trainCode: 'X', lineId: '2', confidence: 'high', decidedAt: 1 }],
    [
      'empty stationId',
      { stationId: '', trainCode: 'X', lineId: '2', confidence: 'high', decidedAt: 1 },
    ],
    [
      'empty trainCode',
      { stationId: 'S', trainCode: '', lineId: '2', confidence: 'high', decidedAt: 1 },
    ],
    [
      'empty lineId',
      { stationId: 'S', trainCode: 'X', lineId: '', confidence: 'high', decidedAt: 1 },
    ],
    [
      'invalid confidence',
      { stationId: 'S', trainCode: 'X', lineId: '2', confidence: 'very-high', decidedAt: 1 },
    ],
    [
      'decidedAt NaN',
      { stationId: 'S', trainCode: 'X', lineId: '2', confidence: 'low', decidedAt: Number.NaN },
    ],
    [
      'decidedAt string',
      { stationId: 'S', trainCode: 'X', lineId: '2', confidence: 'low', decidedAt: '1' },
    ],
    ['null payload', null],
    ['scalar payload', 'oops'],
  ])('형식 mismatch %s → lockSuggestion 누락 (graceful)', async (_label, ls) => {
    mockGetItem.mockResolvedValue(JSON.stringify({ ...baseEntry, lockSuggestion: ls }));
    const got = await readBackendSsotMirror();
    expect(got?.lockSuggestion).toBeUndefined();
    // 본체 mirror entry는 살아 있음 (lockSuggestion만 graceful drop)
    expect(got?.currentStationId).toBe('용마산');
  });
});

// #1572 (T9, ADR-017) — readBackendSsotMirror alarmEvents parse + narrow.
describe('readBackendSsotMirror alarmEvents parse (#1572 T9)', () => {
  const baseEntry = {
    currentStationId: '용마산',
    motionState: 'moving',
    lastAdvanceEvidence: 'arvlcd-confirmed-train',
    lastAdvanceAt: 1_700_000_000_000,
    passedStations: ['중곡'],
    receivedAt: 1_700_000_010_000,
  };

  beforeEach(() => {
    mockGetItem.mockReset();
  });

  it('valid alarmEvents forward 시 결과에 포함', async () => {
    const alarmEvents = [
      { alarmId: 'a', stationId: 'X', type: 'station-passed' as const, decidedAt: 1 },
      { alarmId: 'b', stationId: 'Y', type: 'transfer' as const, decidedAt: 2 },
    ];
    mockGetItem.mockResolvedValue(JSON.stringify({ ...baseEntry, alarmEvents }));
    const got = await readBackendSsotMirror();
    expect(got?.alarmEvents).toEqual(alarmEvents);
  });

  it('alarmEvents 부재 → 결과 alarmEvents=undefined (legacy/graceful)', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify(baseEntry));
    const got = await readBackendSsotMirror();
    expect(got?.alarmEvents).toBeUndefined();
  });

  it.each([
    ['alarmId missing', { stationId: 'X', type: 'station-passed', decidedAt: 1 }],
    ['empty alarmId', { alarmId: '', stationId: 'X', type: 'station-passed', decidedAt: 1 }],
    ['empty stationId', { alarmId: 'a', stationId: '', type: 'station-passed', decidedAt: 1 }],
    ['invalid type', { alarmId: 'a', stationId: 'X', type: 'unknown', decidedAt: 1 }],
    ['decidedAt non-number', { alarmId: 'a', stationId: 'X', type: 'station-passed', decidedAt: 's' }],
    ['decidedAt NaN', { alarmId: 'a', stationId: 'X', type: 'station-passed', decidedAt: Number.NaN }],
    ['null entry', null],
    ['scalar entry', 'string'],
  ])('항목 mismatch %s → graceful drop (잔여만 채택)', async (_label, badEntry) => {
    const goodEntry = { alarmId: 'good', stationId: 'Y', type: 'transfer' as const, decidedAt: 5 };
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...baseEntry, alarmEvents: [badEntry, goodEntry] }),
    );
    const got = await readBackendSsotMirror();
    expect(got?.alarmEvents).toEqual([goodEntry]);
  });

  it('alarmEvents 비-array (raw 형식 mismatch) → undefined slot', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify({ ...baseEntry, alarmEvents: 'invalid' }));
    const got = await readBackendSsotMirror();
    expect(got?.alarmEvents).toBeUndefined();
    // 본체는 살아 있음.
    expect(got?.currentStationId).toBe('용마산');
  });

  it('필수 필드 누락 시 null 반환 (validation reject)', async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...baseEntry, currentStationId: 123 }),
    );
    const got = await readBackendSsotMirror();
    expect(got).toBeNull();
  });

  it('JSON parse 실패 시 null 반환 (graceful catch)', async () => {
    mockGetItem.mockResolvedValue('not-json');
    const got = await readBackendSsotMirror();
    expect(got).toBeNull();
  });

  it('AsyncStorage.getItem null 반환 → null (key 미존재)', async () => {
    mockGetItem.mockResolvedValue(null);
    const got = await readBackendSsotMirror();
    expect(got).toBeNull();
  });

  it('JSON.parse 결과가 null인 raw → null (parsed truthy check)', async () => {
    mockGetItem.mockResolvedValue('null');
    const got = await readBackendSsotMirror();
    expect(got).toBeNull();
  });

  it.each([
    ['currentStationId 빈 문자열', { ...baseEntry, currentStationId: '' }],
    ['motionState invalid 값', { ...baseEntry, motionState: 'invalid' }],
    ['lastAdvanceEvidence 비-string', { ...baseEntry, lastAdvanceEvidence: 123 }],
    ['lastAdvanceAt 비-number', { ...baseEntry, lastAdvanceAt: 'now' }],
    ['passedStations 비-array', { ...baseEntry, passedStations: 'wrong' }],
    ['receivedAt 비-number', { ...baseEntry, receivedAt: 'wrong' }],
  ])('%s → null', async (_label, raw) => {
    mockGetItem.mockResolvedValue(JSON.stringify(raw));
    const got = await readBackendSsotMirror();
    expect(got).toBeNull();
  });
});

// #1705 — readBackendSsotMirror currentStationLine parse (cross-line guard).
describe('readBackendSsotMirror currentStationLine parse (#1705)', () => {
  const baseEntry = {
    currentStationId: '합정',
    motionState: 'moving',
    lastAdvanceEvidence: 'arvlcd-confirmed-train',
    lastAdvanceAt: 1_700_000_000_000,
    passedStations: [],
    receivedAt: 1_700_000_010_000,
  };

  beforeEach(() => {
    mockGetItem.mockReset();
  });

  it('valid currentStationLine forward 시 결과에 포함', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify({ ...baseEntry, currentStationLine: '2' }));
    const got = await readBackendSsotMirror();
    expect(got?.currentStationLine).toBe('2');
  });

  it('currentStationLine 부재 → undefined (legacy v1 row graceful)', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify(baseEntry));
    const got = await readBackendSsotMirror();
    expect(got?.currentStationLine).toBeUndefined();
    // 본체는 살아 있음.
    expect(got?.currentStationId).toBe('합정');
  });

  it('currentStationLine 빈 문자열 → undefined (graceful drop)', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify({ ...baseEntry, currentStationLine: '' }));
    const got = await readBackendSsotMirror();
    expect(got?.currentStationLine).toBeUndefined();
    expect(got?.currentStationId).toBe('합정');
  });

  it('currentStationLine 비-string → undefined (graceful drop)', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify({ ...baseEntry, currentStationLine: 6 }));
    const got = await readBackendSsotMirror();
    expect(got?.currentStationLine).toBeUndefined();
    expect(got?.currentStationId).toBe('합정');
  });
});

describe('persistBackendSsotMirror (#1568 T8b)', () => {
  beforeEach(() => {
    mockSetItem.mockReset();
  });

  it('AsyncStorage.setItem 성공 — BACKEND_SSOT_MIRROR_KEY에 receivedAt 합쳐 저장', async () => {
    mockSetItem.mockResolvedValue(undefined);
    await persistBackendSsotMirror(
      {
        currentStationId: '용마산',
        motionState: 'moving',
        lastAdvanceEvidence: 'arvlcd-confirmed-train',
        lastAdvanceAt: 1_700_000_000_000,
        passedStations: ['중곡'],
      },
      1_700_000_010_000,
    );
    expect(mockSetItem).toHaveBeenCalledWith(
      BACKEND_SSOT_MIRROR_KEY,
      expect.stringContaining('"receivedAt":1700000010000'),
    );
  });
});
