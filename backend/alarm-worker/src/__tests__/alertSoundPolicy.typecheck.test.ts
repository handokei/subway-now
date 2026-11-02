/**
 * #2510 재오픈 — 타입 레벨 제약. `npm run type-check`(tsc)가 검증한다: 아래 `@ts-expect-error`는
 * "에러가 없으면 오히려 에러"이므로 제약이 풀리면 tsc가 red가 된다. (런타임 it은 형식상 존재.)
 */
import { describe, expect, it } from 'vitest';
import {
  STATION_ALERT_POLICY,
  sendStationAlert,
  type ArrivalContent,
  type OneStopContent,
  type StationAlertKind,
} from '../alertSoundPolicy';
import { buildStationNotifContent } from '../scheduled';
import { sleepAlarmContent } from '../i18n';
import type { Trip, Waypoint } from '../types';

type NormalRow = (typeof STATION_ALERT_POLICY.normal)[StationAlertKind];
type NormalSound = NormalRow extends infer R ? (R extends { sound: infer S } ? S : never) : never;

declare const trip: Trip;
declare const waypoint: Waypoint;
declare const options: Parameters<typeof sendStationAlert>[3];

/** 호출되지 않는다 — 컴파일(tsc)만이 의미다. `declare const` 값은 런타임에 존재하지 않는다. */
function typeLevelChecks(): void {
  // 1) 일반 행 sound 타입에 'alarm.wav'가 없다 — 표의 일반 행에 alarm.wav를 넣으면 이 대입이 컴파일 에러.
  const normalHasNoAlarm: 'alarm.wav' extends NormalSound ? false : true = true;

  // 2) 1역 전 push에 도착 문구(#3237 사고 재발) 불가, 반대 방향도 불가.
  const arrival: ArrivalContent = buildStationNotifContent(trip, waypoint, undefined);
  // @ts-expect-error ArrivalContent 는 OneStopContent 자리에 들어가지 않는다
  void sendStationAlert(trip, 'one-stop', arrival, options);
  const oneStop: OneStopContent = sleepAlarmContent(undefined, 'transfer', 'x', 1);
  // @ts-expect-error OneStopContent 는 ArrivalContent 자리에 들어가지 않는다
  void sendStationAlert(trip, 'arrival-transfer', oneStop, options);

  // 3) Record<StationAlertKind, …> — kind 하나 누락 불가.
  // @ts-expect-error 'arrival-intermediate' 누락
  const missingKind: Record<StationAlertKind, unknown> = {
    'one-stop': 1,
    'arrival-transfer': 1,
    'arrival-destination': 1,
  };
  void [normalHasNoAlarm, missingKind];
}

describe('alertSoundPolicy 타입 제약 (tsc가 강제)', () => {
  it('제약 본체는 typeLevelChecks의 @ts-expect-error / 조건부 타입 대입이다 — `npm run type-check`가 red/green을 낸다', () => {
    expect(typeLevelChecks).toBeTypeOf('function');
    expect(Object.keys(STATION_ALERT_POLICY).sort()).toEqual(['normal', 'sleep']);
  });
});
