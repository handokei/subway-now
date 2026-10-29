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

import { SLEEP_ALARM_MIN_STOPS_BEFORE } from '../../../src/shared/constants/sleepAlarm';

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
  /**
   * #2904 — 발사 시점 선택된 열차(pickAutoTrainCode 결과)의 종착역. 사용자가 "어느 열차를
   * 묻는지" 식별할 수 있는 1순위 정보(탭 리스트의 "OO행" 표기와 동일 어휘).
   * null/미상이면 접두사를 생략하고 기존 문구로 fallback(#1740 omit 패턴) — 추측 표기 금지.
   * optional — 기존 호출부/테스트(필드 생략)와 byte-level 호환.
   */
  destinationStation?: string | null;
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
 * (device #2506 `route.stationPassed` / `notifications.arrivalImminentTitle` /
 * `notifications.transferImminentTitle` 과 1:1 매핑, `alertContent.ts` byte-identical 문구 재사용).
 */
export type StationNotifKind = 'intermediate' | 'transfer' | 'destination';

/**
 * #2506 — intermediate 매역 도착 push 본문에 필요한 "다음 hop 대상까지 남은 정거장" 데이터.
 * device #2362(`deriveStationPassedTarget`/`buildStationPassedContent`,
 * src/features/alarm/hooks/useStationAlarm.ts + src/features/alarm/utils/stationNotification.ts)와
 * byte-parity를 맞추기 위해 "환승"/"도착" 같은 범주어 대신 실제 대상 station 이름을 그대로 쓴다.
 * `targetName`/`count`가 없거나 count<=0이면(구조 이상 방어) 카운트 문구를 생략하고 "도착"만 표시.
 */
export interface StationNotifCounts {
  targetName?: string;
  count?: number;
  /**
   * #3223 후속 — intermediate target 종류. 'transfer'면 "{역} 환승까지 N정거장", 그 외(미지정 포함)는
   * 기존 "{역}까지 N정거장 남음". 데이터는 `deriveStationNotifCounts`가 채운다.
   */
  targetKind?: 'transfer' | 'destination';
  /**
   * #3223 후속 — transfer waypoint 알림용 "갈아탈 노선/방면". `trip.waypoints[idx+1]`의
   * `line`/`stationName`(hop-end `maybeFireHopEndPrompt`의 nextLine/nextStation과 동일 출처).
   * 없으면 노선만 → 그것도 없으면 "이번 역에서 내려 갈아타세요"로 폴백한다.
   */
  nextLine?: string;
  nextStation?: string;
}

/** #3100 — 취침 알람 타깃 종류. intermediate는 알람 타깃이 될 수 없다. */
export type SleepAlarmKind = Exclude<StationNotifKind, 'intermediate'>;

interface I18nStrings {
  /**
   * #3007 S4-c — 정지 15분 "안내를 종료할까요?" LA 배너 title/body.
   *
   * **자동 종료가 아니라 질문이다.** 사용자 요구(2026-10-15): *"그 멘트는 내가 결정해야 하는
   * 거고, 결정할 수 있도록 LA 알림 있어야 함"*. 그래서 문구는 단정("안내를 종료했습니다")이
   * 아니라 선택을 묻는 형태여야 한다 — LA 버튼이 그 선택을 받는다.
   */
  endPromptTitle: string;
  endPromptBody: (args: { destinationStation?: string }) => string;
  boardingPromptTitle: string;
  boardingPromptBody: (args: BoardingPromptArgs) => string;
  /** #2034 — hop-end (환승역 하차) 알림 title. */
  hopEndPromptTitle: (args: { transferStation: string }) => string;
  /** #2034 — hop-end (환승역 하차) 알림 body. */
  hopEndPromptBody: (args: HopEndPromptArgs) => string;
  /**
   * #2063 — 매역 알림(station-notif) title. kind별 분기.
   * #2506 — intermediate는 station 이름을 title에 직접 포함("OO역 도착") — device
   * #2362(`route.stationPassed`)와 동일 wording.
   */
  stationNotifTitle: (kind: StationNotifKind, stationName: string) => string;
  /**
   * #2063 — 매역 알림(station-notif) body. kind별 분기 + station 삽입.
   * #2506 — intermediate는 `counts`(다음 hop 대상 + 남은 정거장 수)를 받아 "{target}까지
   * N정거장 남음"을 렌더한다(device #2362 `route.stopsRemainingToDestination`와 동일 wording).
   */
  stationNotifBody: (
    kind: StationNotifKind,
    stationName: string,
    counts?: StationNotifCounts,
  ) => string;
  /**
   * #3100 — 취침 알람 N역 전 title/body (`count` = 타깃까지 실제 남은 정거장, 기본 칸 1역 전 제외).
   * 기본 칸은 `stationNotifTitle`/`stationNotifBody` 그대로 쓰므로(`sleepAlarmContent`) 여기 오지 않는다.
   */
  sleepAlarmTitle: (kind: SleepAlarmKind, stationName: string, count: number) => string;
  sleepAlarmBody: (kind: SleepAlarmKind, stationName: string, count: number) => string;
  /** #3100 — 취침 알람 1역 전(SLEEP_ALARM_MIN_STOPS_BEFORE) 문구. device `*EarlyTitle`/`alarms.early*Body`와 byte-identical. */
  sleepAlarmOneStopTitle: (kind: SleepAlarmKind) => string;
  sleepAlarmOneStopBody: (kind: SleepAlarmKind, stationName: string) => string;
  /**
   * #2157 — eta-missing lock detach 시 재확인 alert push title. trip을 강제 종료하는 대신
   * lock만 해제하고 사용자에게 재선택(boardingPrompt/직접 탭)을 유도한다.
   */
  trainReconfirmTitle: string;
  /** #2157 — 재확인 alert push body. */
  trainReconfirmBody: string;
  /**
   * #3223 후속 — 목적지 도착으로 trip이 끝났을 때의 종료 alert push(`destination-arrived`).
   * 목적지명이 없거나 다른 종료 사유면 `alertContent.ts`의 기존 "안내 종료" 상수를 유지한다.
   */
  tripArrivedEndedTitle: (destinationStation: string) => string;
  tripArrivedEndedBody: string;
}

