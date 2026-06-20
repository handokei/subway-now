/**
 * #1573 (T10) — clearBackendSsotMirror unit test.
 * #1534 (S1, T9b) — lockSuggestion parse 검증 추가.
 *
 * persist는 silentPushTask.test.ts에서 검증. 본 파일은 T10 신규 helper(clearBackendSsotMirror)
 * + lockSuggestion 형식 검증(readBackendSsotMirror)을 다룬다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearBackendSsotMirror, readBackendSsotMirror } from '../backendSsotMirror';
import { BACKEND_SSOT_MIRROR_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    removeItem: jest.fn(),
    getItem: jest.fn(),
  },
}));

const mockRemoveItem = AsyncStorage.removeItem as jest.Mock;
const mockGetItem = AsyncStorage.getItem as jest.Mock;

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
