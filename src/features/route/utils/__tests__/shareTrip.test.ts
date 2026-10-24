import { Share } from 'react-native';
import { buildShareTripText, shareTripIntent } from '../shareTrip';
import type { Station } from '../../../../shared/types/station';
import type { DirectRoute, Route } from '../../../../shared/utils/stationRoute';

function makeStation(overrides: Partial<Station> = {}): Station {
  return {
    id: '2-219',
    name: '강남',
    line: '2',
    lineColor: '#00A84D',
    lat: 37.4979,
    lng: 127.0276,
    ...overrides,
  };
}

const directRoute: DirectRoute = {
  type: 'direct',
  stops: 5,
  line: '2',
  travelSeconds: 600,
};

const t = jest.fn((key: string, opts?: Record<string, unknown>) => {
  if (key === 'share.trip.title') return 'TITLE';
  if (key === 'share.trip.bodyTemplate' && opts) {
    return `FROM ${opts.fromName} (${opts.fromLine}) TO ${opts.toName} (${opts.toLine}) ${opts.minutes}min ${opts.stops}stops`;
  }
  if (key === 'lines.2') return '2호선';
  if (key === 'lines.8') return '8호선';
  return key;
});

beforeEach(() => {
  t.mockClear();
});

describe('buildShareTripText', () => {
  it('빌드: 정상 입력이면 t로 본문 생성', () => {
    const result = buildShareTripText({
      route: directRoute,
      currentStation: makeStation(),
      destination: makeStation({ id: '2-216', name: '잠실', line: '2' }),
      totalStops: 5,
      travelMinutes: 10,
      t,
    });
    expect(result).toBe('FROM 강남 (2호선) TO 잠실 (2호선) 10min 5stops');
  });

  it('환승: 출발/도착 노선이 다르면 각 노선 라벨이 들어간다', () => {
    const result = buildShareTripText({
      route: directRoute,
      currentStation: makeStation({ line: '2' }),
      destination: makeStation({ id: '8-008', name: '천호', line: '8' }),
      totalStops: 12,
      travelMinutes: 25,
      t,
    });
    expect(result).toContain('(2호선)');
    expect(result).toContain('(8호선)');
  });

  it('null route: null 반환', () => {
    const result = buildShareTripText({
      route: null as Route,
      currentStation: makeStation(),
      destination: makeStation({ id: '2-216', name: '잠실' }),
      totalStops: 5,
      travelMinutes: 10,
      t,
    });
    expect(result).toBeNull();
  });

  it('currentStation 없음: null 반환', () => {
    const result = buildShareTripText({
      route: directRoute,
      currentStation: null,
      destination: makeStation(),
      totalStops: 5,
      travelMinutes: 10,
      t,
    });
    expect(result).toBeNull();
  });

  it('destination 없음: null 반환', () => {
    const result = buildShareTripText({
      route: directRoute,
      currentStation: makeStation(),
      destination: null,
      totalStops: 5,
      travelMinutes: 10,
      t,
    });
    expect(result).toBeNull();
  });
});

describe('shareTripIntent', () => {
  it('정상: Share.share를 message+title과 함께 호출하고 true', async () => {
    const spy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const ok = await shareTripIntent({
      route: directRoute,
      currentStation: makeStation(),
      destination: makeStation({ id: '2-216', name: '잠실' }),
      totalStops: 5,
      travelMinutes: 10,
      t,
    });
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledWith({
      title: 'TITLE',
      message: 'FROM 강남 (2호선) TO 잠실 (2호선) 10min 5stops',
    });
    spy.mockRestore();
  });

  it('누락 입력: Share.share를 호출하지 않고 false', async () => {
    const spy = jest.spyOn(Share, 'share');
    const ok = await shareTripIntent({
      route: null as Route,
      currentStation: makeStation(),
      destination: makeStation(),
      totalStops: 0,
      travelMinutes: 0,
      t,
    });
    expect(ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('Share.share가 throw하면 false 반환', async () => {
    const spy = jest.spyOn(Share, 'share').mockRejectedValue(new Error('user cancelled'));
    const ok = await shareTripIntent({
      route: directRoute,
      currentStation: makeStation(),
      destination: makeStation({ id: '2-216', name: '잠실' }),
      totalStops: 5,
      travelMinutes: 10,
      t,
    });
    expect(ok).toBe(false);
    spy.mockRestore();
  });
});