/**
 * 4언어 string table. 각 push kind 별로 title/body를 분리한다.
 *
 * boardingPromptBody는 `nextStation`이 있으면 "출발역 [호선] → 다음역 방면 (HH:MM 진입)",
 * 없으면 "${line} · ${originStation}" fallback — 기존 buildBoardingPromptMessage의 한국어 포맷을
 * 4언어로 확장.
 *
 * #2904 — `destinationStation`(발사 시점 선택된 열차의 종착역)이 있으면 "종착역행 · " 접두사를
 * 더해 사용자가 어느 열차를 묻는지 식별 가능하게 한다(예: "성수행 · 뚝섬 [2] → 성수 방면
 * 06:46 진입"). null/미상이면 접두사를 생략하고 위 fallback과 완전 동일 — 추측 표기 금지.
 */
const I18N: Record<SupportedLocale, I18nStrings> = {
  ko: {
    endPromptTitle: '안내를 종료할까요?',
    endPromptBody: ({ destinationStation }) =>
      destinationStation ? `15분째 움직임이 없어요 · ${destinationStation}까지 안내 중` : '15분째 움직임이 없어요',
    boardingPromptTitle: '탑승하셨나요?',
    boardingPromptBody: ({ originStation, line, nextStation, etaTimeStr, destinationStation }) => {
      if (!nextStation) return `${line} · ${originStation}`;
      // #3223 후속 — "{출발} {노선}호선 · {HH:MM} {다음역} 방면 열차 (목적지 {종착})". 시각/목적지는 없으면 그 조각만 생략.
      const time = etaTimeStr ? `${etaTimeStr} ` : '';
      const dest = destinationStation ? ` (목적지 ${destinationStation})` : '';
      return `${originStation} ${line}호선 · ${time}${nextStation} 방면 열차${dest}`;
    },
    hopEndPromptTitle: ({ transferStation }) => `${transferStation}에서 내리셨나요?`,
    hopEndPromptBody: ({ transferStation, line, nextLine, nextStation }) => {
      // 다음 노선이 없으면(목적지 하차 확인 — fireDestinationDisembarkPrompt) 갈아탈 곳이 없으므로 기존 문장 유지.
      if (!nextLine) return `${line}호선 ${transferStation}에서 내려주세요.`;
      return nextStation ? `${nextLine}호선 ${nextStation} 방면으로 갈아타세요` : `${nextLine}호선으로 갈아타세요`;
    },
    // #2506 — intermediate는 device ko.json route.stationPassed와 byte-identical.
    // transfer/destination은 기존 #2063 문구 유지(notifications.arrivalImminentTitle/
    // transferImminentTitle).
    stationNotifTitle: (kind, stationName) => {
      if (kind === 'intermediate') return `${stationName}역 도착`;
      if (kind === 'transfer') return `${stationName} 환승`;
      return `${stationName} 도착`;
    },
    // #2506 — intermediate는 device ko.json route.stopsRemainingToDestination과 byte-identical
    // (target=환승역/도착역 실명). transfer/destination은 기존 alarms.imminent*Body 유지.
    stationNotifBody: (kind, _stationName, counts) => {
      if (kind === 'intermediate') {
        if (counts?.targetName !== undefined && counts.count !== undefined && counts.count > 0) {
          return counts.targetKind === 'transfer'
            ? `${counts.targetName} 환승까지 ${counts.count}정거장`
            : `${counts.targetName}까지 ${counts.count}정거장 남음`;
        }
        return '도착';
      }
      if (kind === 'transfer') {
        const { nextLine, nextStation } = counts ?? {};
        if (!nextLine) return '이번 역에서 내려 갈아타세요';
        return nextStation
          ? `이번 역에서 내려 ${nextLine}호선 ${nextStation} 방면으로 갈아타세요`
          : `이번 역에서 내려 ${nextLine}호선으로 갈아타세요`;
      }
      return '이번 역에서 내리세요';
    },
    // #3100 — 취침 알람 N역 전(기본 칸 1역 전이 아닌 칸) 문구. 실제 남은 정거장 수를 담는다.
    sleepAlarmTitle: (kind, stationName, count) =>
      kind === 'transfer' ? `${stationName} 환승까지 ${count}정거장` : `${stationName} 도착까지 ${count}정거장`,
    sleepAlarmBody: (kind) => `일어나서 ${kind === 'transfer' ? '환승' : '하차'} 준비하세요`,
    sleepAlarmOneStopTitle: (kind) => (kind === 'transfer' ? '환승 알림' : '하차 알림'),
    sleepAlarmOneStopBody: (kind, stationName) =>
      `다음 역 ${stationName}에서 ${kind === 'transfer' ? '환승' : '하차'}하세요!`,
    trainReconfirmTitle: '탑승 열차를 찾을 수 없어요',
    trainReconfirmBody: '다시 확인해주세요',
    tripArrivedEndedTitle: (destinationStation) => `${destinationStation} 도착 · 안내 종료`,
    tripArrivedEndedBody: '목적지에 도착해 경로 안내를 마쳤어요',
  },
  en: {
    endPromptTitle: 'End guidance?',
    endPromptBody: ({ destinationStation }) =>
      destinationStation
        ? `No movement for 15 minutes · Guiding to ${destinationStation}`
        : 'No movement for 15 minutes',
    boardingPromptTitle: 'Are you on board?',
    boardingPromptBody: ({ originStation, line, nextStation, etaTimeStr, destinationStation }) => {
      if (!nextStation) return `${line} · ${originStation}`;
      const time = etaTimeStr ? `${etaTimeStr} ` : '';
      const dest = destinationStation ? ` (destination ${destinationStation})` : '';
      return `${originStation} line ${line} · ${time}train toward ${nextStation}${dest}`;
    },
    hopEndPromptTitle: ({ transferStation }) => `Did you get off at ${transferStation}?`,
    hopEndPromptBody: ({ transferStation, line, nextLine, nextStation }) => {
      if (!nextLine) return `Please transfer from line ${line} at ${transferStation}.`;
      return nextStation ? `Transfer to line ${nextLine} toward ${nextStation}` : `Transfer to line ${nextLine}`;
    },
    // #2506 — intermediate is byte-identical to device en.json route.stationPassed.
    // transfer/destination keep the #2063 wording (notifications.arrivalImminentTitle/
    // transferImminentTitle).
    stationNotifTitle: (kind, stationName) => {
      if (kind === 'intermediate') return `Arrived at ${stationName}`;
      if (kind === 'transfer') return `Transfer at ${stationName}`;
      return `Arriving at ${stationName}`;
    },
    // #2506 — intermediate is byte-identical to device en.json
    // route.stopsRemainingToDestination (target = actual transfer/destination station name).
    stationNotifBody: (kind, _stationName, counts) => {
      if (kind === 'intermediate') {
        if (counts?.targetName !== undefined && counts.count !== undefined && counts.count > 0) {
          const unit = counts.count === 1 ? 'stop' : 'stops';
          return counts.targetKind === 'transfer'
            ? `${counts.count} ${unit} to transfer at ${counts.targetName}`
            : `${counts.count} ${unit} to ${counts.targetName}`;
        }
        return 'Arrived';
      }
      if (kind === 'transfer') {
        const { nextLine, nextStation } = counts ?? {};
        if (!nextLine) return 'Get off here and transfer';
        return nextStation
          ? `Get off here and take line ${nextLine} toward ${nextStation}`
          : `Get off here and take line ${nextLine}`;
      }
      return 'Get off at this stop';
    },
    // #3100 — sleep alarm N-stops-before wording (every slot except the default one-stop-before).
    sleepAlarmTitle: (kind, stationName, count) =>
      kind === 'transfer'
        ? `${count} stops until transfer at ${stationName}`
        : `${count} stops until arrival at ${stationName}`,
    sleepAlarmBody: (kind) => `Wake up and get ready to ${kind === 'transfer' ? 'transfer' : 'exit'}`,
    sleepAlarmOneStopTitle: (kind) => (kind === 'transfer' ? 'Transfer alert' : 'Arrival alert'),
    sleepAlarmOneStopBody: (kind, stationName) =>
      kind === 'transfer' ? `Transfer at ${stationName} (next stop)!` : `Exit at ${stationName} (next stop)!`,
    trainReconfirmTitle: "We couldn't find your train",
    trainReconfirmBody: 'Please check again',
    tripArrivedEndedTitle: (destinationStation) => `Arrived at ${destinationStation} · Guidance ended`,
    tripArrivedEndedBody: 'You reached your destination and guidance has ended',
  },
  ja: {
    endPromptTitle: '案内を終了しますか?',
    endPromptBody: ({ destinationStation }) =>
      destinationStation
        ? `15分間動きがありません · ${destinationStation}まで案内中`
        : '15分間動きがありません',
    boardingPromptTitle: 'ご乗車されましたか?',
    boardingPromptBody: ({ originStation, line, nextStation, etaTimeStr, destinationStation }) => {
      if (!nextStation) return `${line} · ${originStation}`;
      const time = etaTimeStr ? `${etaTimeStr} ` : '';
      const dest = destinationStation ? ` (目的地 ${destinationStation})` : '';
      return `${originStation} ${line}号線 · ${time}${nextStation}方面の列車${dest}`;
    },
    hopEndPromptTitle: ({ transferStation }) => `${transferStation}で降りましたか?`,
    hopEndPromptBody: ({ transferStation, line, nextLine, nextStation }) => {
      if (!nextLine) return `${line}号線 ${transferStation}で降車してください。`;
      return nextStation ? `${nextLine}号線 ${nextStation}方面に乗り換えてください` : `${nextLine}号線に乗り換えてください`;
    },
    // #2506 — intermediateは device ja.json route.stationPassedと byte-identical。
    // transfer/destinationは既存 #2063 文言を維持。
    stationNotifTitle: (kind, stationName) => {
      if (kind === 'intermediate') return `${stationName}駅に到着`;
      if (kind === 'transfer') return `${stationName}で乗換`;
      return `${stationName}に到着`;
    },
    // #2506 — intermediateは device ja.json route.stopsRemainingToDestinationと byte-identical
    // (target=実際の乗換駅/到着駅名)。
    stationNotifBody: (kind, _stationName, counts) => {
      if (kind === 'intermediate') {
        if (counts?.targetName !== undefined && counts.count !== undefined && counts.count > 0) {
          return counts.targetKind === 'transfer'
            ? `${counts.targetName}乗換まで残り${counts.count}駅`
            : `${counts.targetName}まで残り${counts.count}駅`;
        }
        return '到着';
      }
      if (kind === 'transfer') {
        const { nextLine, nextStation } = counts ?? {};
        if (!nextLine) return 'この駅で降りて乗り換えてください';
        return nextStation
          ? `この駅で降りて${nextLine}号線 ${nextStation}方面に乗り換えてください`
          : `この駅で降りて${nextLine}号線に乗り換えてください`;
      }
      return 'この駅で降りてください';
    },
    // #3100 — 就寝アラーム N駅前(既定の1駅前以外)の文言。
    sleepAlarmTitle: (kind, stationName, count) =>
      kind === 'transfer' ? `${stationName}乗換まであと${count}駅` : `${stationName}到着まであと${count}駅`,
    sleepAlarmBody: (kind) => `起きて${kind === 'transfer' ? '乗換' : '下車'}の準備をしてください`,
    sleepAlarmOneStopTitle: (kind) => (kind === 'transfer' ? '乗換アラーム' : '到着アラーム'),
    sleepAlarmOneStopBody: (kind, stationName) =>
      kind === 'transfer' ? `次の駅 ${stationName}で乗り換えてください!` : `次の駅 ${stationName}で下車してください!`,
    trainReconfirmTitle: '乗車列車が見つかりません',
    trainReconfirmBody: 'もう一度ご確認ください',
    tripArrivedEndedTitle: (destinationStation) => `${destinationStation}に到着 · 案内終了`,
    tripArrivedEndedBody: '目的地に到着したため、ルート案内を終了しました',
  },
  zh: {
    endPromptTitle: '要结束导航吗?',
    endPromptBody: ({ destinationStation }) =>
      destinationStation ? `已 15 分钟未移动 · 导航至 ${destinationStation}` : '已 15 分钟未移动',
    boardingPromptTitle: '您已乘车了吗?',
    boardingPromptBody: ({ originStation, line, nextStation, etaTimeStr, destinationStation }) => {
      if (!nextStation) return `${line} · ${originStation}`;
      const time = etaTimeStr ? `${etaTimeStr} ` : '';
      const dest = destinationStation ? ` (目的地 ${destinationStation})` : '';
      return `${originStation} ${line}号线 · ${time}开往${nextStation}方向的列车${dest}`;
    },
    hopEndPromptTitle: ({ transferStation }) => `您在${transferStation}下车了吗?`,
    hopEndPromptBody: ({ transferStation, line, nextLine, nextStation }) => {
      if (!nextLine) return `请在${line}号线 ${transferStation}下车。`;
      return nextStation ? `请换乘${nextLine}号线 ${nextStation}方向` : `请换乘${nextLine}号线`;
    },
    // #2506 — intermediate 与 device zh.json route.stationPassed byte-identical。
    // transfer/destination 维持既有 #2063 文案。
    stationNotifTitle: (kind, stationName) => {
      if (kind === 'intermediate') return `已到达${stationName}`;
      if (kind === 'transfer') return `在${stationName}换乘`;
      return `到达${stationName}`;
    },
    // #2506 — intermediate 与 device zh.json route.stopsRemainingToDestination byte-identical
    // (target=实际换乘站/到达站名称)。
    stationNotifBody: (kind, _stationName, counts) => {
      if (kind === 'intermediate') {
        if (counts?.targetName !== undefined && counts.count !== undefined && counts.count > 0) {
          return counts.targetKind === 'transfer'
            ? `距换乘站${counts.targetName}还有${counts.count}站`
            : `距${counts.targetName}还有${counts.count}站`;
        }
        return '到达';
      }
      if (kind === 'transfer') {
        const { nextLine, nextStation } = counts ?? {};
        if (!nextLine) return '请在本站下车换乘';
        return nextStation
          ? `请在本站下车,换乘${nextLine}号线 ${nextStation}方向`
          : `请在本站下车,换乘${nextLine}号线`;
      }
      return '请在本站下车';
    },
    // #3100 — 睡眠闹钟 N 站前(默认的前 1 站以外)文案。
    sleepAlarmTitle: (kind, stationName, count) =>
      kind === 'transfer' ? `距${stationName}换乘还有${count}站` : `距${stationName}到达还有${count}站`,
    sleepAlarmBody: (kind) => `请醒来准备${kind === 'transfer' ? '换乘' : '下车'}`,
    sleepAlarmOneStopTitle: (kind) => (kind === 'transfer' ? '换乘提醒' : '到达提醒'),
    sleepAlarmOneStopBody: (kind, stationName) =>
      `下一站 ${stationName} ${kind === 'transfer' ? '请换乘' : '请下车'}!`,
    trainReconfirmTitle: '未能找到您的乘车列车',
    trainReconfirmBody: '请重新确认',
    tripArrivedEndedTitle: (destinationStation) => `已到达${destinationStation} · 导航结束`,
    tripArrivedEndedBody: '已到达目的地,路线导航已结束',
  },
};

