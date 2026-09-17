import { evaluateAlarmPhase, type AlarmSource } from '../stationAlarm';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';

// #2688 — 2026-09-17 아침 성수→뚝섬 실측(06:43:58 lock-create, 06:44:38 fired early, 40초).
// 목적지가 승차역에서 정확히 1정거장이면 remainingStops<=1이 탑승 순간 이미 참이라 early가
// 승차 즉시 발사됐다. departed=false(출발 미확인) 동안은 보류하고, departed=true(출발 확인)면
// 그대로 발사되는지 고정한다.
describe('#2688 — early phase departure gate (1-stop leg)', () => {
  it('탑승 즉시(departed=false)는 early를 보류한다', () => {
    const route = makeDirectRoute(1, '2');
    const src: AlarmSource = {
      route,
      destinationName: '뚝섬',
      etaSeconds: null,
      currentLine: '2',
      departed: false,
    };
    expect(evaluateAlarmPhase(src, new Set())).toBeNull();
  });

  it('출발 확인(departed=true) 후에는 동일 조건에서 그대로 발사된다 — 영구 침묵 아님', () => {
    const route = makeDirectRoute(1, '2');
    const src: AlarmSource = {
      route,
      destinationName: '뚝섬',
      etaSeconds: null,
      currentLine: '2',
      departed: true,
    };
    expect(evaluateAlarmPhase(src, new Set())).toEqual({
      phaseId: 'early',
      type: 'destination',
      stationName: '뚝섬',
    });
  });

  it('departed 미전달(lockless 등 신호 없음)은 기존 동작 그대로 즉시 발사한다', () => {
    const route = makeDirectRoute(1, '2');
    const src: AlarmSource = {
      route,
      destinationName: '뚝섬',
      etaSeconds: null,
      currentLine: '2',
    };
    expect(evaluateAlarmPhase(src, new Set())).toEqual({
      phaseId: 'early',
      type: 'destination',
      stationName: '뚝섬',
    });
  });

  it('heldOut — departed=false로 보류된 이벤트를 계측용 배열에 적재한다', () => {
    const route = makeDirectRoute(1, '2');
    const src: AlarmSource = {
      route,
      destinationName: '뚝섬',
      etaSeconds: null,
      currentLine: '2',
      departed: false,
    };
    const heldOut: import('../stationAlarm').AlarmEvent[] = [];
    const result = evaluateAlarmPhase(src, new Set(), undefined, undefined, heldOut);
    expect(result).toBeNull();
    expect(heldOut).toEqual([{ phaseId: 'early', type: 'destination', stationName: '뚝섬' }]);
  });

  it('2정거장 이상 일반 구간은 departed=false여도 remainingStops>1이면 early가 애초에 미충족 — heldOut에 적재 안 함(회귀 방지)', () => {
    const route = makeDirectRoute(2, '2');
    const src: AlarmSource = {
      route,
      destinationName: '강남',
      etaSeconds: null,
      currentLine: '2',
      departed: false,
    };
    const heldOut: import('../stationAlarm').AlarmEvent[] = [];
    const result = evaluateAlarmPhase(src, new Set(), undefined, undefined, heldOut);
    expect(result).toBeNull();
    expect(heldOut).toEqual([]);
  });
});
