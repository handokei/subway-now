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

interface I18nStrings {
  boardingPromptTitle: string;
  boardingPromptBody: (args: BoardingPromptArgs) => string;
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
  },
  en: {
    boardingPromptTitle: 'Are you on board?',
    boardingPromptBody: ({ originStation, line, nextStation, etaTimeStr }) => {
      if (!nextStation) return `${line} · ${originStation}`;
      const time = etaTimeStr ? ` ${etaTimeStr} arrival` : '';
      return `${originStation} [${line}] → ${nextStation} bound${time}`;
    },
  },
  ja: {
    boardingPromptTitle: 'ご乗車されましたか?',
    boardingPromptBody: ({ originStation, line, nextStation, etaTimeStr }) => {
      if (!nextStation) return `${line} · ${originStation}`;
      const time = etaTimeStr ? ` ${etaTimeStr}進入` : '';
      return `${originStation} [${line}] → ${nextStation}方面${time}`;
    },
  },
  zh: {
    boardingPromptTitle: '您已乘车了吗?',
    boardingPromptBody: ({ originStation, line, nextStation, etaTimeStr }) => {
      if (!nextStation) return `${line} · ${originStation}`;
      const time = etaTimeStr ? ` ${etaTimeStr}到达` : '';
      return `${originStation} [${line}] → ${nextStation}方向${time}`;
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
