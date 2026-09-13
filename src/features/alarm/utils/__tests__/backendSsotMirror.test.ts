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

  // #2330 (consensus-D, 설계 SSoT #2323 (1)) — confidence='consensus' forward-compat.
  // backend consensus-C(#2329, 머지 대기)가 legConsensus confirmed 시 이 값을 forward한다.
  // 아직 backend가 이 값을 보내지 않아도 device parse가 미리 허용해야 결합 시 즉시 동작.
  it('confidence=consensus 도 유효 lockSuggestion으로 파싱 (#2330 forward-compat)', async () => {
    const lockSuggestion = {
      stationId: '건대입구',
      trainCode: '2246',
      lineId: '7',
      confidence: 'consensus' as const,
      decidedAt: 1_700_000_005_000,
    };
    mockGetItem.mockResolvedValue(JSON.stringify({ ...baseEntry, lockSuggestion }));
    const got = await readBackendSsotMirror();
    expect(got?.lockSuggestion).toEqual(lockSuggestion);
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
    mockGetItem.mockReset();
    mockGetItem.mockResolvedValue(null);
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

// #2593 — persistBackendSsotMirror 단조성 가드. RCA: 2026-09-13 데스크 trip, 군자 21:54:38
// 적용 후 stale 중곡 21:54:53 도착이 역행 적용된 실측(D1 295/296) 재생.
describe('persistBackendSsotMirror 단조성 가드 (#2593)', () => {
  const gunjaAppliedAt = new Date('2026-09-13T21:54:38+09:00').getTime();
  const jungokActualAt = new Date('2026-09-13T21:54:20+09:00').getTime(); // 군자보다 과거 — stale
  const gunja = {
    currentStationId: '군자',
    motionState: 'moving' as const,
    lastAdvanceEvidence: 'arvlcd-confirmed-train',
    lastAdvanceAt: gunjaAppliedAt,
    passedStations: ['어린이대공원'],
  };
  const staleJungok = {
    currentStationId: '중곡',
    motionState: 'moving' as const,
    lastAdvanceEvidence: 'arvlcd-confirmed-train',
    lastAdvanceAt: jungokActualAt,
    passedStations: [],
  };

  beforeEach(() => {
    mockSetItem.mockReset();
    mockGetItem.mockReset();
    mockSetItem.mockResolvedValue(undefined);
  });

  it('재생: stale 중곡(lastAdvanceAt 과거) 주입 시 미적용 — 기존 군자 mirror 유지 (RCA 재현, red→green)', async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...gunja, receivedAt: gunjaAppliedAt + 5_000 }),
    );
    await persistBackendSsotMirror(staleJungok, jungokActualAt + 15_000);
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('동일 lastAdvanceAt(=) 값은 수용 — advance 없는 사이 재수신 push는 정상', async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...gunja, receivedAt: gunjaAppliedAt + 5_000 }),
    );
    const sameAdvance = { ...gunja, currentStationId: '군자' };
    await persistBackendSsotMirror(sameAdvance, gunjaAppliedAt + 20_000);
    expect(mockSetItem).toHaveBeenCalledWith(
      BACKEND_SSOT_MIRROR_KEY,
      expect.stringContaining('"currentStationId":"군자"'),
    );
  });

  it('다른 trip이면 lastAdvanceAt가 더 과거여도 무조건 수용', async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...gunja, tripToken: 'trip-old', receivedAt: gunjaAppliedAt + 5_000 }),
    );
    const newTripEarlier = { ...staleJungok, tripToken: 'trip-new' };
    await persistBackendSsotMirror(newTripEarlier, jungokActualAt + 15_000);
    expect(mockSetItem).toHaveBeenCalledWith(
      BACKEND_SSOT_MIRROR_KEY,
      expect.stringContaining('"currentStationId":"중곡"'),
    );
  });

  it('기존 저장분(tripToken 필드 없음) 하위호환 — same-trip 취급해 stale 가드 적용', async () => {
    // 레거시 저장분은 tripToken 필드 자체가 없다 (#2593 이전 저장). incoming도 tripToken 없음.
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...gunja, receivedAt: gunjaAppliedAt + 5_000 }),
    );
    await persistBackendSsotMirror(staleJungok, jungokActualAt + 15_000);
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('기존 mirror 없음(첫 push) — 가드 없이 항상 수용', async () => {
    mockGetItem.mockResolvedValue(null);
    await persistBackendSsotMirror(gunja, gunjaAppliedAt + 5_000);
    expect(mockSetItem).toHaveBeenCalled();
  });

  it('신규 lastAdvanceAt(미래)가 기존보다 최신이면 정상 수용', async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...staleJungok, receivedAt: jungokActualAt + 5_000 }),
    );
    await persistBackendSsotMirror(gunja, gunjaAppliedAt + 5_000);
    expect(mockSetItem).toHaveBeenCalledWith(
      BACKEND_SSOT_MIRROR_KEY,
      expect.stringContaining('"currentStationId":"군자"'),
    );
  });
});
