import i18next from 'i18next';
import {
  formatArrivalEtaPosition,
  formatDebugEta,
  hasKnownEta,
  isEtaUnknownRow,
  orderKnownEtaFirst,
  parseStopsAway,
} from '../arrivalEta';

describe('isEtaUnknownRow — P3: barvlDt<=0 && arvlCd ∉ {0,1,2}', () => {
  it.each([
    // [barvlDt, arvlCd, 사유]
    [0, 99, '코레일 운행중 + 0 (서울숲 [3]번째 전역)'],
    [0, 5, '코레일 전역 도착 + 0'],
    [0, 3, '코레일 전역 출발 + 0 (공덕 1065)'],
    [0, 4, '전역 진입 + 0'],
    [0, -1, 'arvlCd 누락/비숫자(-1) + 0'],
    [-1, 99, '음수 barvlDt'],
    [Number.NaN, 99, 'NaN barvlDt'],
  ])('barvlDt=%s arvlCd=%s → unknown (%s)', (barvlDt, arvlCd) => {
    expect(isEtaUnknownRow(barvlDt, arvlCd)).toBe(true);
  });

  it.each([
    [0, 0, '진입 — 진짜 0'],
    [0, 1, '도착 — 진짜 0'],
    [0, 2, '출발 — 진짜 0'],
    [240, 99, '2호선 "4분 후"'],
    [120, 5, '청량리 1001 전역 도착 120s (실값)'],
    [1, 99, '1초도 실값'],
  ])('barvlDt=%s arvlCd=%s → known (%s)', (barvlDt, arvlCd) => {
    expect(isEtaUnknownRow(barvlDt, arvlCd)).toBe(false);
  });
});

describe('parseStopsAway', () => {
  it('"[N]번째 전역 (역명)" → N', () => {
    expect(parseStopsAway('[3]번째 전역 (선정릉)', 99, true)).toBe(3);
    expect(parseStopsAway('[41]번째 전역 (평택)', 99, true)).toBe(41);
  });

  it.each([
    ['전역 도착', 5],
    ['전역 출발', 3],
    ['전역 진입', 4],
  ])('unknown + arvlCd 3/4/5 "%s" → 1', (msg, code) => {
    expect(parseStopsAway(msg, code, true)).toBe(1);
  });

  it('known 행의 "전역 도착"은 stopsAway를 만들지 않는다 (unknown 전용 규칙)', () => {
    expect(parseStopsAway('전역 도착', 5, false)).toBeNull();
  });

  it('unknown이어도 99 + 파싱 불가 문구는 null', () => {
    expect(parseStopsAway('', 99, true)).toBeNull();
    expect(parseStopsAway('서울숲 도착', 1, false)).toBeNull();
  });

  it('2호선 known 행의 "[2]번째 전역 (한양대)"도 N을 읽는다 (표시는 mm:ss 유지)', () => {
    expect(parseStopsAway('[2]번째 전역 (한양대)', 99, false)).toBe(2);
  });
});

describe('hasKnownEta / orderKnownEtaFirst', () => {
  const row = (arrivalSeconds: number | null, stopsAway: number | null, id: string) => ({
    arrivalSeconds,
    stopsAway,
    id,
  });

  it('hasKnownEta: 0은 known, null만 unknown', () => {
    expect(hasKnownEta(row(0, null, 'a'))).toBe(true);
    expect(hasKnownEta(row(null, 3, 'b'))).toBe(false);
  });

  it('초 있는 행(원래 순서 유지) → stopsAway 오름차순 → stopsAway 없는 행 맨 뒤, 어떤 행도 빠지지 않음', () => {
    // 청량리 1001 상행 API 순서를 그대로 흉내: unknown이 known 사이에 섞여 있다.
    const rows = [
      row(120, null, 'cd5-120'),
      row(0, null, 'entering-0'),
      row(null, 2, 'sinseol-2'),
      row(null, 23, 'anyang-23'),
      row(240, null, '4min'),
      row(null, null, 'no-n'),
      row(null, 41, 'pyeongtaek-41'),
    ];
    expect(orderKnownEtaFirst(rows).map((r) => r.id)).toEqual([
      'cd5-120',
      'entering-0',
      '4min',
      'sinseol-2',
      'anyang-23',
      'pyeongtaek-41',
      'no-n',
    ]);
  });

  it('unknown이 없으면 순서 불변 (서울교통공사 행 값·순서 불변)', () => {
    const rows = [row(300, null, 'a'), row(60, null, 'b'), row(0, null, 'c')];
    expect(orderKnownEtaFirst(rows).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('formatArrivalEtaPosition', () => {
  afterEach(async () => {
    await i18next.changeLanguage('ko');
  });

  it('ko: "[N]번째 전역 (역명)" → primary "N번째 전역" / secondary 역명', () => {
    expect(
      formatArrivalEtaPosition({ statusMessage: '[3]번째 전역 (선정릉)', stopsAway: 3, locationStation: '선정릉' }),
    ).toEqual({ primary: '3번째 전역', secondary: '선정릉' });
  });

  it('ko: "전역 도착" → primary 그대로 / secondary 직전 역(arvlMsg3)', () => {
    expect(
      formatArrivalEtaPosition({ statusMessage: '전역 도착', stopsAway: 1, locationStation: '왕십리' }),
    ).toEqual({ primary: '전역 도착', secondary: '왕십리' });
  });

  it('ko: locationStation 없으면 secondary 생략', () => {
    expect(formatArrivalEtaPosition({ statusMessage: '전역 도착', stopsAway: 1 })).toEqual({
      primary: '전역 도착',
    });
  });

  it('en: stopsAway i18n ("3 stops away" / "1 stop away"), 역명은 secondary', async () => {
    await i18next.changeLanguage('en');
    expect(
      formatArrivalEtaPosition({ statusMessage: '[3]번째 전역 (선정릉)', stopsAway: 3, locationStation: '선정릉' }),
    ).toEqual({ primary: '3 stops away', secondary: '선정릉' });
    expect(formatArrivalEtaPosition({ statusMessage: '전역 도착', stopsAway: 1 }).primary).toBe('1 stop away');
  });

  it.each([
    ['ja', '3駅先'],
    ['zh', '还有3站'],
  ])('%s: stopsAway i18n 사용', async (lang, expected) => {
    await i18next.changeLanguage(lang);
    expect(formatArrivalEtaPosition({ statusMessage: '[3]번째 전역 (선정릉)', stopsAway: 3 }).primary).toBe(expected);
  });

  it('en인데 stopsAway가 null이면 피드 원문으로 degrade (빈 칸 금지)', async () => {
    await i18next.changeLanguage('en');
    expect(formatArrivalEtaPosition({ statusMessage: '전역 도착', stopsAway: null }).primary).toBe('전역 도착');
  });
});

describe('formatDebugEta', () => {
  it('known은 초, unknown은 ?s (+ stopsAway)', () => {
    expect(formatDebugEta({ arrivalSeconds: 119.6, stopsAway: null })).toBe('120s');
    expect(formatDebugEta({ arrivalSeconds: null, stopsAway: 3 })).toBe('?s (3 stops)');
    expect(formatDebugEta({ arrivalSeconds: null, stopsAway: null })).toBe('?s');
  });
});
