import { describe, expect, it } from 'vitest';
import { normalizeLocale, t, type SupportedLocale } from '../i18n';

describe('normalizeLocale (#1895)', () => {
  const SUPPORTED: SupportedLocale[] = ['ko', 'en', 'ja', 'zh'];

  it.each(SUPPORTED)('지원 locale "%s"는 그대로 반환', (lc) => {
    expect(normalizeLocale(lc)).toBe(lc);
  });

  it.each([
    ['fr'],
    ['de'],
    ['EN'], // case-sensitive (i18next는 소문자만 송신하므로 대소문자 변환 X)
    [''],
    [null],
    [undefined],
    [123],
    [{}],
  ])('비지원/잘못된 입력 "%s" → ko fallback', (raw) => {
    expect(normalizeLocale(raw)).toBe('ko');
  });
});

describe('t() — boardingPromptTitle 4언어 분기 (#1895)', () => {
  it('locale=ko → "탑승하셨나요?"', () => {
    expect(t('ko').boardingPromptTitle).toBe('탑승하셨나요?');
  });

  it('locale=en → "Are you on board?"', () => {
    expect(t('en').boardingPromptTitle).toBe('Are you on board?');
  });

  it('locale=ja → "ご乗車されましたか?"', () => {
    expect(t('ja').boardingPromptTitle).toBe('ご乗車されましたか?');
  });

  it('locale=zh → "您已乘车了吗?"', () => {
    expect(t('zh').boardingPromptTitle).toBe('您已乘车了吗?');
  });

  it('locale=undefined → ko fallback', () => {
    expect(t(undefined).boardingPromptTitle).toBe('탑승하셨나요?');
  });
});

describe('t() — boardingPromptBody nextStation+ETA 분기 (#1895)', () => {
  const ETA_TIME = '07:15';
  const ARGS = {
    originStation: '시청',
    line: '2',
    nextStation: '강남',
    etaTimeStr: ETA_TIME,
  };

  it('locale=ko → "출발역 [호선] → 다음역 방면 HH:MM 진입"', () => {
    expect(t('ko').boardingPromptBody(ARGS)).toBe('시청 [2] → 강남 방면 07:15 진입');
  });

  it('locale=en → "originStation [line] → nextStation bound HH:MM arrival"', () => {
    expect(
      t('en').boardingPromptBody({ ...ARGS, originStation: 'City Hall', nextStation: 'Gangnam' }),
    ).toBe('City Hall [2] → Gangnam bound 07:15 arrival');
  });

  it('locale=ja → "originStation [line] → nextStation方面 HH:MM進入"', () => {
    expect(
      t('ja').boardingPromptBody({ ...ARGS, originStation: '市庁', nextStation: '江南' }),
    ).toBe('市庁 [2] → 江南方面 07:15進入');
  });

  it('locale=zh → "originStation [line] → nextStation方向 HH:MM到达"', () => {
    expect(
      t('zh').boardingPromptBody({ ...ARGS, originStation: '市厅', nextStation: '江南' }),
    ).toBe('市厅 [2] → 江南方向 07:15到达');
  });
});

describe('t() — boardingPromptBody nextStation null fallback (#1895)', () => {
  const ARGS_NULL = {
    originStation: '시청',
    line: '2',
    nextStation: null,
    etaTimeStr: null,
  };

  it.each([
    ['ko' as SupportedLocale],
    ['en' as SupportedLocale],
    ['ja' as SupportedLocale],
    ['zh' as SupportedLocale],
  ])('locale=%s → "${line} · ${originStation}" 공통 포맷 (nextStation null)', (lc) => {
    expect(t(lc).boardingPromptBody(ARGS_NULL)).toBe('2 · 시청');
  });
});

