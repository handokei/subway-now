import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALARM_EVENTS_CAP,
  MOTION_EVIDENCE_CAP,
  SSOT_CRON_READ_CACHE_TTL_SEC,
  appendAlarmEvent,
  computeAlarmId,
  deleteSsot,
  isSameLockSuggestion,
  migrateTripPassedStationsToSsot,
  pushMotionEvidence,
  readSsot,
  seedSsot,
  setLockSuggestion,
  ssotKey,
  writeSsot,
  type LockSuggestion,
  type MotionEvidence,
  type TripPositionSSoT,
} from '../tripPositionSsot';
import { CRON_READ_CACHE_TTL_SEC } from '../kvConsistency';
import { InMemoryKV } from './inMemoryKv';

/**
 * Sub #1554 / T1 — TripPositionSSoT 스키마 + KV helpers acceptance.
 *
 * - Round-trip: writeSsot → readSsot 동등성
 * - Ring buffer: 51건 push 시 oldest 제거 (cap=50)
 * - seedSsot: SSOT 정상 생성 (currentStationId, motionState='unknown', passedStations=[])
 * - cacheTtl: <30 throw (lesson_cron_cachettl_runtime_constraint 준수)
 * - migrateTripPassedStationsToSsot: 양방향 호환 + dedup
 */

function makeSsot(overrides?: Partial<TripPositionSSoT>): TripPositionSSoT {
  return {
    tripToken: 'tok-abc',
    currentStationId: '0228',
    motionState: 'unknown',
    motionEvidence: [],
    lastAdvanceAt: 0,
    lastAdvanceEvidence: 'seed-override',
    passedStations: [],
    userIntentDeclared: false,
    seedOverrideCount: 0,
    alarmEvents: [],
    schemaVersion: 1,
    ...overrides,
  };
}

describe('tripPositionSsot — key + CRUD', () => {
  let kv: InMemoryKV;
  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('ssotKey: prefix "ssot:<token>" 박제', () => {
    expect(ssotKey('tok-xyz')).toBe('ssot:tok-xyz');
  });

  it('round-trip: writeSsot → readSsot은 같은 객체 (동등성)', async () => {
    const ssot = makeSsot({
      currentStationId: '0150',
      motionState: 'moving',
      passedStations: ['용마산', '중곡'],
      seedOverrideCount: 2,
    });
    await writeSsot(kv as unknown as KVNamespace, ssot);
    const got = await readSsot(kv as unknown as KVNamespace, ssot.tripToken);
    expect(got).toEqual(ssot);
  });

  it('readSsot: 없는 token은 null', async () => {
    const got = await readSsot(kv as unknown as KVNamespace, 'missing');
    expect(got).toBeNull();
  });

  it('readSsot: 손상된 JSON은 null (graceful)', async () => {
    await kv.put(ssotKey('tok-broken'), '{not json');
    const got = await readSsot(kv as unknown as KVNamespace, 'tok-broken');
    expect(got).toBeNull();
  });

  it('deleteSsot: 삭제 후 read는 null', async () => {
    const ssot = makeSsot();
    await writeSsot(kv as unknown as KVNamespace, ssot);
    await deleteSsot(kv as unknown as KVNamespace, ssot.tripToken);
    const got = await readSsot(kv as unknown as KVNamespace, ssot.tripToken);
    expect(got).toBeNull();
  });

  it('writeSsot: expiresAt 지정 시 expirationTtl 적용 (trip lifecycle 정합)', async () => {
    const ssot = makeSsot();
    const expiresAt = Date.now() + 600_000; // +10분
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt });
    const entry = kv.store.get(ssotKey(ssot.tripToken));
    expect(entry?.expiresAt).toBeDefined();
    // 60s 하한 적용 — 음수/0 입력 시 만료가 즉시 되지 않게 보호
    expect(entry?.expiresAt! - Date.now()).toBeGreaterThan(60_000);
  });

  it('writeSsot: expiresAt이 과거여도 최소 60s 하한 적용 (안전 가드)', async () => {
    const ssot = makeSsot();
    await writeSsot(kv as unknown as KVNamespace, ssot, {
      expiresAt: Date.now() - 100_000,
    });
    const entry = kv.store.get(ssotKey(ssot.tripToken));
    // SSOT_MIN_TTL_SEC = 60 적용 — 약 60s 후 만료
    expect(entry?.expiresAt! - Date.now()).toBeGreaterThanOrEqual(59_000);
    expect(entry?.expiresAt! - Date.now()).toBeLessThanOrEqual(61_000);
  });
});

