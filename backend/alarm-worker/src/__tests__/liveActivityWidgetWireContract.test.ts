import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLiveActivityContentState } from '../liveActivity';
import type { Trip, Waypoint } from '../types';

/**
 * #2747 — wire contract: backend `buildLiveActivityContentState`가 emit하는 모든
 * ContentState 필드는 위젯 Swift 소스(`SubwayLiveActivityWidget.swift` 또는
 * `_shared/SubwayActivityAttributes.swift`) 어딘가에서 실제로 참조되어야 한다 —
 * 직접 읽거나, `resolvedXxx` 파생 helper를 통해서든.
 *
 * ActivityKit의 update는 content-state 전체 교체다(`liveActivity.ts` 주석 참고). backend가
 * 채우는 필드를 위젯이 하나도 읽지 않으면, 그 필드는 "채워지지만 절대 화면에 안 보이는" 상태가
 * 되고, JS init이 채운 텍스트가 첫 backend push에 덮이면서 화면이 오히려 빈약해진다
 * (#2747 사용자 보고 — lock 이후 "역 → 목적지"만 남음).
 *
 * 노출하지 않기로 결정한 필드는 `NOT_EXPOSED_ALLOWLIST`에 근거와 함께 명시한다 — 조용히
 * 통과시키지 않는다 (#2747 요구사항 4).
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const WIDGET_SWIFT = readFileSync(
  resolve(REPO_ROOT, 'targets/subway-widget/SubwayLiveActivityWidget.swift'),
  'utf-8',
);
const SHARED_ATTRS_SWIFT = readFileSync(
  resolve(REPO_ROOT, 'targets/subway-widget/_shared/SubwayActivityAttributes.swift'),
  'utf-8',
);

/** 주석(// ...) 라인은 필드명이 설명 목적으로만 언급될 수 있어 "실제 참조"로 인정하지 않는다. */
function stripLineComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const WIDGET_CODE = stripLineComments(WIDGET_SWIFT);
const SHARED_CODE = stripLineComments(SHARED_ATTRS_SWIFT);

/** "var field: Type" 선언 라인 자체는 참조가 아니므로 제외하고 식별자 참조 여부를 검사한다. */
function stripDeclarationLine(code: string, field: string): string {
  const declarationPattern = new RegExp(`var\\s+${field}\\s*:`);
  return code
    .split('\n')
    .filter((line) => !declarationPattern.test(line))
    .join('\n');
}

function isReferencedInWidgetSource(field: string): boolean {
  const identifierPattern = new RegExp(`\\b${field}\\b`);
  return (
    identifierPattern.test(stripDeclarationLine(WIDGET_CODE, field)) ||
    identifierPattern.test(stripDeclarationLine(SHARED_CODE, field))
  );
}

/**
 * 노출하지 않기로 결정한 필드 (#2747 요구사항 4) — 항목별 근거.
 *
 * 2차 환승(second transfer) chain은 lock screen 잠금화면 폭 제약상 노출하지 않는다. 1차
 * 환승(transferStationName/stopsToTransfer)까지만 routeSubtext 파생으로 노출한다. backend는
 * 계속 emit한다(이 PR에서 지우지 않음) — Dynamic Island 확장(ExpandedRouteView) 등 더 넓은
 * 표면이 생기면 재검토할 수 있도록 값 자체는 살려둔다. 노출 여부만 위젯 쪽 결정이다.
 */
/**
 * 노출하지 않기로 결정한 필드 (#2747 요구사항 4) — 항목별 근거.
 *
 * 2차 환승(second transfer) chain은 lock screen 잠금화면 폭 제약상 노출하지 않는다. 1차
 * 환승(transferStationName/stopsToTransfer)까지만 `resolvedRouteSubtext`로 파생 노출한다
 * (`_shared/SubwayActivityAttributes.swift`). backend는 계속 emit한다(이 PR에서 지우지 않음) —
 * Dynamic Island 확장(ExpandedRouteView) 등 더 넓은 표면이 생기면 재검토할 수 있도록 값 자체는
 * 살려둔다. 노출 여부만 위젯 쪽 결정이다.
 */
const NOT_EXPOSED_ALLOWLIST: Record<string, string> = {
  stopsFromTransfer:
    '#2747 — single-transfer 이후 남은 정거장 수. lock screen 폭 제약으로 1차 환승 지점까지의 진행(transferStationName/stopsToTransfer)만 노출하고, 환승 이후 잔여는 노출하지 않는다. destinationName/stopsRemaining 조합으로 최종 도착 정보는 이미 커버.',
  stopsToSecondTransfer:
    '#2747 — 2차 환승까지의 정거장 수. 이중 환승 trip은 드물고, lock screen 한 줄에 2단계 환승 체인을 모두 담으면 정보 과밀 — 1차 환승만 노출. 후속 이슈로 Dynamic Island 확장 시 재검토 제안.',
  secondTransferStationName:
    '#2747 — 2차 환승역 이름. 위 stopsToSecondTransfer와 동일 근거(정보 과밀) — 2차 환승 노출은 세트로 판단해야 하므로 함께 보류.',
  stopsAfterLastTransfer:
    '#2747 — 마지막 환승 이후 최종 목적지까지 남은 정거장 수. 2차 환승 자체를 노출하지 않기로 했으므로 그 이후 값도 함께 보류.',
};