describe('t() — boardingPromptBody nextStation 있고 etaTimeStr null (#1895)', () => {
  const ARGS_NO_TIME = {
    originStation: '합정',
    line: '6',
    nextStation: '마포구청',
    etaTimeStr: null,
  };

  it('locale=ko → 시간 없이 방면만', () => {
    expect(t('ko').boardingPromptBody(ARGS_NO_TIME)).toBe('합정 [6] → 마포구청 방면');
  });

  it('locale=en → 시간 없이 bound만', () => {
    expect(t('en').boardingPromptBody(ARGS_NO_TIME)).toBe('합정 [6] → 마포구청 bound');
  });

  it('locale=ja → 시간 없이 方面만', () => {
    expect(t('ja').boardingPromptBody(ARGS_NO_TIME)).toBe('합정 [6] → 마포구청方面');
  });

  it('locale=zh → 시간 없이 方向만', () => {
    expect(t('zh').boardingPromptBody(ARGS_NO_TIME)).toBe('합정 [6] → 마포구청方向');
  });
});

describe('t() — boardingPromptBody destinationStation (#2904 — 열차 식별 정보)', () => {
  const ARGS_WITH_DEST = {
    originStation: '뚝섬',
    line: '2',
    nextStation: '성수',
    etaTimeStr: '06:46',
    destinationStation: '성수',
  };

  it('locale=ko → "종착역행 · 출발역 [호선] → 다음역 방면 HH:MM 진입"', () => {
    expect(t('ko').boardingPromptBody(ARGS_WITH_DEST)).toBe(
      '성수행 · 뚝섬 [2] → 성수 방면 06:46 진입',
    );
  });

  it('locale=en → "Bound for 종착역 · ..."', () => {
    expect(
      t('en').boardingPromptBody({
        ...ARGS_WITH_DEST,
        originStation: 'Ttukseom',
        nextStation: 'Seongsu',
        destinationStation: 'Seongsu',
      }),
    ).toBe('Bound for Seongsu · Ttukseom [2] → Seongsu bound 06:46 arrival');
  });

  it('locale=ja → "종착역行き · ..."', () => {
    expect(
      t('ja').boardingPromptBody({
        ...ARGS_WITH_DEST,
        originStation: 'ttukseom',
        nextStation: 'seongsu',
        destinationStation: 'seongsu',
      }),
    ).toBe('seongsu行き · ttukseom [2] → seongsu方面 06:46進入');
  });

  it('locale=zh → "开往종착역 · ..."', () => {
    expect(
      t('zh').boardingPromptBody({
        ...ARGS_WITH_DEST,
        originStation: 'ttukseom',
        nextStation: 'seongsu',
        destinationStation: 'seongsu',
      }),
    ).toBe('开往seongsu · ttukseom [2] → seongsu方向 06:46到达');
  });

  it.each([
    ['ko' as SupportedLocale],
    ['en' as SupportedLocale],
    ['ja' as SupportedLocale],
    ['zh' as SupportedLocale],
  ])(
    'locale=%s — destinationStation=null이면 기존 문구와 완전 동일(회귀 가드, #1740 omit 패턴)',
    (lc) => {
      const withNull = t(lc).boardingPromptBody({ ...ARGS_WITH_DEST, destinationStation: null });
      const without = t(lc).boardingPromptBody({
        originStation: ARGS_WITH_DEST.originStation,
        line: ARGS_WITH_DEST.line,
        nextStation: ARGS_WITH_DEST.nextStation,
        etaTimeStr: ARGS_WITH_DEST.etaTimeStr,
      });
      expect(withNull).toBe(without);
    },
  );

  it.each([
    ['ko' as SupportedLocale],
    ['en' as SupportedLocale],
    ['ja' as SupportedLocale],
    ['zh' as SupportedLocale],
  ])('locale=%s — destinationStation 필드 생략(undefined)도 기존 문구와 동일', (lc) => {
    const omitted = t(lc).boardingPromptBody({
      originStation: ARGS_WITH_DEST.originStation,
      line: ARGS_WITH_DEST.line,
      nextStation: ARGS_WITH_DEST.nextStation,
      etaTimeStr: ARGS_WITH_DEST.etaTimeStr,
    });
    const explicitNull = t(lc).boardingPromptBody({ ...ARGS_WITH_DEST, destinationStation: null });
    expect(omitted).toBe(explicitNull);
  });

  it('nextStation=null(기존 fallback)이면 destinationStation이 있어도 "${line} · ${originStation}" 그대로', () => {
    expect(
      t('ko').boardingPromptBody({
        originStation: '시청',
        line: '2',
        nextStation: null,
        etaTimeStr: null,
        destinationStation: '성수',
      }),
    ).toBe('2 · 시청');
  });
});