describe('tripPositionSsot — cacheTtl floor (lesson_cron_cachettl_runtime_constraint)', () => {
  it('readSsot: cacheTtl < 30 throw RangeError (caller guard)', async () => {
    const kv = new InMemoryKV();
    await expect(
      readSsot(kv as unknown as KVNamespace, 'tok', { cacheTtl: 10 }),
    ).rejects.toThrow(RangeError);
  });

  it('readSsot: cacheTtl=30 통과 (cron read floor)', async () => {
    const kv = new InMemoryKV();
    const ssot = makeSsot();
    await writeSsot(kv as unknown as KVNamespace, ssot);
    const got = await readSsot(kv as unknown as KVNamespace, ssot.tripToken, {
      cacheTtl: 30,
    });
    expect(got).toEqual(ssot);
  });

  it('SSOT_CRON_READ_CACHE_TTL_SEC === CRON_READ_CACHE_TTL_SEC (30s 박제)', () => {
    expect(SSOT_CRON_READ_CACHE_TTL_SEC).toBe(CRON_READ_CACHE_TTL_SEC);
    expect(SSOT_CRON_READ_CACHE_TTL_SEC).toBe(30);
  });
});

describe('tripPositionSsot — seedSsot (S1 GAP A 수신부)', () => {
  it('seedSsot: 호출 후 SSOT 정상 생성 + KV write', async () => {
    const kv = new InMemoryKV();
    const ssot = await seedSsot(kv as unknown as KVNamespace, 'tok-seed', '0228');
    expect(ssot.tripToken).toBe('tok-seed');
    expect(ssot.currentStationId).toBe('0228');
    expect(ssot.motionState).toBe('unknown');
    expect(ssot.motionEvidence).toEqual([]);
    expect(ssot.passedStations).toEqual([]);
    expect(ssot.userIntentDeclared).toBe(false);
    expect(ssot.seedOverrideCount).toBe(0);
    // #2321 — lastDeviceSyncAt 추가로 schemaVersion 3.
    expect(ssot.schemaVersion).toBe(3);
    expect(ssot.lastAdvanceAt).toBe(0);

    const persisted = await readSsot(kv as unknown as KVNamespace, 'tok-seed');
    expect(persisted).toEqual(ssot);
  });

  it('seedSsot: userIntentDeclared 옵션 true로 stamp (C 토글 ON 시나리오)', async () => {
    const kv = new InMemoryKV();
    const ssot = await seedSsot(kv as unknown as KVNamespace, 'tok', '0150', {
      userIntentDeclared: true,
    });
    expect(ssot.userIntentDeclared).toBe(true);
  });

  it('seedSsot: expiresAt 옵션 전달 시 KV TTL 적용', async () => {
    const kv = new InMemoryKV();
    const expiresAt = Date.now() + 300_000;
    await seedSsot(kv as unknown as KVNamespace, 'tok', '0228', { expiresAt });
    const entry = kv.store.get(ssotKey('tok'));
    expect(entry?.expiresAt).toBeDefined();
  });

  // #1705 — currentStationLine seed + schemaVersion=3 (#2321 — lastDeviceSyncAt 추가로 bump)
  it('seedSsot: line 옵션 전달 시 currentStationLine stamp + schemaVersion=3', async () => {
    const kv = new InMemoryKV();
    const ssot = await seedSsot(kv as unknown as KVNamespace, 'tok-line', '합정', { line: '2' });
    expect(ssot.currentStationLine).toBe('2');
    expect(ssot.schemaVersion).toBe(3);
    const persisted = await readSsot(kv as unknown as KVNamespace, 'tok-line');
    expect(persisted?.currentStationLine).toBe('2');
  });

  it('seedSsot: line 미지정 시 currentStationLine=undefined', async () => {
    const kv = new InMemoryKV();
    const ssot = await seedSsot(kv as unknown as KVNamespace, 'tok-noline', '합정');
    expect(ssot.currentStationLine).toBeUndefined();
  });
});

