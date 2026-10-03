import { evaluateAlarmPhase, hasDepartedBoardingStation, type AlarmSource } from '../stationAlarm';
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

// #2703 — BG(stationPipeline.ts)는 이 게이트 도입(#2688/#2702) 이전부터 인라인으로
// `nearest.station.id !== lockForLineGuard.boardingStationId`를 계산했다. FG(useStationAlarm.ts)를
// 같은 채널 비대칭 결함 클래스(#2373/#2306)로 만들지 않으려면 두 채널이 정확히 같은 신호로
// departed를 산출해야 한다 — hasDepartedBoardingStation은 그 단일 출처이며, 이 테스트는
// BG의 원래 인라인 표현과 동일한 값을 내는지(대칭성) 고정한다.
describe('#2703 — hasDepartedBoardingStation: BG/FG 공유 신호 대칭성', () => {
  const lock = { boardingStationId: 'S-BOARD' };

  it('현재역이 승차역과 같으면(아직 출발 전) false — BG 인라인 표현과 동일', () => {
    const currentStationId = 'S-BOARD';
    expect(hasDepartedBoardingStation(lock, currentStationId)).toBe(false);
    // BG stationPipeline.ts의 원래 인라인 표현과 값이 일치하는지 직접 대조.
    expect(hasDepartedBoardingStation(lock, currentStationId)).toBe(
      currentStationId !== lock.boardingStationId,
    );
  });

  it('현재역이 승차역과 다르면(출발 확인) true — BG 인라인 표현과 동일', () => {
    const currentStationId = 'S-NEXT';
    expect(hasDepartedBoardingStation(lock, currentStationId)).toBe(true);
    expect(hasDepartedBoardingStation(lock, currentStationId)).toBe(
      currentStationId !== lock.boardingStationId,
    );
  });

  it('lock이 없으면(lockless) undefined — 게이트 미적용', () => {
    expect(hasDepartedBoardingStation(null, 'S-ANY')).toBeUndefined();
  });

  it('현재역 신호가 없으면(null/undefined) undefined — 게이트 미적용', () => {
    expect(hasDepartedBoardingStation(lock, null)).toBeUndefined();
    expect(hasDepartedBoardingStation(lock, undefined)).toBeUndefined();
  });
});
