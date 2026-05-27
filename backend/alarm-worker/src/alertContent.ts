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
 *
 * 백엔드에는 i18next가 없고 사용자 locale도 알 수 없어 한국어 정적 문자열로 고정.
 * 영문 locale 지원이 필요해지면 디바이스 register 시점에 locale을 trip에 함께 저장하고
 * 여기서 lookup하도록 확장한다.
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

export function buildAlertContent(input: AlertContentInput): AlertContent {
  if (input.kind === 'intermediate') {
    return { title: INTERMEDIATE_TITLE, body: intermediateBody(input.stationName) };
  }
  return {
    title: ARRIVAL_TITLE[input.kind][input.phase],
    body: ARRIVAL_BODY[input.kind][input.phase](input.stationName),
  };
}
