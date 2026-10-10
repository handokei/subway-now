import { Share } from 'react-native';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import type { LineNumber } from '../../../shared/types/station';

/**
 * Share A — 시스템 텍스트 공유.
 *
 * Trip 카드(출발/도착/소요시간/정거장 수)를 OS 공유 시트로 보낼 수 있도록
 * 순수 텍스트를 만든다. UI 와이어는 후속 PR (#1062 등과 충돌 회피).
 *
 * - i18n은 호출자가 t를 주입한다 (테스트 시 결정적, 하드코딩 한국어 회피).
 * - Route 종류(direct/transfer/multi-transfer)에 의존하지 않고
 *   상위에서 미리 계산한 totalStops / travelMinutes 만 받는다.
 */

type TFunction = (key: string, options?: Record<string, unknown>) => string;

export interface ShareTripInput {
  route: Route;
  currentStation: Station | null;
  destination: Station | null;
  totalStops: number;
  travelMinutes: number;
  t: TFunction;
}

function lineLabel(t: TFunction, line: LineNumber): string {
  // ko/en/ja/zh 모두 lines.<number> 네임스페이스 보유.
  return t(`lines.${line}`);
}

/**
 * 공유 본문 문자열을 만든다. 누락 정보가 있으면 null을 반환해
 * 호출자가 버튼을 비활성화할 수 있게 한다.
 */
export function buildShareTripText(input: ShareTripInput): string | null {
  const { route, currentStation, destination, totalStops, travelMinutes, t } = input;
  if (!route || !currentStation || !destination) return null;

  return t('share.trip.bodyTemplate', {
    fromName: currentStation.name,
    fromLine: lineLabel(t, currentStation.line),
    toName: destination.name,
    toLine: lineLabel(t, destination.line),
    minutes: travelMinutes,
    stops: totalStops,
  });
}

/**
 * Share.share()로 OS 공유 시트를 띄운다. 누락된 정보면 false 반환.
 * 예외 발생 시 false 반환 (호출자는 토스트 등으로 처리 가능).
 */
export async function shareTripIntent(input: ShareTripInput): Promise<boolean> {
  const message = buildShareTripText(input);
  if (!message) return false;
  try {
    await Share.share({
      title: input.t('share.trip.title'),
      message,
    });
    return true;
  } catch {
    return false;
  }
}
