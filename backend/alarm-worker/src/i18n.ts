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

/**
 * #2063 (ADR-023 개정) — 매역 알림(station-notif) waypoint kind. `Waypoint.kind`와 1:1.
 * arvlCd 기반 매역 fire는 항상 phase='imminent'라 phase 분기는 두지 않는다
 * (device `route.intermediatePassedTitle` / `notifications.arrivalImminentTitle` /
 * `notifications.transferImminentTitle` 과 1:1 매핑, `alertContent.ts` byte-identical 문구 재사용).
 */
export type StationNotifKind = 'intermediate' | 'transfer' | 'destination';

interface I18nStrings {
  boardingPromptTitle: string;
  boardingPromptBody: (args: BoardingPromptArgs) => string;
  /** #2034 — hop-end (환승역 하차) 알림 title. */
  hopEndPromptTitle: (args: { transferStation: string }) => string;
  /** #2034 — hop-end (환승역 하차) 알림 body. */
  hopEndPromptBody: (args: HopEndPromptArgs) => string;
  /** #2063 — 매역 알림(station-notif) title. kind별 분기. */
  stationNotifTitle: (kind: StationNotifKind) => string;
  /** #2063 — 매역 알림(station-notif) body. kind별 분기 + station 삽입. */
  stationNotifBody: (kind: StationNotifKind, stationName: string) => string;
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
    // #2063 — device ko.json route.intermediatePassedTitle / notifications.arrivalImminentTitle /
    // notifications.transferImminentTitle 과 byte-identical.
    stationNotifTitle: (kind) => {
      if (kind === 'intermediate') return '역 통과';
      if (kind === 'transfer') return '환승 임박';
      return '도착 임박';
    },
    // device ko.json route.intermediatePassedBody / alarms.imminentArrivalBody / alarms.imminentTransferBody.
    stationNotifBody: (kind, stationName) => {
      if (kind === 'intermediate') return `${stationName}역을 지나고 있어요`;
      if (kind === 'transfer') return `곧 ${stationName}에 도착합니다. 환승 준비하세요!`;
      return `곧 ${stationName}에 도착합니다. 하차 준비하세요!`;
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
    // #2063 — device en.json route.intermediatePassedTitle / notifications.arrivalImminentTitle /
    // notifications.transferImminentTitle 과 byte-identical.
    stationNotifTitle: (kind) => {
      if (kind === 'intermediate') return 'Passing station';
      if (kind === 'transfer') return 'Transfer imminent';
      return 'Arrival imminent';
    },
    stationNotifBody: (kind, stationName) => {
      if (kind === 'intermediate') return `Passing through ${stationName}`;
      if (kind === 'transfer') return `Arriving at ${stationName} — transfer soon!`;
      return `Arriving at ${stationName} — exit soon!`;
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
    // #2063 — device ja.json route.intermediatePassedTitle / notifications.arrivalImminentTitle /
    // notifications.transferImminentTitle 과 byte-identical.
    stationNotifTitle: (kind) => {
      if (kind === 'intermediate') return '駅通過';
      if (kind === 'transfer') return 'まもなく乗換';
      return 'まもなく到着';
    },
    stationNotifBody: (kind, stationName) => {
      if (kind === 'intermediate') return `${stationName}駅を通過しています`;
      if (kind === 'transfer') return `まもなく${stationName}に到着します。乗換の準備をしてください!`;
      return `まもなく${stationName}に到着します。下車の準備をしてください!`;
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
    // #2063 — device zh.json route.intermediatePassedTitle / notifications.arrivalImminentTitle /
    // notifications.transferImminentTitle 과 byte-identical.
    stationNotifTitle: (kind) => {
      if (kind === 'intermediate') return '经过站点';
      if (kind === 'transfer') return '即将换乘';
      return '即将到达';
    },
    stationNotifBody: (kind, stationName) => {
      if (kind === 'intermediate') return `正在经过${stationName}站`;
      if (kind === 'transfer') return `即将到达${stationName}。请准备换乘!`;
      return `即将到达${stationName}。请准备下车!`;
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
