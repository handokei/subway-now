import { buildBoardingPromptContext } from '../boardingPromptContext';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';
import { getStationById } from '../../../../shared/utils/stationRoute';
import type { Station } from '../../../../shared/types/station';

function st(id: string): Station {
  const s = getStationById(id);
  if (!s) throw new Error(`fixture station not found: ${id}`);
  return s;
}

describe('buildBoardingPromptContext', () => {
  it('route가 null이면 null', () => {
    expect(
      buildBoardingPromptContext({
        route: null,
        currentStation: st('3-001'),
        destination: st('3-003'),
      }),
    ).toBeNull();
  });

  it('currentStation이 null이면 null', () => {
    expect(
      buildBoardingPromptContext({
        route: makeDirectRoute(2, '3'),
        currentStation: null,
        destination: st('3-003'),
      }),
    ).toBeNull();
  });

  it('destination이 null이면 null', () => {
    expect(
      buildBoardingPromptContext({
        route: makeDirectRoute(2, '3'),
        currentStation: st('3-001'),
        destination: null,
      }),
    ).toBeNull();
  });

  describe('DirectRoute', () => {
    it('단조 line(3호선) — origin/next 좌표 + direction 채워짐', () => {
      const current = st('3-001'); // 대화
      const dest = st('3-003'); // 정발산
      const next = st('3-002'); // 주엽
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(2, '3'),
        currentStation: current,
        destination: dest,
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptGeoContext.origin).toEqual({ lat: current.lat, lng: current.lng });
      expect(ctx?.promptGeoContext.nextStation).toEqual({ lat: next.lat, lng: next.lng });
      // 대화는 low endpoint → 정발산 방향은 high(down)
      expect(ctx?.promptGeoContext.direction).toBe('down');
      expect(ctx?.promptDisplay.originStation).toBe('대화');
      expect(ctx?.promptDisplay.line).toBe('3');
    });

    it('단조 line 역방향 — direction up', () => {
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(2, '3'),
        currentStation: st('3-003'),
        destination: st('3-001'),
      });
      expect(ctx?.promptGeoContext.direction).toBe('up');
    });

    it('비단조 line(2호선 순환) — direction null', () => {
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(2, '2'),
        currentStation: st('2-001'),
        destination: st('2-003'),
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptGeoContext.direction).toBeNull();
      expect(ctx?.promptDisplay.line).toBe('2');
    });

    it('next station lookup 실패(current===destination) → null', () => {
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(0, '3'),
        currentStation: st('3-001'),
        destination: st('3-001'),
      });
      expect(ctx).toBeNull();
    });
  });

  describe('TransferRoute', () => {
    it('첫 leg = fromLine, next는 첫 leg 다음 역', () => {
      // 3호선 대화(3-001) → 교대(3-032) 환승 → 2호선 강남(2-022)
      const current = st('3-001'); // 대화
      const dest = st('2-022'); // 강남
      const ctx = buildBoardingPromptContext({
        route: makeTransferRoute({
          transferName: '교대',
          fromLine: '3',
          toLine: '2',
          stopsToTransfer: 31,
          stopsFromTransfer: 1,
        }),
        currentStation: current,
        destination: dest,
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptDisplay.line).toBe('3'); // fromLine
      expect(ctx?.promptDisplay.originStation).toBe('대화');
      // 대화 다음은 주엽
      const next = st('3-002');
      expect(ctx?.promptGeoContext.nextStation).toEqual({ lat: next.lat, lng: next.lng });
    });
  });

  describe('MultiTransferRoute', () => {
    it('첫 segment의 fromLine으로 평가', () => {
      const current = st('3-001'); // 대화
      const dest = st('2-022'); // 강남
      const ctx = buildBoardingPromptContext({
        route: makeMultiTransferRoute({
          transfers: [
            { transferName: '교대', fromLine: '3', toLine: '2', stopsToTransfer: 31 },
            { transferName: '강남', fromLine: '2', toLine: 'sinbundang', stopsToTransfer: 1 },
          ],
          stopsAfterLastTransfer: 0,
        }),
        currentStation: current,
        destination: dest,
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptDisplay.line).toBe('3');
      const next = st('3-002');
      expect(ctx?.promptGeoContext.nextStation).toEqual({ lat: next.lat, lng: next.lng });
    });
  });
});
