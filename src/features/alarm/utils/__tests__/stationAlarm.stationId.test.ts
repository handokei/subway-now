import { evaluateAlarmPhase, resolveAllTargets } from '../stationAlarm';
import { findRoute } from '../../../../shared/utils/stationRoute';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

// #3177 PR-4 — 알람 대상이 경로의 "실제 하차 승강장 id"를 싣는다.
// 이름으로 id를 다시 찾지 않는다: 경로에 id가 없으면 undefined 그대로 (오안내 방지).
const SADANG = canonicalStationName('사당', '4');
const SINDANG = canonicalStationName('신당', '6');
const NAMBU = canonicalStationName('남부터미널', '3');
const GYODAE = canonicalStationName('교대', '2');

describe('resolveAllTargets — stationId (#3177 PR-4)', () => {
  it('direct: 목적지 id = destinationStationId', () => {
    const route = findRoute('2-022', '2-026')!;
    const targets = resolveAllTargets(route, canonicalStationName('사당', '2'));
    expect(targets.map((t) => t.stationId)).toEqual(['2-026']);
  });

  it('환승역=목적지 (강남 2호선 -> 사당 4호선): 하차 승강장은 2호선 2-026 (4-025 아님)', () => {
    const route = findRoute('2-022', '4-025')!;
    const targets = resolveAllTargets(route, SADANG);
    expect(targets).toHaveLength(1);
    expect(targets[0].stationId).toBe('2-026');
  });

  it('transfer: 환승 대상은 fromLine 쪽 id, 목적지는 destinationStationId', () => {
    const route = findRoute('2-022', '3-033')!;
    const targets = resolveAllTargets(route, NAMBU);
    expect(targets.map((t) => [t.name, t.alarmType, t.stationId])).toEqual([
      [GYODAE, 'transfer', '2-023'],
      [NAMBU, 'destination', '3-033'],
    ]);
  });

  it('multi-transfer (9-030 -> 6-026): 마지막 대상(환승역=목적지)은 2호선 2-006', () => {
    const route = findRoute('9-030', '6-026')!;
    const targets = resolveAllTargets(route, SINDANG);
    expect(targets[targets.length - 1].stationId).toBe('2-006');
    expect(targets[0].stationId).toBe('9-030');
  });

  it('경로에 id가 없으면 undefined를 그대로 싣는다 (이름 대체 조회 금지)', () => {
    const route = findRoute('2-022', '4-025')!;
    const bare = { ...route, transferStationId: undefined, destinationStationId: undefined };
    const targets = resolveAllTargets(bare, SADANG);
    expect(targets[0].stationId).toBeUndefined();
  });
});

describe('evaluateAlarmPhase — 이벤트 stationId (#3177 PR-4)', () => {
  // 방배(2-025) -> 사당(4): 남은 1정거장이라 early phase가 발사된다.
  const source = (extra: object = {}) => ({
    route: findRoute('2-025', '4-025')!,
    destinationName: SADANG,
    etaSeconds: null,
    currentLine: '2' as const,
    ...extra,
  });

  it('방배 -> 사당(4): 발사 이벤트가 하차 승강장 2-026을 싣는다', () => {
    const event = evaluateAlarmPhase(source(), new Set());
    expect(event).not.toBeNull();
    expect(event!.stationName).toBe(SADANG);
    expect(event!.stationId).toBe('2-026');
  });

  it('dedup suppressed / heldOut 이벤트도 stationId를 싣는다', () => {
    const first = evaluateAlarmPhase(source(), new Set())!;
    const suppressed: any[] = [];
    evaluateAlarmPhase(source(), new Set([`${first.phaseId}:${first.stationName}`]), undefined, suppressed);
    expect(suppressed[0].stationId).toBe('2-026');

    const held: any[] = [];
    evaluateAlarmPhase(source({ departed: false }), new Set(), undefined, undefined, held);
    expect(held[0].stationId).toBe('2-026');
  });
});