describe('tripPositionSsot — pushMotionEvidence ring buffer', () => {
  function makeEvidence(ts: number): MotionEvidence {
    return { source: 'device-position', ts, signal: { displacementM: 10 } };
  }

  it('단일 push: ring buffer에 추가', () => {
    const ssot = makeSsot();
    pushMotionEvidence(ssot, makeEvidence(1));
    expect(ssot.motionEvidence).toHaveLength(1);
    expect(ssot.motionEvidence[0]?.ts).toBe(1);
  });

  it('50건 push: cap 그대로 유지 (eviction 미발생)', () => {
    const ssot = makeSsot();
    for (let i = 0; i < MOTION_EVIDENCE_CAP; i += 1) {
      pushMotionEvidence(ssot, makeEvidence(i));
    }
    expect(ssot.motionEvidence).toHaveLength(MOTION_EVIDENCE_CAP);
    expect(ssot.motionEvidence[0]?.ts).toBe(0);
    expect(ssot.motionEvidence[MOTION_EVIDENCE_CAP - 1]?.ts).toBe(
      MOTION_EVIDENCE_CAP - 1,
    );
  });

  it('51건 push: cap 유지 + oldest(ts=0) FIFO eviction', () => {
    const ssot = makeSsot();
    for (let i = 0; i <= MOTION_EVIDENCE_CAP; i += 1) {
      pushMotionEvidence(ssot, makeEvidence(i));
    }
    expect(ssot.motionEvidence).toHaveLength(MOTION_EVIDENCE_CAP);
    expect(ssot.motionEvidence[0]?.ts).toBe(1);
    expect(ssot.motionEvidence[MOTION_EVIDENCE_CAP - 1]?.ts).toBe(
      MOTION_EVIDENCE_CAP,
    );
  });

  it('MOTION_EVIDENCE_CAP === 50 (KV row 크기 정책 박제)', () => {
    expect(MOTION_EVIDENCE_CAP).toBe(50);
  });

  it('이미 cap 초과 상태에서 push: while 루프가 한 step 이상 eviction 수행', () => {
    const ssot = makeSsot();
    for (let i = 0; i < MOTION_EVIDENCE_CAP + 5; i += 1) {
      ssot.motionEvidence.push(makeEvidence(i));
    }
    expect(ssot.motionEvidence).toHaveLength(MOTION_EVIDENCE_CAP + 5);
    pushMotionEvidence(ssot, makeEvidence(999));
    expect(ssot.motionEvidence).toHaveLength(MOTION_EVIDENCE_CAP);
    expect(ssot.motionEvidence[MOTION_EVIDENCE_CAP - 1]?.ts).toBe(999);
    expect(ssot.motionEvidence[0]?.ts).toBe(6);
  });
});