describe('LA ContentState wire contract (#2747)', () => {
  it('backend가 emit하는 모든 필드는 위젯 Swift 소스에서 참조되거나 명시적 allowlist에 있어야 한다', () => {
    const trackedWaypoint: Waypoint = { stationName: '시청', line: '2', kind: 'transfer' };
    const trip: Trip = {
      token: 'devtoken',
      route: { type: 'direct', line: '2', stops: 7 },
      destination: '강남',
      waypoints: [
        { stationName: 'A', line: '2', kind: 'intermediate' },
        { stationName: '시청', line: '2', kind: 'transfer' },
        { stationName: 'C', line: '1', kind: 'intermediate' },
        { stationName: '동대문', line: '1', kind: 'transfer' },
        { stationName: 'E', line: '4', kind: 'intermediate' },
        { stationName: 'F', line: '4', kind: 'intermediate' },
        { stationName: '강남', line: '4', kind: 'destination' },
      ],
      expiresAt: 0,
      createdAt: 0,
      alarmAtEpochMs: 0,
      activityPushToken: 'la-token',
      activityState: 'live',
      apnsEnv: 'sandbox',
    };
    // multi-transfer trip 전달 → 8개 대상 필드(stopsRemaining/etaMinutes/transferStationName/
    // stopsToTransfer/secondTransferStationName/stopsToSecondTransfer/stopsAfterLastTransfer/
    // stopsFromTransfer 중 이 픽스처에서는 stopsFromTransfer만 undefined)가 emit되는지 먼저 확인.
    const cs = buildLiveActivityContentState(trackedWaypoint, 90, 7, trip);
    const emittedFields = Object.keys(cs);

    // 회귀 가드 — 이 픽스처가 실제로 문제의 필드들을 채운 상태에서 도는지 확인.
    expect(emittedFields).toEqual(
      expect.arrayContaining([
        'stationName',
        'lineName',
        'lineColorHex',
        'stopsRemaining',
        'etaMinutes',
        'destinationName',
        'transferStationName',
        'stopsToTransfer',
        'secondTransferStationName',
        'stopsToSecondTransfer',
        'stopsAfterLastTransfer',
      ]),
    );

    const unreferencedAndNotAllowlisted = emittedFields.filter(
      (field) => !isReferencedInWidgetSource(field) && !(field in NOT_EXPOSED_ALLOWLIST),
    );

    // 실패 시 vitest diff에 "어떤 필드가 위젯 소스 어디서도 참조되지 않는지"가 그대로 나온다 —
    // 이것이 곧 실패 사유다.
    expect(unreferencedAndNotAllowlisted).toEqual([]);
  });

  it('allowlist 항목은 실제로 위젯 소스에서 참조되지 않는 상태다 (노출하게 되면 이 assertion이 깨져 allowlist 정리를 강제한다)', () => {
    for (const field of Object.keys(NOT_EXPOSED_ALLOWLIST)) {
      expect(isReferencedInWidgetSource(field)).toBe(false);
    }
  });

  it('single-transfer trip(stopsFromTransfer 포함)에서도 노출 대상 필드는 참조된다', () => {
    const trackedWaypoint: Waypoint = { stationName: 'A', line: '2', kind: 'intermediate' };
    const trip: Trip = {
      token: 'devtoken2',
      route: { type: 'direct', line: '2', stops: 4 },
      destination: '강남',
      waypoints: [
        { stationName: 'A', line: '2', kind: 'intermediate' },
        { stationName: '시청', line: '2', kind: 'transfer' },
        { stationName: 'C', line: '1', kind: 'intermediate' },
        { stationName: '강남', line: '1', kind: 'destination' },
      ],
      expiresAt: 0,
      createdAt: 0,
      alarmAtEpochMs: 0,
      activityPushToken: 'la-token',
      activityState: 'live',
      apnsEnv: 'sandbox',
    };
    const cs = buildLiveActivityContentState(trackedWaypoint, 60, 4, trip);
    expect(cs.stopsFromTransfer).toBeDefined();

    const emittedFields = Object.keys(cs);
    const unreferencedAndNotAllowlisted = emittedFields.filter(
      (field) => !isReferencedInWidgetSource(field) && !(field in NOT_EXPOSED_ALLOWLIST),
    );
    expect(unreferencedAndNotAllowlisted).toEqual([]);
  });
});
