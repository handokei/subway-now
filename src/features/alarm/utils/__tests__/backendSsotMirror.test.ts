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
  resolveBackendSsotMirrorStation,
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
//
// same-trip 판정 키는 `corrId`다 — `tripToken`은 APNs 기기 토큰이라 기기당 고정이라 "다른 trip"
// 분기가 실질적으로 dead code가 되고, 누수된 옛 trip mirror가 새 trip의 lastAdvanceAt=0 seed
// push(register-retry가 clearBackendSsotMirror 없이 ACTIVE_TRIP만 갱신하는 시나리오)를 전부
// stale-skip해버리는 역효과가 있다(code-review 지적). 아래 (b) 케이스가 그 회귀를 직접 재현한다.
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

  it('(a) 같은 corrId + stale(lastAdvanceAt 과거) 주입 시 미적용 — 기존 군자 mirror 유지 (RCA 재현, red→green)', async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...gunja, corrId: 'corr-A', receivedAt: gunjaAppliedAt + 5_000 }),
    );
    await persistBackendSsotMirror({ ...staleJungok, corrId: 'corr-A' }, jungokActualAt + 15_000);
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('(b) 새 corrId + lastAdvanceAt=0 → 수용 (register-retry가 옛 trip mirror를 안 지운 채 재등록한 시나리오)', async () => {
    // 누수된 옛 trip(corr-OLD) mirror가 여전히 남아있는 상태 — clearBackendSsotMirror 미호출.
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...gunja, corrId: 'corr-OLD', receivedAt: gunjaAppliedAt + 5_000 }),
    );
    // 새 trip(corr-NEW)의 origin seed push — lastAdvanceAt=0(합성 값)이 옛 trip의 lastAdvanceAt
    // 보다 훨씬 과거지만, corrId가 다르므로 무조건 수용해야 한다. tripToken 기준이었다면(기기당
    // 고정) 이 케이스가 stale-skip 오탐으로 새 trip 시작을 막았을 것.
    const newTripSeed = {
      currentStationId: '건대입구',
      motionState: 'unknown' as const,
      lastAdvanceEvidence: 'seed-override',
      lastAdvanceAt: 0,
      passedStations: [],
      corrId: 'corr-NEW',
    };
    await persistBackendSsotMirror(newTripSeed, gunjaAppliedAt + 20_000);
    expect(mockSetItem).toHaveBeenCalledWith(
      BACKEND_SSOT_MIRROR_KEY,
      expect.stringContaining('"currentStationId":"건대입구"'),
    );
  });

  it('(c) corrId 부재 legacy — 양쪽 다 corrId 없으면 same-trip 취급해 stale 가드 적용', async () => {
    // 레거시 저장분은 corrId 필드 자체가 없다 (#2593 이전 저장). incoming도 corrId 없음.
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...gunja, receivedAt: gunjaAppliedAt + 5_000 }),
    );
    await persistBackendSsotMirror(staleJungok, jungokActualAt + 15_000);
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('incoming만 corrId 있고 existing은 없음(legacy 저장분) → same-trip 취급, stale 가드 적용', async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...gunja, receivedAt: gunjaAppliedAt + 5_000 }),
    );
    await persistBackendSsotMirror({ ...staleJungok, corrId: 'corr-A' }, jungokActualAt + 15_000);
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('동일 lastAdvanceAt(=), sentAt 없음 → 기본 수용 (advance 없는 사이 재수신 push는 정상)', async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...gunja, corrId: 'corr-A', receivedAt: gunjaAppliedAt + 5_000 }),
    );
    const sameAdvance = { ...gunja, corrId: 'corr-A' };
    await persistBackendSsotMirror(sameAdvance, gunjaAppliedAt + 20_000);
    expect(mockSetItem).toHaveBeenCalledWith(
      BACKEND_SSOT_MIRROR_KEY,
      expect.stringContaining('"currentStationId":"군자"'),
    );
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

// #2593 (code-review 항목 2) — lastAdvanceAt 동률 재정렬 창 tie-break. trySeedOverride/모션 갱신처럼
// advance를 안 올리는 구 push가 sentAt만으로는 더 과거인데도 같은 역을 되돌릴 수 있는 케이스를 막는다.
describe('persistBackendSsotMirror sentAt tie-break (#2593)', () => {
  const advanceAt = 1_700_000_000_000;
  const existingFresh = {
    currentStationId: '군자',
    motionState: 'moving' as const,
    lastAdvanceEvidence: 'arvlcd-confirmed-train',
    lastAdvanceAt: advanceAt,
    passedStations: [],
    sentAt: 1_700_000_050_000,
  };

  beforeEach(() => {
    mockSetItem.mockReset();
    mockGetItem.mockReset();
    mockSetItem.mockResolvedValue(undefined);
  });

  it('lastAdvanceAt 동률 + incoming.sentAt < existing.sentAt → stale-skip (재정렬 창)', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify({ ...existingFresh, receivedAt: advanceAt + 1_000 }));
    const staleReorderedPush = {
      currentStationId: '중곡',
      motionState: 'stationary' as const,
      lastAdvanceEvidence: 'motion-correction',
      lastAdvanceAt: advanceAt,
      passedStations: [],
      sentAt: 1_700_000_010_000, // existing.sentAt보다 과거 — 재정렬로 늦게 도착한 구 push
    };
    await persistBackendSsotMirror(staleReorderedPush, advanceAt + 2_000);
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('lastAdvanceAt 동률 + incoming.sentAt >= existing.sentAt → 수용', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify({ ...existingFresh, receivedAt: advanceAt + 1_000 }));
    const newerPush = { ...existingFresh, sentAt: 1_700_000_060_000 };
    await persistBackendSsotMirror(newerPush, advanceAt + 2_000);
    expect(mockSetItem).toHaveBeenCalled();
  });

  it('lastAdvanceAt 동률이지만 sentAt 한쪽이라도 없으면 tie-break skip하고 기존처럼 수용', async () => {
    mockGetItem.mockResolvedValue(
      JSON.stringify({ ...existingFresh, sentAt: undefined, receivedAt: advanceAt + 1_000 }),
    );
    const incomingNoSentAt = {
      currentStationId: '중곡',
      motionState: 'stationary' as const,
      lastAdvanceEvidence: 'motion-correction',
      lastAdvanceAt: advanceAt,
      passedStations: [],
    };
    await persistBackendSsotMirror(incomingNoSentAt, advanceAt + 2_000);
    expect(mockSetItem).toHaveBeenCalled();
  });
});