describe('tripPositionSsot — migrateTripPassedStationsToSsot', () => {
  it('Trip.passedStations 비어 있으면 no-op', () => {
    const ssot = makeSsot();
    migrateTripPassedStationsToSsot({ passedStations: [] }, ssot);
    expect(ssot.passedStations).toEqual([]);
  });

  it('Trip.passedStations === undefined 도 no-op (S6 legacy trip)', () => {
    const ssot = makeSsot();
    migrateTripPassedStationsToSsot({ passedStations: undefined }, ssot);
    expect(ssot.passedStations).toEqual([]);
  });

  it('Trip.passedStations만 채워졌으면 SSOT로 union 반영', () => {
    const ssot = makeSsot({ passedStations: [] });
    migrateTripPassedStationsToSsot(
      { passedStations: ['용마산', '중곡', '군자'] },
      ssot,
    );
    expect(ssot.passedStations).toEqual(['용마산', '중곡', '군자']);
  });

  it('양방향 호환: SSOT에 이미 있는 station은 dedup', () => {
    const ssot = makeSsot({ passedStations: ['용마산', '중곡'] });
    migrateTripPassedStationsToSsot(
      { passedStations: ['용마산', '중곡', '군자'] },
      ssot,
    );
    expect(ssot.passedStations).toEqual(['용마산', '중곡', '군자']);
  });

  it('순서 보존: SSOT 기존 → Trip 신규 station 순으로 append', () => {
    const ssot = makeSsot({ passedStations: ['A', 'B'] });
    migrateTripPassedStationsToSsot({ passedStations: ['B', 'C', 'D'] }, ssot);
    expect(ssot.passedStations).toEqual(['A', 'B', 'C', 'D']);
  });
});