/**
 * #3100 — 취침 알람 title/body. 기본 칸(1역 전)은 도착 임박 push(`stationNotif*`)와 구분되는
 * early 문구("다음 역 X에서 환승하세요!", 사용자 결정 2026-10-26)를, 그 외 칸은 실제 남은 정거장 수를 담은 문구를 쓴다.
 */
export function sleepAlarmContent(
  locale: SupportedLocale | undefined,
  kind: SleepAlarmKind,
  stationName: string,
  remaining: number,
): { title: string; body: string } {
  const strings = t(locale);
  if (remaining === SLEEP_ALARM_MIN_STOPS_BEFORE) {
    return { title: strings.sleepAlarmOneStopTitle(kind), body: strings.sleepAlarmOneStopBody(kind, stationName) };
  }
  return { title: strings.sleepAlarmTitle(kind, stationName, remaining), body: strings.sleepAlarmBody(kind, stationName, remaining) };
}

/**
 * 주어진 locale에 매핑된 string table 반환. 미지원/undefined는 DEFAULT_LOCALE.
 * caller는 `t(trip.locale).boardingPromptTitle` 형태로 사용.
 */
export function t(locale: SupportedLocale | undefined): I18nStrings {
  return I18N[locale ?? DEFAULT_LOCALE];
}
