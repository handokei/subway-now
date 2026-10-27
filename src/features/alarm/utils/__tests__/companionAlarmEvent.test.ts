/**
 * #3100 — companion 수신 시 오버레이/LA에 넘길 AlarmEvent 조립.
 * stationId·direction은 phase 이벤트와 같은 조회(resolveAllTargets / resolveAlarmDirection)로 채우고,
 * 못 찾으면 필드를 생략한다(출구 안내만 빠지고 오버레이·진동은 정상).
 */
import { buildCompanionAlarmEvent } from '../companionAlarmEvent';
import { resolveAlarmDirection } from '../alarmDirection';
import { makeDirectRoute, makeTransferRoute, makeMultiTransferRoute } from '../../../../testUtils/routeFixtures';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

const 교대 = canonicalStationName('교대', '2');
const 강남 = canonicalStationName('강남', '2');
const 역삼 = canonicalStationName('역삼', '2');
const 서울역 = canonicalStationName('서울역', '1');

const TRANSFER_ROUTE = {
  ...makeTransferRoute({ transferName: 교대, fromLine: '2', toLine: '3', stopsToTransfer: 4, stopsFromTransfer: 3 }),
  transferStationId: '2-교대',
  destinationStationId: '3-목적',
};

describe('buildCompanionAlarmEvent', () => {
  it('환승 타깃: stationId·direction을 phase와 같은 조회로 채운다', () => {
    const event = buildCompanionAlarmEvent({
      route: TRANSFER_ROUTE,
      destinationName: 강남,
      nextStation: 교대,
      nextLine: '2',
      targetKind: 'transfer',
      originStation: 역삼,
      band: 3,
    });
    expect(event).toEqual({
      phaseId: 'early',
      type: 'transfer',
      stationName: 교대,
      stationId: '2-교대',
      direction: resolveAlarmDirection(
        { type: 'transfer', stationName: 교대 },
        { route: TRANSFER_ROUTE, destinationName: 강남, sourceStationName: 역삼 },
      ),
      band: 3,
    });
    expect(event.direction).toBeDefined();
  });

  it('도착 타깃(환승 후 구간): 도착역 stationId', () => {
    const event = buildCompanionAlarmEvent({
      route: TRANSFER_ROUTE,
      destinationName: 강남,
      nextStation: 강남,
      nextLine: '3',
      targetKind: 'destination',
      originStation: 교대,
    });
    expect(event.stationId).toBe('3-목적');
    expect(event.type).toBe('destination');
  });

  it('band 미지정(기본 1역 전 칸)이면 band 키가 없다', () => {
    const event = buildCompanionAlarmEvent({
      route: TRANSFER_ROUTE,
      destinationName: 강남,
      nextStation: 교대,
      nextLine: '2',
      targetKind: 'transfer',
      originStation: 역삼,
    });
    expect(Object.prototype.hasOwnProperty.call(event, 'band')).toBe(false);
  });

  it('route가 없으면 stationId·direction 없이 기본 필드만 (오버레이는 뜬다)', () => {
    const event = buildCompanionAlarmEvent({
      route: null,
      destinationName: null,
      nextStation: 교대,
      nextLine: '2',
      targetKind: 'transfer',
      originStation: 역삼,
      band: 2,
    });
    expect(event).toEqual({ phaseId: 'early', type: 'transfer', stationName: 교대, band: 2 });
  });

  it('route에 없는 역이 오면(경로 변경 직후 등) 조회 실패 → 기본 필드만', () => {
    const event = buildCompanionAlarmEvent({
      route: makeDirectRoute(5, '2'),
      destinationName: 강남,
      nextStation: 서울역,
      nextLine: '1',
      targetKind: 'transfer',
      originStation: 역삼,
    });
    expect(event).toEqual({ phaseId: 'early', type: 'transfer', stationName: 서울역 });
  });

  it('같은 역이 환승·도착으로 두 번 나오면 targetKind가 같은 타깃을, 그 안에서 nextLine(진입 노선) 일치를 우선한다', () => {
    const route = {
      ...makeMultiTransferRoute({
        transfers: [
          { transferName: 교대, fromLine: '2', toLine: '3', stopsToTransfer: 3 },
          { transferName: 교대, fromLine: '3', toLine: '2', stopsToTransfer: 3 },
        ],
        stopsAfterLastTransfer: 3,
      }),
      destinationStationId: '2-목적',
    };
    const second = {
      ...route,
      transfers: [
        { ...route.transfers[0], transferStationId: '2-교대-첫째' },
        { ...route.transfers[1], transferStationId: '3-교대-둘째' },
      ],
    };
    const event = buildCompanionAlarmEvent({
      route: second,
      destinationName: 강남,
      nextStation: 교대,
      nextLine: '3',
      targetKind: 'transfer',
      originStation: 역삼,
    });
    expect(event.stationId).toBe('3-교대-둘째');
  });
});