function makeSuggestion(overrides?: Partial<LockSuggestion>): LockSuggestion {
  return {
    stationId: '0228',
    trainCode: '7246',
    lineId: '7',
    confidence: 'high',
    decidedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('tripPositionSsot — lockSuggestion helpers (S1 T9b, #1534)', () => {
  it('setLockSuggestion: in-place mutate ssot.lockSuggestion', () => {
    const ssot = makeSsot();
    expect(ssot.lockSuggestion).toBeUndefined();
    const s = makeSuggestion();
    setLockSuggestion(ssot, s);
    expect(ssot.lockSuggestion).toEqual(s);
  });

  it('setLockSuggestion: 기존 suggestion 덮어쓰기 (unconditional write)', () => {
    const ssot = makeSsot({ lockSuggestion: makeSuggestion({ trainCode: 'OLD' }) });
    setLockSuggestion(ssot, makeSuggestion({ trainCode: 'NEW' }));
    expect(ssot.lockSuggestion?.trainCode).toBe('NEW');
  });

  it('isSameLockSuggestion: 기존 undefined → false', () => {
    expect(isSameLockSuggestion(undefined, makeSuggestion())).toBe(false);
  });

  it('isSameLockSuggestion: 동일 stationId+trainCode+lineId → true', () => {
    const a = makeSuggestion();
    const b = makeSuggestion();
    expect(isSameLockSuggestion(a, b)).toBe(true);
  });

  it('isSameLockSuggestion: confidence/decidedAt 차이는 무시 (정체성 기준은 3개 핵심 필드)', () => {
    const a = makeSuggestion({ confidence: 'high', decidedAt: 1 });
    const b = makeSuggestion({ confidence: 'medium', decidedAt: 999 });
    expect(isSameLockSuggestion(a, b)).toBe(true);
  });

  it('isSameLockSuggestion: stationId 다르면 false', () => {
    expect(
      isSameLockSuggestion(makeSuggestion(), makeSuggestion({ stationId: 'OTHER' })),
    ).toBe(false);
  });

  it('isSameLockSuggestion: trainCode 다르면 false', () => {
    expect(
      isSameLockSuggestion(makeSuggestion(), makeSuggestion({ trainCode: 'OTHER' })),
    ).toBe(false);
  });

  it('isSameLockSuggestion: lineId 다르면 false', () => {
    expect(
      isSameLockSuggestion(makeSuggestion(), makeSuggestion({ lineId: '2' })),
    ).toBe(false);
  });

  it('lockSuggestion round-trip: writeSsot → readSsot 보존', async () => {
    const kv = new InMemoryKV();
    const ssot = makeSsot({ lockSuggestion: makeSuggestion() });
    await writeSsot(kv as unknown as KVNamespace, ssot);
    const got = await readSsot(kv as unknown as KVNamespace, ssot.tripToken);
    expect(got?.lockSuggestion).toEqual(makeSuggestion());
  });
});

// #1572 (T9, ADR-017) — alarmEvents + computeAlarmId + appendAlarmEvent acceptance.
describe('alarmEvents helpers (#1572 T9)', () => {
  it('computeAlarmId: 같은 (tripToken, stationId, type) → 결정적 동일 hash', async () => {
    const id1 = await computeAlarmId('tok-abc', '용마산', 'station-passed');
    const id2 = await computeAlarmId('tok-abc', '용마산', 'station-passed');
    expect(id1).toBe(id2);
  });

  it('computeAlarmId: type 다르면 다른 hash', async () => {
    const id1 = await computeAlarmId('tok-abc', '용마산', 'station-passed');
    const id2 = await computeAlarmId('tok-abc', '용마산', 'transfer');
    expect(id1).not.toBe(id2);
  });

  it('computeAlarmId: 16-char hex prefix (8 bytes)', async () => {
    const id = await computeAlarmId('tok', 'X', 'station-passed');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('appendAlarmEvent: 빈 배열에 1건 push', () => {
    const ssot = makeSsot();
    appendAlarmEvent(ssot, {
      alarmId: 'abc123',
      stationId: '용마산',
      type: 'station-passed',
      decidedAt: 1_700_000_000_000,
    });
    expect(ssot.alarmEvents).toHaveLength(1);
    expect(ssot.alarmEvents?.[0].alarmId).toBe('abc123');
  });

  it('appendAlarmEvent: 같은 alarmId 중복 push 차단 (idempotent)', () => {
    const ssot = makeSsot({ alarmEvents: [] });
    const event = {
      alarmId: 'abc123',
      stationId: '용마산',
      type: 'station-passed' as const,
      decidedAt: 1_700_000_000_000,
    };
    appendAlarmEvent(ssot, event);
    appendAlarmEvent(ssot, event);
    expect(ssot.alarmEvents).toHaveLength(1);
  });

  it('appendAlarmEvent: alarmEvents 미정의 시 자동 초기화', () => {
    const ssot = makeSsot();
    delete ssot.alarmEvents;
    appendAlarmEvent(ssot, {
      alarmId: 'x',
      stationId: 'Y',
      type: 'station-passed',
      decidedAt: 1,
    });
    expect(ssot.alarmEvents).toEqual([
      { alarmId: 'x', stationId: 'Y', type: 'station-passed', decidedAt: 1 },
    ]);
  });

  it('appendAlarmEvent: ALARM_EVENTS_CAP(50) 초과 시 oldest FIFO eviction', () => {
    const ssot = makeSsot({ alarmEvents: [] });
    for (let i = 0; i < ALARM_EVENTS_CAP + 5; i += 1) {
      appendAlarmEvent(ssot, {
        alarmId: `id-${i}`,
        stationId: `S-${i}`,
        type: 'station-passed',
        decidedAt: i,
      });
    }
    expect(ssot.alarmEvents).toHaveLength(ALARM_EVENTS_CAP);
    expect(ssot.alarmEvents?.[0].alarmId).toBe('id-5'); // 첫 5건이 eviction됨
  });

  it('seedSsot: alarmEvents 빈 배열로 초기화', async () => {
    const kv = new InMemoryKV();
    const ssot = await seedSsot(kv as unknown as KVNamespace, 'tok', '용마산');
    expect(ssot.alarmEvents).toEqual([]);
  });

  it('alarmEvents round-trip: writeSsot → readSsot 보존', async () => {
    const kv = new InMemoryKV();
    const ssot = makeSsot({
      alarmEvents: [
        { alarmId: 'a', stationId: 'X', type: 'station-passed', decidedAt: 1 },
      ],
    });
    await writeSsot(kv as unknown as KVNamespace, ssot);
    const got = await readSsot(kv as unknown as KVNamespace, ssot.tripToken);
    expect(got?.alarmEvents).toEqual([
      { alarmId: 'a', stationId: 'X', type: 'station-passed', decidedAt: 1 },
    ]);
  });
});
