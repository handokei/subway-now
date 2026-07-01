import {
  FIRE_ONCE_WINDOW_MS,
  _resetFireAlarmOnceForTests,
  fireAlarmOnce,
  makeFireAlarmOnceKey,
} from '../fireAlarmOnce';

const basePayload = {
  stationName: '성수',
  line: '2' as const,
  kind: 'station-passed' as const,
  phase: 'imminent' as const,
};

describe('fireAlarmOnce (#1984)', () => {
  beforeEach(() => {
    _resetFireAlarmOnceForTests();
  });

  describe('makeFireAlarmOnceKey', () => {
    it('composes key with all four dimensions', () => {
      expect(makeFireAlarmOnceKey(basePayload)).toBe('성수|2|station-passed|imminent');
    });

    it('serializes null line as string "null"', () => {
      expect(makeFireAlarmOnceKey({ ...basePayload, line: null })).toBe(
        '성수|null|station-passed|imminent',
      );
    });

    it('differentiates by phase (early vs imminent)', () => {
      const early = makeFireAlarmOnceKey({ ...basePayload, phase: 'early' });
      const imminent = makeFireAlarmOnceKey({ ...basePayload, phase: 'imminent' });
      expect(early).not.toBe(imminent);
    });

    it('differentiates by kind (destination vs transfer vs station-passed)', () => {
      const dest = makeFireAlarmOnceKey({ ...basePayload, kind: 'destination' });
      const transfer = makeFireAlarmOnceKey({ ...basePayload, kind: 'transfer' });
      const passed = makeFireAlarmOnceKey({ ...basePayload, kind: 'station-passed' });
      expect(new Set([dest, transfer, passed]).size).toBe(3);
    });
  });

  describe('fireAlarmOnce', () => {
    it('fires callback on first call and returns deduped=false', async () => {
      const fire = jest.fn().mockResolvedValue(undefined);
      const result = await fireAlarmOnce(basePayload, fire, 1_000);
      expect(fire).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ deduped: false, fired: true });
    });

    it('dedups second call within the window (same key, same tick)', async () => {
      const fire1 = jest.fn().mockResolvedValue(undefined);
      const fire2 = jest.fn().mockResolvedValue(undefined);
      const r1 = await fireAlarmOnce(basePayload, fire1, 1_000);
      const r2 = await fireAlarmOnce(basePayload, fire2, 1_000);
      expect(r1).toEqual({ deduped: false, fired: true });
      expect(r2).toEqual({ deduped: true, fired: false });
      expect(fire1).toHaveBeenCalledTimes(1);
      expect(fire2).not.toHaveBeenCalled();
    });

    it('same-second race: two concurrent invocations — only first fires (sync entry-guard)', async () => {
      // 회귀 재현: 2026-07-01 08:32:09 성수 fg fired station-passed 2건.
      // 두 useEffect가 같은 tick에 진입해도 fireAlarmOnce의 sync ledger.set이 두 번째 호출을 즉시 dedup.
      const fire1 = jest.fn().mockResolvedValue(undefined);
      const fire2 = jest.fn().mockResolvedValue(undefined);
      // 동시 dispatch — Promise.all로 병렬 실행.
      const [r1, r2] = await Promise.all([
        fireAlarmOnce(basePayload, fire1, 1_000),
        fireAlarmOnce(basePayload, fire2, 1_000),
      ]);
      // 두 결과 중 하나만 fired, 다른 하나는 dedup.
      const firedResults = [r1, r2].filter((r) => r.fired);
      const dedupedResults = [r1, r2].filter((r) => r.deduped);
      expect(firedResults).toHaveLength(1);
      expect(dedupedResults).toHaveLength(1);
      // 두 callback 중 정확히 1번만 실행 (총 실행 카운트 = 1).
      expect(fire1.mock.calls.length + fire2.mock.calls.length).toBe(1);
    });

    it('allows fire again after window expiry', async () => {
      const fire1 = jest.fn().mockResolvedValue(undefined);
      const fire2 = jest.fn().mockResolvedValue(undefined);
      await fireAlarmOnce(basePayload, fire1, 1_000);
      const r2 = await fireAlarmOnce(basePayload, fire2, 1_000 + FIRE_ONCE_WINDOW_MS);
      expect(r2).toEqual({ deduped: false, fired: true });
      expect(fire2).toHaveBeenCalledTimes(1);
    });

    it('boundary — exactly at window edge blocks (< not <=)', async () => {
      const fire1 = jest.fn().mockResolvedValue(undefined);
      const fire2 = jest.fn().mockResolvedValue(undefined);
      await fireAlarmOnce(basePayload, fire1, 1_000);
      // 1s before window end: still dedup.
      const r2 = await fireAlarmOnce(basePayload, fire2, 1_000 + FIRE_ONCE_WINDOW_MS - 1);
      expect(r2).toEqual({ deduped: true, fired: false });
      expect(fire2).not.toHaveBeenCalled();
    });

    it('different phase (early vs imminent) not deduped — 정상 phase 진행 보존', async () => {
      const fireEarly = jest.fn().mockResolvedValue(undefined);
      const fireImminent = jest.fn().mockResolvedValue(undefined);
      await fireAlarmOnce({ ...basePayload, phase: 'early' }, fireEarly, 1_000);
      const r2 = await fireAlarmOnce({ ...basePayload, phase: 'imminent' }, fireImminent, 1_010);
      expect(r2).toEqual({ deduped: false, fired: true });
      expect(fireImminent).toHaveBeenCalledTimes(1);
    });

    it('different station not deduped', async () => {
      const fire1 = jest.fn().mockResolvedValue(undefined);
      const fire2 = jest.fn().mockResolvedValue(undefined);
      await fireAlarmOnce(basePayload, fire1, 1_000);
      const r2 = await fireAlarmOnce({ ...basePayload, stationName: '왕십리' }, fire2, 1_010);
      expect(r2).toEqual({ deduped: false, fired: true });
    });

    it('different line not deduped (환승역 line 분기 fire 보존)', async () => {
      const fire1 = jest.fn().mockResolvedValue(undefined);
      const fire2 = jest.fn().mockResolvedValue(undefined);
      await fireAlarmOnce(basePayload, fire1, 1_000);
      const r2 = await fireAlarmOnce({ ...basePayload, line: '5' }, fire2, 1_010);
      expect(r2).toEqual({ deduped: false, fired: true });
    });

    it('different kind not deduped', async () => {
      const fire1 = jest.fn().mockResolvedValue(undefined);
      const fire2 = jest.fn().mockResolvedValue(undefined);
      await fireAlarmOnce(basePayload, fire1, 1_000);
      const r2 = await fireAlarmOnce({ ...basePayload, kind: 'destination' }, fire2, 1_010);
      expect(r2).toEqual({ deduped: false, fired: true });
    });

    it('uses Date.now() as default when now not provided', async () => {
      const fire = jest.fn().mockResolvedValue(undefined);
      const spy = jest.spyOn(Date, 'now').mockReturnValue(5_000);
      try {
        const r = await fireAlarmOnce(basePayload, fire);
        expect(r).toEqual({ deduped: false, fired: true });
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('propagates fire callback rejection (Finding #2 fix: ledger unstamped on failure)', async () => {
      const fire = jest.fn().mockRejectedValue(new Error('boom'));
      await expect(fireAlarmOnce(basePayload, fire, 1_000)).rejects.toThrow('boom');
      // 실패 시 ledger는 stamp되지 않아 다음 호출이 정상 fire 재시도 가능.
      // transient failure(silence gate / notification permission race)에서 30s blackhole 회귀 차단.
      const fire2 = jest.fn().mockResolvedValue(undefined);
      const r2 = await fireAlarmOnce(basePayload, fire2, 1_010);
      expect(r2).toEqual({ deduped: false, fired: true });
      expect(fire2).toHaveBeenCalledTimes(1);
    });

    it('Finding #2: fire 성공 후에는 ledger stamp되어 재발사 차단 (retry는 실패 케이스만)', async () => {
      const fire1 = jest.fn().mockResolvedValue(undefined);
      const fire2 = jest.fn().mockResolvedValue(undefined);
      const r1 = await fireAlarmOnce(basePayload, fire1, 1_000);
      expect(r1).toEqual({ deduped: false, fired: true });
      // 성공 후 재호출은 dedup — 30s window 내.
      const r2 = await fireAlarmOnce(basePayload, fire2, 1_010);
      expect(r2).toEqual({ deduped: true, fired: false });
      expect(fire2).not.toHaveBeenCalled();
    });

    it('Finding #2: 두 번 연속 실패 후 세 번째 성공 시 정상 fire (재시도 회복)', async () => {
      const fireFail = jest.fn().mockRejectedValue(new Error('transient'));
      const fireOk = jest.fn().mockResolvedValue(undefined);
      await expect(fireAlarmOnce(basePayload, fireFail, 1_000)).rejects.toThrow('transient');
      await expect(fireAlarmOnce(basePayload, fireFail, 1_001)).rejects.toThrow('transient');
      const r3 = await fireAlarmOnce(basePayload, fireOk, 1_002);
      expect(r3).toEqual({ deduped: false, fired: true });
      expect(fireOk).toHaveBeenCalledTimes(1);
    });

    it('Finding #2: in-flight reservation catches same-tick 재진입 (fire 실행 중)', async () => {
      // fire callback이 오래 걸리는 상황(await 진행 중)에 같은 key로 재진입 → inFlight로 즉시 dedup.
      let resolveFire!: () => void;
      const firePending = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveFire = resolve;
          }),
      );
      const fireSecond = jest.fn().mockResolvedValue(undefined);
      const p1 = fireAlarmOnce(basePayload, firePending, 1_000);
      // p1의 sync entry에서 inFlight.add는 완료. fire는 await 중.
      const p2 = fireAlarmOnce(basePayload, fireSecond, 1_000);
      const r2 = await p2;
      expect(r2).toEqual({ deduped: true, fired: false });
      expect(fireSecond).not.toHaveBeenCalled();
      // p1 완료 유도.
      resolveFire();
      const r1 = await p1;
      expect(r1).toEqual({ deduped: false, fired: true });
    });

    it('supports sync fire callback (void return)', async () => {
      const fire = jest.fn().mockReturnValue(undefined);
      const r = await fireAlarmOnce(basePayload, fire, 1_000);
      expect(r).toEqual({ deduped: false, fired: true });
      expect(fire).toHaveBeenCalledTimes(1);
    });

    it('sweeps expired entries when map exceeds cap (mixed fresh + expired)', async () => {
      // FIRE_ONCE_MAP_CAP=256. cap+1 entry 삽입 시 sweep 진입.
      // 절반은 매우 오래된 stamp(1_000) — sweep 통과해야 delete. 나머지는 fresh — 살아남아야 함.
      // 두 분기(expired delete + fresh skip) 모두 커버.
      const fire = jest.fn().mockResolvedValue(undefined);
      const freshTs = 1_000 + FIRE_ONCE_WINDOW_MS * 2; // 만료 판정 기준 시각
      // 첫 130개: 오래된 stamp — sweep 시 delete 대상.
      for (let i = 0; i < 130; i++) {
        await fireAlarmOnce(
          { ...basePayload, stationName: `old-${i}` },
          fire,
          1_000, // stale ts
        );
      }
      // 다음 130개: fresh stamp — sweep 시 살아남음.
      for (let i = 0; i < 130; i++) {
        await fireAlarmOnce(
          { ...basePayload, stationName: `fresh-${i}` },
          fire,
          freshTs, // fresh ts
        );
      }
      // fresh entry는 여전히 dedup 대상. old entry는 sweep으로 delete되어 다시 fire 가능.
      const rFresh = await fireAlarmOnce(
        { ...basePayload, stationName: 'fresh-0' },
        fire,
        freshTs + 100,
      );
      expect(rFresh).toEqual({ deduped: true, fired: false });
      // old-0는 sweep으로 삭제 + fresh 시각에는 window 밖 → 다시 fire 가능.
      const rOld = await fireAlarmOnce(
        { ...basePayload, stationName: 'old-0' },
        fire,
        freshTs + 100,
      );
      expect(rOld).toEqual({ deduped: false, fired: true });
    });
  });

  describe('_resetFireAlarmOnceForTests', () => {
    it('clears ledger', async () => {
      const fire1 = jest.fn().mockResolvedValue(undefined);
      const fire2 = jest.fn().mockResolvedValue(undefined);
      await fireAlarmOnce(basePayload, fire1, 1_000);
      _resetFireAlarmOnceForTests();
      const r = await fireAlarmOnce(basePayload, fire2, 1_010);
      expect(r).toEqual({ deduped: false, fired: true });
      expect(fire2).toHaveBeenCalledTimes(1);
    });
  });
});
