/**
 * Backend push notification i18n string table (#1895).
 *
 * 디바이스 register POST /trips 시점에 `locale`을 함께 송신한다(`src/features/alarm/api/alarmBackend.ts`).
 * backend는 trip 객체에 locale을 저장하고, push 본문 생성 시 `t(trip.locale)`로 4언어 (ko/en/ja/zh)
 * 분기한다. locale 미지정/비지원이면 ko로 fallback (한국어 사용자 기본).
 *
 * 디바이스 측 i18n(`src/shared/i18n/locales/{ko,en,ja,zh}.json`)과 1:1 매핑.
 * 동기화 주의: 본 파일과 디바이스 i18n 모두 손대야 silent push fallback과 alert push의 본문이
 * 어긋나지 않는다.
 */

/** 지원 locale — 디바이스 SUPPORTED_LANGUAGES와 1:1 매핑. */
export type SupportedLocale = 'ko' | 'en' | 'ja' | 'zh';

/** Locale fallback — 한국 운영 서비스 기본. */
const DEFAULT_LOCALE: SupportedLocale = 'ko';

/** 입력 raw locale을 SupportedLocale로 정규화. 미지원/undefined → DEFAULT_LOCALE. */
export function normalizeLocale(raw: unknown): SupportedLocale {
  if (raw === 'ko' || raw === 'en' || raw === 'ja' || raw === 'zh') return raw;
  return DEFAULT_LOCALE;
}

/** Boarding-prompt body 인자. */
export interface BoardingPromptArgs {
  originStation: string;
  line: string;
  nextStation: string | null;
  /** etaIso8601 또는 HH:MM 시각 표기 문자열. 없으면 미표시. */
  etaTimeStr: string | null;
}

/**
 * #2034 — hop-end prompt body 인자.
 * - `transferStation`: 사용자가 하차해야 하는 환승역 이름
 * - `line`: 직전 leg 노선 (하차 대상)
 * - `nextLine`: 다음 leg 노선 (승차 대상). null 이면 UI 에서 next-leg 안내 생략.
 * - `nextStation`: 다음 leg 첫 정거장. null 이면 line 만 노출.
 */
export interface HopEndPromptArgs {
  transferStation: string;
  line: string;
  nextLine: string | null;
  nextStation: string | null;
}

interface I18nStrings {
  boardingPromptTitle: string;
  boardingPromptBody: (args: BoardingPromptArgs) => string;
  /** #2034 — hop-end (환승역 하차) 알림 title. */
  hopEndPromptTitle: (args: { transferStation: string }) => string;
  /** #2034 — hop-end (환승역 하차) 알림 body. */
  hopEndPromptBody: (args: HopEndPromptArgs) => string;
}

/**
 * 4언어 string table. 각 push kind 별로 title/body를 분리한다.
 *
 * boardingPromptBody는 `nextStation`이 있으면 "출발역 [호선] → 다음역 방면 (HH:MM 진입)",
 * 없으면 "${line} · ${originStation}" fallback — 기존 buildBoardingPromptMessage의 한국어 포맷을
 * 4언어로 확장.
 */
const I18N: Record<SupportedLocale, I18nStrings> = {
  ko: {
    boardingPromptTitle: '탑승하셨나요?',
    boardingPromptBody: ({ originStation, line, nextStation, etaTimeStr }) => {
      if (!nextStation) return `${line} · ${originStation}`;
      const time = etaTimeStr ? ` ${etaTimeStr} 진입` : '';
      return `${originStation} [${line}] → ${nextStation} 방면${time}`;
    },
    hopEndPromptTitle: ({ transferStation }) => `${transferStation}에서 하차하셨나요?`,
    hopEndPromptBody: ({ transferStation, line, nextLine, nextStation }) => {
      const from = `${line}호선 ${transferStation}에서 내려주세요.`;
      if (!nextLine) return from;
      const next = nextStation ? `${nextLine}호선 ${nextStation}` : `${nextLine}호선`;
      return `${from} 다음은 ${next} 방면입니다.`;
    },
  },
  en: {
    boardingPromptTitle: 'Are you on board?',
    boardingPromptBody: ({ originStation, line, nextStation, etaTimeStr }) => {
      if (!nextStation) return `${line} · ${originStation}`;
      const time = etaTimeStr ? ` ${etaTimeStr} arrival` : '';
      return `${originStation} [${line}] → ${nextStation} bound${time}`;
    },
    hopEndPromptTitle: ({ transferStation }) => `Getting off at ${transferStation}?`,
    hopEndPromptBody: ({ transferStation, line, nextLine, nextStation }) => {
      const from = `Please transfer from line ${line} at ${transferStation}.`;
      if (!nextLine) return from;
      const next = nextStation ? `line ${nextLine} toward ${nextStation}` : `line ${nextLine}`;
      return `${from} Next: ${next}.`;
    },
  },
  ja: {
    boardingPromptTitle: 'ご乗車されましたか?',
    boardingPromptBody: ({ originStation, line, nextStation, etaTimeStr }) => {
      if (!nextStation) return `${line} · ${originStation}`;
      const time = etaTimeStr ? ` ${etaTimeStr}進入` : '';
      return `${originStation} [${line}] → ${nextStation}方面${time}`;
    },
    hopEndPromptTitle: ({ transferStation }) => `${transferStation}で降りますか?`,
    hopEndPromptBody: ({ transferStation, line, nextLine, nextStation }) => {
      const from = `${line}号線 ${transferStation}で降車してください。`;
      if (!nextLine) return from;
      const next = nextStation ? `${nextLine}号線 ${nextStation}方面` : `${nextLine}号線`;
      return `${from} 次は${next}です。`;
    },
  },
  zh: {
    boardingPromptTitle: '您已乘车了吗?',
    boardingPromptBody: ({ originStation, line, nextStation, etaTimeStr }) => {
      if (!nextStation) return `${line} · ${originStation}`;
      const time = etaTimeStr ? ` ${etaTimeStr}到达` : '';
      return `${originStation} [${line}] → ${nextStation}方向${time}`;
    },
    hopEndPromptTitle: ({ transferStation }) => `您在${transferStation}下车了吗?`,
    hopEndPromptBody: ({ transferStation, line, nextLine, nextStation }) => {
      const from = `请在${line}号线 ${transferStation}下车。`;
      if (!nextLine) return from;
      const next = nextStation ? `${nextLine}号线 ${nextStation}方向` : `${nextLine}号线`;
      return `${from} 下一段: ${next}。`;
    },
  },
};

/**
 * 주어진 locale에 매핑된 string table 반환. 미지원/undefined는 DEFAULT_LOCALE.
 * caller는 `t(trip.locale).boardingPromptTitle` 형태로 사용.
 */
export function t(locale: SupportedLocale | undefined): I18nStrings {
  return I18N[locale ?? DEFAULT_LOCALE];
}
