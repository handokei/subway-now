/**
 * #3177 — waypoint.stationId(실제 하차 승강장의 stations.json id)의 backend↔device wire 계약 fixture.
 *
 * `boardingPromptTrainCodeWireFixture.ts`(#2655)와 같은 패턴: backend 테스트
 * (`backend/alarm-worker/src/__tests__/wire_20261030_station_id.test.ts`)가 "이 shape을 wire에 싣는지"를,
 * device 테스트가 "이 shape을 올바르게 소비하는지"를 각자 assert해 경계를 넘는 단일 계약으로 묶는다.
 *
 * 순수 데이터 모듈 — 런타임 동작 없음. backend `tsconfig.json`의 `include`에 이 파일 경로가 있어야
 * backend `tsc --noEmit`이 통과한다.
 */

/** 강남(2호선) → 사당(4호선 목적지) 경로의 환승 waypoint — 실제로 내리는 곳은 2호선 사당(2-026)이다. */
export const STATION_PUSH_WIRE_FIXTURE = {
  nextWaypoint: '사당',
  etaSeconds: 0,
  phase: 'imminent' as const,
  kind: 'transfer' as const,
  sentAt: 1761800000000,
  pushId: 'wire-fx-3177-push-1',
  stationId: '2-026',
} as const;

/** stationId가 없는 waypoint(구 device 등록) — wire에 필드 자체가 없어야 한다. */
export const STATION_PUSH_WIRE_FIXTURE_NO_STATION_ID = {
  nextWaypoint: '사당',
  etaSeconds: 0,
  phase: 'imminent' as const,
  kind: 'transfer' as const,
  sentAt: 1761800000001,
  pushId: 'wire-fx-3177-push-2',
} as const;