// #2593 (code-review 항목 4) — read→write TOCTOU 하드닝. 동시 호출이 인터리브하면 두 호출이 같은
// stale existing을 보고 동시에 write할 수 있다. 모듈 레벨 promise chain으로 직렬화해 호출 순서를
// 보장한다.
describe('persistBackendSsotMirror TOCTOU 직렬화 (#2593)', () => {
  let fakeStore: Record<string, string> = {};

  beforeEach(() => {
    fakeStore = {};
    mockGetItem.mockReset();
    mockSetItem.mockReset();
    mockGetItem.mockImplementation(async (key: string) => fakeStore[key] ?? null);
    mockSetItem.mockImplementation(async (key: string, value: string) => {
      fakeStore[key] = value;
    });
  });

  it('동시에 발사된 fresh write와 stale write — 직렬화로 stale write가 fresh 커밋을 못 덮음', async () => {
    const fresh = {
      currentStationId: '군자',
      motionState: 'moving' as const,
      lastAdvanceEvidence: 'arvlcd-confirmed-train',
      lastAdvanceAt: 100,
      passedStations: [],
    };
    const stale = {
      currentStationId: '중곡',
      motionState: 'moving' as const,
      lastAdvanceEvidence: 'arvlcd-confirmed-train',
      lastAdvanceAt: 50,
      passedStations: [],
    };
    // await 없이 동시에 호출 — 직렬화가 없다면 둘 다 existing=null을 보고 둘 다 write할 것.
    const callA = persistBackendSsotMirror(fresh, 1_000);
    const callB = persistBackendSsotMirror(stale, 1_001);
    await Promise.all([callA, callB]);
    const finalStored = JSON.parse(fakeStore[BACKEND_SSOT_MIRROR_KEY]);
    expect(finalStored.currentStationId).toBe('군자');
  });
});

/**
 * #2589 (code review 1/2번) — mirror→Station 해석 단일 진입점. FG cascade picker
 * (`useFusedNearestStation` ssotGuardResult)와 LA refresh(`refreshLiveActivityFromBackgroundContext`)
 * 가 공유한다. 핵심 계약: line 불일치는 "보정"이 아니라 "거부(null)".
 */
describe('resolveBackendSsotMirrorStation (#2589 code review)', () => {
  it('lockLine 주어짐 + 실제 서비스 line과 일치 → 채택', () => {
    const result = resolveBackendSsotMirrorStation({ currentStationId: '강남' }, '2');
    expect(result).toEqual(expect.objectContaining({ name: '강남', line: '2' }));
  });

  it('lockLine 주어짐 + 실제 서비스하지 않는 line → 거부(null), 보정하지 않음', () => {
    // 강남은 2/sinbundang만 서비스 — 7호선 없음. 예전 정합 가드였다면 실제 line으로 "교정"해
    // 채택했겠지만, 이 함수는 신뢰 불가 판정으로 보고 무조건 거부한다.
    const result = resolveBackendSsotMirrorStation({ currentStationId: '강남' }, '7');
    expect(result).toBeNull();
  });

  it('lockLine 없음 + currentStationLine이 실제와 일치 → 채택', () => {
    const result = resolveBackendSsotMirrorStation({
      currentStationId: '성수',
      currentStationLine: '2',
    });
    expect(result).toEqual(expect.objectContaining({ name: '성수', line: '2' }));
  });

  it('lockLine 없음 + currentStationLine이 실제와 불일치(성수 7호선 클래스, #2556) → 거부(null)', () => {
    // 성수는 stations.json 기준 2호선만 서비스 — 7호선 없음. 예전 구현은
    // resolveConsistentStationLine으로 실제 line(2)에 "보정"해 채택했으나, 이는 FG
    // ssotGuardResult의 기존 거부 계약과 어긋난다. 본 함수는 거부한다.
    const result = resolveBackendSsotMirrorStation({
      currentStationId: '성수',
      currentStationLine: '7',
    });
    expect(result).toBeNull();
  });

  it('lockLine/currentStationLine 둘 다 없음(legacy v1 mirror) → name-only fallback', () => {
    const result = resolveBackendSsotMirrorStation({ currentStationId: '강남' });
    expect(result).toEqual(expect.objectContaining({ name: '강남' }));
  });

  it('lockLine이 currentStationLine보다 우선한다', () => {
    // lockLine('2')이 currentStationLine('7', 성수 기준 무효)보다 우선 채택되어 성공해야 함.
    const result = resolveBackendSsotMirrorStation(
      { currentStationId: '성수', currentStationLine: '7' },
      '2',
    );
    expect(result).toEqual(expect.objectContaining({ name: '성수', line: '2' }));
  });

  it('역명 자체가 stations.json에 없음 → null', () => {
    const result = resolveBackendSsotMirrorStation({ currentStationId: '존재하지않는역이름' });
    expect(result).toBeNull();
  });
});
