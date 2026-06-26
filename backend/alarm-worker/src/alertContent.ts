/**
 * Alert push 본문 생성 (#570 P2d).
 *
 * 채널 2(alert fallback)가 silent push 30s 미ACK 케이스에서 발사할 alert push의
 * title/body를 만든다. 디바이스 측 `src/utils/stationNotification.ts:buildAlarmContent`
 * + `src/i18n/locales/ko.json`의 문자열과 **바이트 동일**.
 *
 * ⚠️ 동기화 주의: 아래 6개 문자열을 변경할 때 반드시 디바이스 i18n도 같이 수정한다.
 * 어긋나면 잠금화면에 silent push와 다른 본문이 떠 운영 사고로 직결된다.
 *   - destination/early   ↔ ko.json notifications.arrivalEarlyTitle + alarms.earlyArrivalBody
 *   - destination/imminent ↔ ko.json notifications.arrivalImminentTitle + alarms.imminentArrivalBody
 *   - transfer/early      ↔ ko.json notifications.transferEarlyTitle + alarms.earlyTransferBody
 *   - transfer/imminent   ↔ ko.json notifications.transferImminentTitle + alarms.imminentTransferBody
 *   - intermediate        ↔ ko.json route.intermediatePassedTitle + route.intermediatePassedBody
 *   - trip-ended          ↔ ko.json route.tripEndedTitle + route.tripEndedBody
 *
 * 본 파일의 alert 본문은 silent push fallback 채널 — 한국어 정적 문자열로 유지.
 * #1895(boarding-prompt push) 이후 backend i18n 4언어 분기 인프라가 도입됐으나(`i18n.ts`),
 * 본 fallback 본문은 디바이스 i18n과 byte-identical을 유지해야 silent push가 device에서
 * 발사된 본문과 alert fallback이 어긋나지 않으므로 한국어 고정 — 변경 시 디바이스 ko.json도 함께 수정.
 * 다른 push kind(station-passed, arrival, transfer, alighting)의 4언어 분기는 device-side
 * stationNotification.ts가 처리한다(silent push payload → device가 본문 빌드).
 *
 * exitSide/quickHint suffix는 백엔드에 GPS 정보가 없어 생략 — alert는 보조 채널이라
 * "어느 문으로 하차" 같은 정밀 정보 없이도 충분히 의미를 전달한다.
 */

import type { AlarmPhase } from './alarm';

/**
 * Alert 본문 입력. intermediate는 phase 무관 단일 본문이라 phase 필드 자체가 없다 —
 * caller가 잘못된 phase를 전달하지 못하도록 타입 레벨에서 차단(P2c 작성 시 컴파일 타임 캐치).
 */
export type AlertContentInput =
  | { kind: 'destination' | 'transfer'; phase: AlarmPhase; stationName: string }
  | { kind: 'intermediate'; stationName: string };

export interface AlertContent {
  title: string;
  body: string;
}

// 디바이스 ko.json과 1:1 매핑. 새 phase/kind가 추가되면 여기 한 곳만 손댄다.
const ARRIVAL_TITLE: Record<'destination' | 'transfer', Record<AlarmPhase, string>> = {
  destination: {
    early: '하차 알림',
    imminent: '도착 임박',
  },
  transfer: {
    early: '환승 알림',
    imminent: '환승 임박',
  },
};

const ARRIVAL_BODY: Record<
  'destination' | 'transfer',
  Record<AlarmPhase, (station: string) => string>
> = {
  destination: {
    early: (s) => `다음 역 ${s}에서 하차하세요!`,
    imminent: (s) => `곧 ${s}에 도착합니다. 하차 준비하세요!`,
  },
  transfer: {
    early: (s) => `다음 역 ${s}에서 환승하세요!`,
    imminent: (s) => `곧 ${s}에 도착합니다. 환승 준비하세요!`,
  },
};

const INTERMEDIATE_TITLE = '역 통과';
const intermediateBody = (s: string) => `${s}역을 지나고 있어요`;

/**
 * Trip-ended alert push 본문 상수 (#1337). server-side trip 종료를 killed 앱에도 즉시
 * 표시하기 위해 silent → alert 전환(`sendTripEndedAlertPush`)할 때 사용한다.
 * 디바이스 i18n(`ko.json` `route.tripEndedTitle` / `route.tripEndedBody`)과 byte-identical.
 */
export const TRIP_ENDED_ALERT_TITLE = '안내 종료';
export const TRIP_ENDED_ALERT_BODY = '경로 안내를 종료했어요';

export function buildAlertContent(input: AlertContentInput): AlertContent {
  if (input.kind === 'intermediate') {
    return { title: INTERMEDIATE_TITLE, body: intermediateBody(input.stationName) };
  }
  return {
    title: ARRIVAL_TITLE[input.kind][input.phase],
    body: ARRIVAL_BODY[input.kind][input.phase](input.stationName),
  };
}
