import {
  ALARM_EVENT_TYPES,
  CONTROL_PUSH_KINDS,
  SLEEP_ALARM_TARGET_KINDS,
  STATION_WAYPOINT_KINDS,
  PUSH_ALARM_PHASES,
  PUSH_ETA_SECONDS_MAX,
  UNKNOWN_KIND_POLICY,
  assertNever,
  isControlPushKind,
  isPushAlarmPhase,
  isSleepAlarmTargetKind,
  isStationWaypointKind,
  isValidEtaSeconds,
  isValidStationIdentifier,
  type StationWaypointKind,
} from '../pushContract';

/**
 * #2235 (ADR-029 Phase 0) — device 측 exhaustive switch 데모. backend/device 양쪽이 이 파일과
 * 동일한 SSoT(`StationWaypointKind`)를 참조한다고 가정한 최소 재현. 실제 소비 지점은
 * `src/features/alarm/tasks/silentPushTask.ts`의 `handleSilentPush` control-kind switch.
 */
function exhaustiveStationKindSwitch(kind: StationWaypointKind): string {
  switch (kind) {
    case 'transfer':
      return 'transfer';
    case 'destination':
      return 'destination';
    case 'intermediate':
      return 'intermediate';
    default:
      return assertNever(kind, 'pushContract.test demo');
  }
}

describe('pushContract SSoT (#2235 ADR-029 Phase 0)', () => {
  it('STATION_WAYPOINT_KINDS 각 값을 exhaustive switch가 정상 처리한다', () => {
    for (const kind of STATION_WAYPOINT_KINDS) {
      expect(exhaustiveStationKindSwitch(kind)).toBe(kind);
    }
  });

  it('isStationWaypointKind는 SSoT 배열에 있는 값만 narrow한다', () => {
    expect(isStationWaypointKind('transfer')).toBe(true);
    expect(isStationWaypointKind('destination')).toBe(true);
    expect(isStationWaypointKind('intermediate')).toBe(true);
    expect(isStationWaypointKind('unknown-kind')).toBe(false);
    expect(isStationWaypointKind(undefined)).toBe(false);
  });

  it('isControlPushKind는 CONTROL_PUSH_KINDS 배열에 있는 값만 narrow한다', () => {
    for (const kind of CONTROL_PUSH_KINDS) {
      expect(isControlPushKind(kind)).toBe(true);
    }
    expect(isControlPushKind('not-a-control-kind')).toBe(false);
  });

  it('isSleepAlarmTargetKind는 SLEEP_ALARM_TARGET_KINDS 배열에 있는 값만 narrow한다', () => {
    for (const kind of SLEEP_ALARM_TARGET_KINDS) {
      expect(isSleepAlarmTargetKind(kind)).toBe(true);
    }
    expect(isSleepAlarmTargetKind('intermediate')).toBe(false);
  });

  it('ALARM_EVENT_TYPES SSoT 배열이 backend AlarmEventPayload.type과 정렬된 4종을 갖는다', () => {
    expect(ALARM_EVENT_TYPES).toEqual([
      'station-passed',
      'transfer',
      'destination',
      'imminent',
    ]);
  });

  it(
    'A1 실증 — SSoT에 없는 값을 exhaustive switch에 강제로 전달하면 컴파일 에러가 난다. ' +
      '이는 "backend가 새 kind를 추가했는데 device exhaustive switch가 갱신되지 않은" 드리프트 ' +
      '시나리오의 최소 재현이다: 아래 @ts-expect-error가 없으면 `npm run type-check`가 실패한다.',
    () => {
      expect(() => {
        // @ts-expect-error — 'imminent-hop'은 StationWaypointKind(SSoT)에 없는 값. 새 discriminator를
        // pushContract에 추가하지 않고 소비 지점에 억지로 통과시키면, switch의 어떤 case에도 매치되지
        // 않아 default(assertNever)로 떨어지고 assertNever의 파라미터 타입(never)과 불일치해 컴파일
        // 에러가 난다 — 드리프트가 런타임 사고가 아니라 빌드 실패로 전환됨을 실증한다(ADR-029).
        exhaustiveStationKindSwitch('imminent-hop');
      }).toThrow(/pushContract: unhandled discriminator/);
    },
  );

  it('assertNever는 런타임에 도달하면(타입 시스템 우회 시) 명시적으로 throw한다', () => {
    expect(() =>
      // @ts-expect-error — never 파라미터에 임의 문자열을 강제 전달(런타임 방어 동작 검증용).
      assertNever('not-a-real-discriminator'),
    ).toThrow(/pushContract: unhandled discriminator/);
  });

  it('assertNever는 context가 없어도 throw 메시지를 생성한다', () => {
    expect(() =>
      // @ts-expect-error — never 파라미터에 임의 문자열을 강제 전달(context 생략 케이스).
      assertNever('no-context-case'),
    ).toThrow('pushContract: unhandled discriminator: "no-context-case"');
  });
});

describe('pushContract G2/G6 (#2243, ADR-029 Phase 1)', () => {
  it('UNKNOWN_KIND_POLICY — station-like는 fallback fire, control-like는 fail-closed', () => {
    expect(UNKNOWN_KIND_POLICY.stationLike).toBe('fallback-imminent-fire');
    expect(UNKNOWN_KIND_POLICY.controlLike).toBe('fail-closed');
  });

  it('isValidStationIdentifier — 비어있지 않고 상한 이내, 제어문자 없는 문자열만 통과', () => {
    expect(isValidStationIdentifier('강남')).toBe(true);
    expect(isValidStationIdentifier('동대문역사문화공원')).toBe(true);
    expect(isValidStationIdentifier('')).toBe(false);
    expect(isValidStationIdentifier('   ')).toBe(false);
    expect(isValidStationIdentifier('a'.repeat(41))).toBe(false);
    expect(isValidStationIdentifier('a'.repeat(40))).toBe(true);
    expect(isValidStationIdentifier(`bad\nname`)).toBe(false);
    expect(isValidStationIdentifier(123)).toBe(false);
    expect(isValidStationIdentifier(undefined)).toBe(false);
  });

  it('PUSH_ALARM_PHASES / isPushAlarmPhase — early/imminent만 narrow', () => {
    expect(PUSH_ALARM_PHASES).toEqual(['early', 'imminent']);
    expect(isPushAlarmPhase('early')).toBe(true);
    expect(isPushAlarmPhase('imminent')).toBe(true);
    expect(isPushAlarmPhase('late')).toBe(false);
    expect(isPushAlarmPhase(undefined)).toBe(false);
  });

  it('isValidEtaSeconds — 0 이상 PUSH_ETA_SECONDS_MAX 이하 finite number만 통과', () => {
    expect(isValidEtaSeconds(0)).toBe(true);
    expect(isValidEtaSeconds(120)).toBe(true);
    expect(isValidEtaSeconds(PUSH_ETA_SECONDS_MAX)).toBe(true);
    expect(isValidEtaSeconds(PUSH_ETA_SECONDS_MAX + 1)).toBe(false);
    expect(isValidEtaSeconds(-1)).toBe(false);
    expect(isValidEtaSeconds(NaN)).toBe(false);
    expect(isValidEtaSeconds(Infinity)).toBe(false);
    expect(isValidEtaSeconds('120')).toBe(false);
  });
});
