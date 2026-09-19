import {
  CHANNEL_AGNOSTIC_DEDUP_WINDOW_MS,
  CROSS_CATEGORY_DEDUP_WINDOW_MS,
  PHASE_TO_PHASE_CROSS_STATION_WINDOW_MS,
  TRIP_SCOPED_CROSS_CATEGORY_WINDOW_MS,
  _resetCrossCategoryDedupForTests,
  clearCrossCategoryDedup,
  isAnyChannelRecentlyFired,
  isStationRecentlyFired,
  isPhaseToPhaseCrossStationRecentlyFired,
  isTripScopedCrossCategoryRecentlyFired,
  markStationFired,
} from '../crossCategoryStationDedup';

type Category = Parameters<typeof markStationFired>[2];

describe('crossCategoryStationDedup (#1515)', () => {
  beforeEach(() => {
    _resetCrossCategoryDedupForTests();
  });

  it('returns false when no fire has been recorded', () => {
    expect(isStationRecentlyFired('dest-1', '성수', 'station-passed', 1_000)).toBe(false);
  });

  // (firstFired, secondQuery, expectedBlocked, label)
  // - cross-category within window → blocked
  // - same-category phase progression (destination→destination, destination→transfer) → NOT blocked
  // - station-passed → station-passed → blocked (FG GPS path / fast-path race fix)
  it.each<[Category, Category, boolean, string]>([
    ['destination', 'station-passed', true, 'cross-cat: destination → station-passed blocked'],
    ['station-passed', 'destination', true, 'cross-cat: station-passed → destination blocked'],
    ['station-passed', 'transfer', true, 'cross-cat: station-passed → transfer blocked'],
    ['destination', 'destination', false, 'same-cat phase progression: destination → destination NOT blocked'],
    ['destination', 'transfer', false, 'same-cat phase group: destination → transfer NOT blocked'],
    ['station-passed', 'station-passed', true, 'station-passed → station-passed blocked (FG fast-path race fix)'],
  ])('%s → %s within window: blocked=%s (%s)', (first, second, blocked) => {
    markStationFired('dest-1', '성수', first, 1_000);
    expect(isStationRecentlyFired('dest-1', '성수', second, 1_500)).toBe(blocked);
  });

  it('returns false once the window has elapsed', () => {
    markStationFired('dest-1', '성수', 'destination', 1_000);
    expect(
      isStationRecentlyFired(
        'dest-1',
        '성수',
        'station-passed',
        1_000 + CROSS_CATEGORY_DEDUP_WINDOW_MS,
      ),
    ).toBe(false);
  });

  it('isolates entries by destinationId', () => {
    markStationFired('dest-1', '성수', 'destination', 1_000);
    expect(isStationRecentlyFired('dest-2', '성수', 'station-passed', 1_500)).toBe(false);
  });

  it('isolates entries by stationName', () => {
    markStationFired('dest-1', '성수', 'destination', 1_000);
    expect(isStationRecentlyFired('dest-1', '왕십리', 'station-passed', 1_500)).toBe(false);
  });

  it('normalizes station name (parenthetical suffix)', () => {
    markStationFired('dest-1', '왕십리(성동구청)', 'destination', 1_000);
    expect(isStationRecentlyFired('dest-1', '왕십리', 'station-passed', 1_500)).toBe(true);
  });

  it('accepts custom window override', () => {
    markStationFired('dest-1', '성수', 'destination', 1_000);
    expect(isStationRecentlyFired('dest-1', '성수', 'station-passed', 1_500, 100)).toBe(false);
    expect(isStationRecentlyFired('dest-1', '성수', 'station-passed', 1_050, 100)).toBe(true);
  });

  it('updates the record on subsequent markStationFired (category overwrite)', () => {
    markStationFired('dest-1', '성수', 'destination', 1_000);
    // station-passed fired after — cross-cat with destination dedup'd by previous mark.
    markStationFired('dest-1', '성수', 'station-passed', 1_100);
    // Subsequent destination call must now see station-passed (latest) as previous → cross-cat block.
    expect(isStationRecentlyFired('dest-1', '성수', 'destination', 1_200)).toBe(true);
  });

  it('sweeps expired entries once the map exceeds the cap', () => {
    for (let i = 0; i < 260; i += 1) {
      markStationFired(`dest-${i}`, '역', 'destination', 0);
    }
    expect(isStationRecentlyFired('dest-0', '역', 'station-passed', 1)).toBe(true);
    markStationFired('dest-new', '역', 'destination', CROSS_CATEGORY_DEDUP_WINDOW_MS + 1);
    expect(
      isStationRecentlyFired(
        'dest-0',
        '역',
        'station-passed',
        CROSS_CATEGORY_DEDUP_WINDOW_MS + 1,
      ),
    ).toBe(false);
    expect(
      isStationRecentlyFired(
        'dest-new',
        '역',
        'station-passed',
        CROSS_CATEGORY_DEDUP_WINDOW_MS + 2,
      ),
    ).toBe(true);
  });

  // #1545 (S12) — TRIP_BOUND_CLEANUPS에 wiring될 production reset.
  it('clearCrossCategoryDedup empties the window and resolves', async () => {
    markStationFired('dest-1', '강남', 'destination', 1_000);
    expect(isStationRecentlyFired('dest-1', '강남', 'station-passed', 2_000)).toBe(true);
    await expect(clearCrossCategoryDedup()).resolves.toBeUndefined();
    expect(isStationRecentlyFired('dest-1', '강남', 'station-passed', 2_000)).toBe(false);
  });

  // #1901/#1900 (RC-7/RC-10a) — channel-agnostic 8분 backstop. silent state push + LA dirty update
  // 같은 kind cross-channel 중복(2026-06-26 trip-3 동대문역사문화공원 8분 차) 회귀 차단용.
  describe('isAnyChannelRecentlyFired (#1901/#1900)', () => {
    it('returns false when no fire has been recorded', () => {
      expect(isAnyChannelRecentlyFired('dest-1', '성수', 'destination', 1_000)).toBe(false);
    });

    // 같은 station + 같은 category가 8분 안에 fire됐으면 차단. 다른 category는 cross-category gate가 담당.
    it.each<[Category, Category, boolean, string]>([
      ['destination', 'destination', true, 'same-kind D→D within 8m blocked (cross-channel evidence)'],
      ['transfer', 'transfer', true, 'same-kind T→T within 8m blocked'],
      ['station-passed', 'station-passed', true, 'same-kind SP→SP within 8m blocked (cross-channel)'],
      // 다른 kind는 cross-category gate(30s)가 cover하므로 본 backstop은 통과 — phase 진행이나
      // cross-category(D ↔ SP)는 다른 gate에서 dedup.
      ['destination', 'station-passed', false, 'cross-kind D→SP NOT blocked here (handled by 30s gate)'],
      ['station-passed', 'destination', false, 'cross-kind SP→D NOT blocked here (handled by 30s gate)'],
      ['destination', 'transfer', false, 'cross-kind D→T NOT blocked here'],
    ])('first=%s, second=%s: blocked=%s (%s)', (firstCat, secondCat, blocked) => {
      markStationFired('dest-1', '동대문역사문화공원', firstCat, 1_000);
      expect(
        isAnyChannelRecentlyFired('dest-1', '동대문역사문화공원', secondCat, 1_000 + 60_000),
      ).toBe(blocked);
    });

    it('blocks within 8m window edge (just under window)', () => {
      markStationFired('dest-1', '성수', 'destination', 1_000);
      expect(
        isAnyChannelRecentlyFired(
          'dest-1',
          '성수',
          'destination',
          1_000 + CHANNEL_AGNOSTIC_DEDUP_WINDOW_MS - 1,
        ),
      ).toBe(true);
    });

    it('unblocks once 8m window has elapsed', () => {
      markStationFired('dest-1', '성수', 'destination', 1_000);
      expect(
        isAnyChannelRecentlyFired(
          'dest-1',
          '성수',
          'destination',
          1_000 + CHANNEL_AGNOSTIC_DEDUP_WINDOW_MS,
        ),
      ).toBe(false);
    });

    it('isolates entries by destinationId', () => {
      markStationFired('dest-1', '성수', 'destination', 1_000);
      expect(isAnyChannelRecentlyFired('dest-2', '성수', 'destination', 1_500)).toBe(false);
    });

    it('isolates entries by stationName', () => {
      markStationFired('dest-1', '성수', 'destination', 1_000);
      expect(isAnyChannelRecentlyFired('dest-1', '왕십리', 'destination', 1_500)).toBe(false);
    });

    it('normalizes station name (parenthetical suffix)', () => {
      markStationFired('dest-1', '왕십리(성동구청)', 'destination', 1_000);
      expect(isAnyChannelRecentlyFired('dest-1', '왕십리', 'destination', 1_500)).toBe(true);
    });

    it('accepts custom window override (override < default window)', () => {
      markStationFired('dest-1', '성수', 'destination', 1_000);
      // 100ms override — 200ms 후 query는 통과.
      expect(
        isAnyChannelRecentlyFired('dest-1', '성수', 'destination', 1_200, undefined, 100),
      ).toBe(false);
      // 50ms 후 query는 차단.
      expect(
        isAnyChannelRecentlyFired('dest-1', '성수', 'destination', 1_050, undefined, 100),
      ).toBe(true);
    });

    // phaseId 비교 — 같은 station + 같은 kind + 다른 phaseId는 정상 phase 진행이라 통과.
    it('passes when phaseId differs (정상 phase 진행 early→imminent)', () => {
      markStationFired('dest-1', '동대문역사문화공원', 'destination', 1_000, 'early');
      expect(
        isAnyChannelRecentlyFired('dest-1', '동대문역사문화공원', 'destination', 1_100, 'imminent'),
      ).toBe(false);
    });

    it('blocks when phaseId matches (same phase cross-channel)', () => {
      markStationFired('dest-1', '동대문역사문화공원', 'destination', 1_000, 'early');
      expect(
        isAnyChannelRecentlyFired('dest-1', '동대문역사문화공원', 'destination', 1_100, 'early'),
      ).toBe(true);
    });

    // record phaseId 미정의 + query phaseId 정의 — 보수적 차단 (markStationFired 호출자가 phaseId
    // 안 전달한 케이스. SP path 등 phaseId 자체가 없을 때 backstop이 작동해야 함).
    it('blocks when record phaseId is undefined (conservative)', () => {
      markStationFired('dest-1', '동대문역사문화공원', 'station-passed', 1_000);
      expect(
        isAnyChannelRecentlyFired('dest-1', '동대문역사문화공원', 'station-passed', 1_100),
      ).toBe(true);
    });

    // query phaseId 미정의 — record가 정의돼 있어도 query 미정의면 보수적 차단.
    it('blocks when query phaseId is undefined (conservative)', () => {
      markStationFired('dest-1', '동대문역사문화공원', 'destination', 1_000, 'early');
      expect(
        isAnyChannelRecentlyFired('dest-1', '동대문역사문화공원', 'destination', 1_100),
      ).toBe(true);
    });

    it('is cleared by clearCrossCategoryDedup (TRIP_BOUND_CLEANUPS wiring)', async () => {
      markStationFired('dest-1', '동대문역사문화공원', 'destination', 1_000);
      expect(
        isAnyChannelRecentlyFired('dest-1', '동대문역사문화공원', 'destination', 2_000),
      ).toBe(true);
      await clearCrossCategoryDedup();
      expect(
        isAnyChannelRecentlyFired('dest-1', '동대문역사문화공원', 'destination', 2_000),
      ).toBe(false);
    });

    // 2026-06-26 trip-3 evidence 회귀 재현: 동일 station + 동일 kind(station-passed)가 8분 차로
    // cross-channel(silent state + LA dirty update) 발사된 경우. 8분 윈도우 안 차단.
    it('blocks 8m gap cross-channel duplicate (trip-3 동대문역사문화공원 evidence)', () => {
      const t1 = 1_000;
      markStationFired('dest-1', '동대문역사문화공원', 'station-passed', t1);
      // 윈도우 끝 1ms 전 — 차단.
      expect(
        isAnyChannelRecentlyFired(
          'dest-1',
          '동대문역사문화공원',
          'station-passed',
          t1 + CHANNEL_AGNOSTIC_DEDUP_WINDOW_MS - 1,
        ),
      ).toBe(true);
      // 8분 1ms 지나서 — 통과(같은 station 재방문은 윈도우 후 정상 발사).
      expect(
        isAnyChannelRecentlyFired(
          'dest-1',
          '동대문역사문화공원',
          'station-passed',
          t1 + CHANNEL_AGNOSTIC_DEDUP_WINDOW_MS + 1,
        ),
      ).toBe(false);
    });
  });

  // #1643 — trip-scoped cross-category + cross-station 즉시 cascade window (5s).
  // 차단 조건: (1) 다른 stationName + (2) cross-category(phase ↔ station-passed). 둘 다 만족해야 차단.
  describe('isTripScopedCrossCategoryRecentlyFired (#1643)', () => {
    it('returns false when no fire has been recorded', () => {
      expect(isTripScopedCrossCategoryRecentlyFired('dest-1', '성수', 'destination', 1_000)).toBe(false);
    });

    // (firstStation, firstCategory, secondStation, secondCategory, expectedBlocked, label)
    it.each<[string, Category, string, Category, boolean, string]>([
      // ── 차단 (cross-station + cross-category) ──
      // 2026-06-20 12:31 어대 evidence: "군자 도착"(SP) + "곧 성수 도착"(D imminent)
      ['군자', 'station-passed', '성수', 'destination', true, 'cross-station + SP→D blocked (어대 evidence)'],
      ['군자', 'station-passed', '건대', 'transfer', true, 'cross-station + SP→T blocked'],
      ['성수', 'destination', '왕십리', 'station-passed', true, 'cross-station + D→SP blocked'],
      ['건대', 'transfer', '왕십리', 'station-passed', true, 'cross-station + T→SP blocked'],

      // ── 통과 (same station 진행, per-station dedup이 담당) ──
      ['성수', 'destination', '성수', 'destination', false, 'same station + same-cat: D→D NOT blocked (early→imminent 진행)'],
      ['성수', 'station-passed', '성수', 'destination', false, 'same station + cross-cat: per-station이 담당'],
      ['성수', 'destination', '성수(부속)', 'station-passed', false, 'same station normalized: NOT blocked'],

      // ── 통과 (cross-station + same-category, 정상 trip 진행 보존) ──
      ['역삼', 'station-passed', '선릉', 'station-passed', false, 'cross-station + SP→SP NOT blocked (정상 trip 폴링 station 변경)'],
      // phase→phase cross-station은 isPhaseToPhaseCrossStationRecentlyFired(3s 윈도우)가 별도 담당.
      // isTripScopedCrossCategoryRecentlyFired는 SP↔phase 그룹만 차단 — phase→phase는 통과.
      ['건대', 'transfer', '성수', 'destination', false, 'cross-station + phase→phase NOT blocked (isPhaseToPhaseCrossStationRecentlyFired 담당)'],
      ['이수', 'destination', '사당', 'transfer', false, 'cross-station + phase→phase NOT blocked (isPhaseToPhaseCrossStationRecentlyFired 담당)'],
    ])(
      '(%s, %s) → (%s, %s) within trip window: blocked=%s (%s)',
      (firstSt, firstCat, secondSt, secondCat, blocked) => {
        markStationFired('dest-1', firstSt, firstCat, 10_000);
        expect(isTripScopedCrossCategoryRecentlyFired('dest-1', secondSt, secondCat, 10_500)).toBe(blocked);
      },
    );

    it('returns false once the trip-scoped window has elapsed (default 5s)', () => {
      markStationFired('dest-1', '군자', 'station-passed', 1_000);
      expect(
        isTripScopedCrossCategoryRecentlyFired(
          'dest-1',
          '성수',
          'destination',
          1_000 + TRIP_SCOPED_CROSS_CATEGORY_WINDOW_MS,
        ),
      ).toBe(false);
    });

    it('blocks within window then allows after window for normal 30s cycle progression', () => {
      // 같은 cycle 즉시 cascade는 차단.
      markStationFired('dest-1', '군자', 'station-passed', 1_000);
      expect(isTripScopedCrossCategoryRecentlyFired('dest-1', '성수', 'destination', 1_500)).toBe(true);
      // 정상 30s cycle 이후엔 통과 (사용자 trip 정상 진행 보존).
      expect(isTripScopedCrossCategoryRecentlyFired('dest-1', '성수', 'destination', 31_500)).toBe(false);
    });

    it('isolates entries by destinationId', () => {
      markStationFired('dest-1', '군자', 'station-passed', 1_000);
      expect(isTripScopedCrossCategoryRecentlyFired('dest-2', '성수', 'destination', 1_500)).toBe(false);
    });

    it('accepts custom window override', () => {
      markStationFired('dest-1', '군자', 'station-passed', 1_000);
      expect(
        isTripScopedCrossCategoryRecentlyFired('dest-1', '성수', 'destination', 1_500, 100),
      ).toBe(false);
      expect(
        isTripScopedCrossCategoryRecentlyFired('dest-1', '성수', 'destination', 1_050, 100),
      ).toBe(true);
    });

    it('updates record on subsequent markStationFired (latest stationName is reference)', () => {
      markStationFired('dest-1', '군자', 'station-passed', 1_000);
      // 같은 trip의 다른 station에 destination fire — 마지막 fire가 성수+destination으로 덮어쓰임.
      markStationFired('dest-1', '성수', 'destination', 1_100);
      // 후속 query 강남+SP는 성수(다른 station)+cross-cat(D↔SP)이라 차단.
      expect(isTripScopedCrossCategoryRecentlyFired('dest-1', '강남', 'station-passed', 1_200)).toBe(true);
      // 같은 성수 query는 통과 (per-station이 담당).
      expect(isTripScopedCrossCategoryRecentlyFired('dest-1', '성수', 'station-passed', 1_200)).toBe(false);
    });

    it('normalizes station name (parenthetical suffix matches same-station)', () => {
      markStationFired('dest-1', '왕십리(성동구청)', 'station-passed', 1_000);
      // normalize 후 같은 station '왕십리' → 통과 (per-station이 담당).
      expect(isTripScopedCrossCategoryRecentlyFired('dest-1', '왕십리', 'destination', 1_500)).toBe(false);
    });

    it('clearCrossCategoryDedup also clears trip-scoped fire records', async () => {
      markStationFired('dest-1', '군자', 'station-passed', 1_000);
      expect(isTripScopedCrossCategoryRecentlyFired('dest-1', '성수', 'destination', 1_500)).toBe(true);
      await clearCrossCategoryDedup();
      expect(isTripScopedCrossCategoryRecentlyFired('dest-1', '성수', 'destination', 1_500)).toBe(false);
    });

    it('_resetCrossCategoryDedupForTests also clears trip-scoped fire records', () => {
      markStationFired('dest-1', '군자', 'station-passed', 1_000);
      expect(isTripScopedCrossCategoryRecentlyFired('dest-1', '성수', 'destination', 1_500)).toBe(true);
      _resetCrossCategoryDedupForTests();
      expect(isTripScopedCrossCategoryRecentlyFired('dest-1', '성수', 'destination', 1_500)).toBe(false);
    });
  });

  // #1656 — phase↔phase cross-station cascade window (3s).
  // 차단 조건: (1) 다른 stationName + (2) 양쪽 모두 phase(destination/transfer). 둘 다 만족해야 차단.
  // station-passed 포함 케이스는 isTripScopedCrossCategoryRecentlyFired / isStationRecentlyFired 담당.
  describe('isPhaseToPhaseCrossStationRecentlyFired (#1656)', () => {
    it('returns false when no fire has been recorded', () => {
      expect(isPhaseToPhaseCrossStationRecentlyFired('dest-1', '건대', 'destination', 1_000)).toBe(false);
    });

    // (firstStation, firstCategory, secondStation, secondCategory, expectedBlocked, label)
    it.each<[string, Category, string, Category, boolean, string]>([
      // ── 차단 (cross-station + 양쪽 phase) ──
      // 2026-06-20 12:32 어대: "곧 건대 도착"(transfer) + "성수 도착"(destination)
      ['건대', 'transfer', '성수', 'destination', true, 'transfer→destination cross-station blocked (어대 12:32 evidence)'],
      // 2026-06-19 15:37 BG: "곧 이수"(destination imminent) + "다음 역 사당"(transfer)
      ['이수', 'destination', '사당', 'transfer', true, 'destination→transfer cross-station blocked (15:37 evidence)'],
      // 역방향도 차단
      ['성수', 'destination', '건대', 'transfer', true, 'destination→transfer cross-station blocked'],
      ['사당', 'transfer', '이수', 'destination', true, 'transfer→destination cross-station blocked'],

      // ── 통과 (same station 진행, firedAlarms set이 dedup) ──
      ['건대', 'transfer', '건대', 'destination', false, 'same station: NOT blocked (early→imminent on same station)'],
      ['성수', 'destination', '성수', 'destination', false, 'same station same-cat: NOT blocked'],
      ['이수(부속)', 'destination', '이수', 'transfer', false, 'same station normalized: NOT blocked'],

      // ── 통과 (station-passed 포함, 다른 함수가 담당) ──
      ['군자', 'station-passed', '성수', 'destination', false, 'station-passed as prev: NOT blocked (isTripScoped 담당)'],
      ['성수', 'destination', '왕십리', 'station-passed', false, 'station-passed as current: NOT blocked (isTripScoped 담당)'],
      ['역삼', 'station-passed', '선릉', 'station-passed', false, 'SP→SP: NOT blocked'],
    ])(
      '(%s, %s) → (%s, %s) within 3s window: blocked=%s (%s)',
      (firstSt, firstCat, secondSt, secondCat, blocked) => {
        markStationFired('dest-1', firstSt, firstCat, 10_000);
        expect(isPhaseToPhaseCrossStationRecentlyFired('dest-1', secondSt, secondCat, 10_500)).toBe(blocked);
      },
    );

    it('returns false once the 3s window has elapsed', () => {
      markStationFired('dest-1', '건대', 'transfer', 1_000);
      expect(
        isPhaseToPhaseCrossStationRecentlyFired(
          'dest-1',
          '성수',
          'destination',
          1_000 + PHASE_TO_PHASE_CROSS_STATION_WINDOW_MS,
        ),
      ).toBe(false);
    });

    it('blocks within 3s window then allows after window (normal leg progression)', () => {
      // leg 전환 즉시 cascade는 차단.
      markStationFired('dest-1', '건대', 'transfer', 1_000);
      expect(isPhaseToPhaseCrossStationRecentlyFired('dest-1', '성수', 'destination', 1_500)).toBe(true);
      // 3s 이후엔 통과 (정상 다음 hop fire 보존).
      expect(isPhaseToPhaseCrossStationRecentlyFired('dest-1', '성수', 'destination', 4_500)).toBe(false);
    });

    it('isolates entries by destinationId', () => {
      markStationFired('dest-1', '건대', 'transfer', 1_000);
      expect(isPhaseToPhaseCrossStationRecentlyFired('dest-2', '성수', 'destination', 1_500)).toBe(false);
    });

    it('accepts custom window override', () => {
      markStationFired('dest-1', '건대', 'transfer', 1_000);
      expect(isPhaseToPhaseCrossStationRecentlyFired('dest-1', '성수', 'destination', 1_500, 100)).toBe(false);
      expect(isPhaseToPhaseCrossStationRecentlyFired('dest-1', '성수', 'destination', 1_050, 100)).toBe(true);
    });

    it('clearCrossCategoryDedup also clears phase-to-phase fire records', async () => {
      markStationFired('dest-1', '건대', 'transfer', 1_000);
      expect(isPhaseToPhaseCrossStationRecentlyFired('dest-1', '성수', 'destination', 1_500)).toBe(true);
      await clearCrossCategoryDedup();
      expect(isPhaseToPhaseCrossStationRecentlyFired('dest-1', '성수', 'destination', 1_500)).toBe(false);
    });

    it('_resetCrossCategoryDedupForTests also clears phase-to-phase fire records', () => {
      markStationFired('dest-1', '건대', 'transfer', 1_000);
      expect(isPhaseToPhaseCrossStationRecentlyFired('dest-1', '성수', 'destination', 1_500)).toBe(true);
      _resetCrossCategoryDedupForTests();
      expect(isPhaseToPhaseCrossStationRecentlyFired('dest-1', '성수', 'destination', 1_500)).toBe(false);
    });
  });
});
