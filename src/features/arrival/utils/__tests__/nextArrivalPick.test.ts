import { pickNextArrival } from '../nextArrivalPick';
import type { ArrivalInfo, StationArrival } from '../../api/arrivalApi';
import { makeArrivalInfo } from '../../../../testUtils/fixtures';

function info(overrides: Partial<ArrivalInfo> = {}): ArrivalInfo {
  return makeArrivalInfo({ destination: 'D', arrivalSeconds: 100, trainCode: 'T-1', ...overrides });
}

const EMPTY = {
  etaSeconds: null,
  direction: null,
  trainCode: null,
  matchedByTrainCode: false,
};

describe('pickNextArrival', () => {
  it('arrival이 null이면 모두 null', () => {
    expect(pickNextArrival(null)).toEqual(EMPTY);
  });

  it('isMock=true면 모두 null', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 100 })],
      down: [],
      isMock: true,
    };
    expect(pickNextArrival(arrival)).toEqual(EMPTY);
  });

  it('up/down 양방향에서 가장 빠른 양수 arrivalSeconds를 선택한다', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 300, trainCode: 'U1' })],
      down: [info({ arrivalSeconds: 120, trainCode: 'D1' })],
    };
    expect(pickNextArrival(arrival)).toEqual({
      etaSeconds: 120,
      direction: 'down',
      trainCode: 'D1',
      matchedByTrainCode: false,
    });
  });

  it('동일 방향 내에서도 최소값을 선택한다', () => {
    const arrival: StationArrival = {
      up: [
        info({ arrivalSeconds: 500, trainCode: 'U-late' }),
        info({ arrivalSeconds: 80, trainCode: 'U-soon' }),
      ],
      down: [],
    };
    expect(pickNextArrival(arrival)).toEqual({
      etaSeconds: 80,
      direction: 'up',
      trainCode: 'U-soon',
      matchedByTrainCode: false,
    });
  });

  it('0 이하 arrivalSeconds는 후보에서 제외한다', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 0 }), info({ arrivalSeconds: -5 })],
      down: [info({ arrivalSeconds: 250, trainCode: 'D-only' })],
    };
    expect(pickNextArrival(arrival)).toEqual({
      etaSeconds: 250,
      direction: 'down',
      trainCode: 'D-only',
      matchedByTrainCode: false,
    });
  });

  it('양수 후보가 전혀 없으면 모두 null', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 0 })],
      down: [info({ arrivalSeconds: -1 })],
    };
    expect(pickNextArrival(arrival)).toEqual(EMPTY);
  });

  it('trainCode가 빈 문자열이면 null로 변환한다', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 100, trainCode: '' })],
      down: [],
    };
    expect(pickNextArrival(arrival)).toEqual({
      etaSeconds: 100,
      direction: 'up',
      trainCode: null,
      matchedByTrainCode: false,
    });
  });

  it('filterDirection="up"이면 up list만 검색한다 (반대방향 더 빨라도 무시)', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 240, trainCode: 'U-real' })],
      down: [info({ arrivalSeconds: 30, trainCode: 'D-fast' })],
    };
    expect(pickNextArrival(arrival, 'up')).toEqual({
      etaSeconds: 240,
      direction: 'up',
      trainCode: 'U-real',
      matchedByTrainCode: false,
    });
  });

  it('filterDirection="down"이면 down list만 검색한다', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 30, trainCode: 'U-fast' })],
      down: [info({ arrivalSeconds: 180, trainCode: 'D-real' })],
    };
    expect(pickNextArrival(arrival, 'down')).toEqual({
      etaSeconds: 180,
      direction: 'down',
      trainCode: 'D-real',
      matchedByTrainCode: false,
    });
  });

  it('filterDirection이 지정됐는데 그 방향에 양수 후보가 없으면 모두 null', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 0 })],
      down: [info({ arrivalSeconds: 300, trainCode: 'D' })],
    };
    expect(pickNextArrival(arrival, 'up')).toEqual(EMPTY);
  });

  it('isMock 필드가 없는 입력 형태({up,down}만)도 동작한다', () => {
    const result = pickNextArrival({
      up: [info({ arrivalSeconds: 60, trainCode: 'fetch-T' })],
      down: [],
    });
    expect(result).toEqual({
      etaSeconds: 60,
      direction: 'up',
      trainCode: 'fetch-T',
      matchedByTrainCode: false,
    });
  });

  describe('preferTrainCode (#373 lock-in)', () => {
    const arrival: StationArrival = {
      up: [
        info({ arrivalSeconds: 180, trainCode: 'T-UP-1' }),
        info({ arrivalSeconds: 50, trainCode: 'T-UP-2' }),
      ],
      down: [info({ arrivalSeconds: 30, trainCode: 'T-DN-1' })],
    };

    it('preferTrainCode가 매치되면 해당 ETA를 결정론적으로 채택하고 matchedByTrainCode=true', () => {
      // 같은 방향에 더 빠른 T-UP-2(50초) 있어도 lock-in 코드 T-UP-1(180초)을 채택.
      expect(pickNextArrival(arrival, 'up', { preferTrainCode: 'T-UP-1' })).toEqual({
        etaSeconds: 180,
        direction: 'up',
        trainCode: 'T-UP-1',
        matchedByTrainCode: true,
      });
    });

    it('preferTrainCode 매치 실패 시 방향별 min ETA로 fallback (matchedByTrainCode=false)', () => {
      expect(pickNextArrival(arrival, 'up', { preferTrainCode: 'T-MISSING' })).toEqual({
        etaSeconds: 50,
        direction: 'up',
        trainCode: 'T-UP-2',
        matchedByTrainCode: false,
      });
    });

    it('preferTrainCode가 null이면 기본 min ETA 동작', () => {
      expect(pickNextArrival(arrival, 'up', { preferTrainCode: null })).toEqual({
        etaSeconds: 50,
        direction: 'up',
        trainCode: 'T-UP-2',
        matchedByTrainCode: false,
      });
    });

    it('preferTrainCode가 빈 문자열이면 기본 min ETA 동작 (truthy 체크)', () => {
      expect(pickNextArrival(arrival, 'up', { preferTrainCode: '' })).toEqual({
        etaSeconds: 50,
        direction: 'up',
        trainCode: 'T-UP-2',
        matchedByTrainCode: false,
      });
    });

    it('preferTrainCode 매치값이 stale 상한(1200초)을 초과하면 fallback', () => {
      const stale: StationArrival = {
        up: [
          info({ arrivalSeconds: 1500, trainCode: 'T-UP-1' }), // 상한 초과 → 강등
          info({ arrivalSeconds: 80, trainCode: 'T-UP-2' }),
        ],
        down: [],
      };
      expect(pickNextArrival(stale, 'up', { preferTrainCode: 'T-UP-1' })).toEqual({
        etaSeconds: 80,
        direction: 'up',
        trainCode: 'T-UP-2',
        matchedByTrainCode: false,
      });
    });

    it('preferTrainCode 매치값이 정확히 상한(1200초)이면 채택', () => {
      const boundary: StationArrival = {
        up: [info({ arrivalSeconds: 1200, trainCode: 'T-UP-1' })],
        down: [],
      };
      expect(pickNextArrival(boundary, 'up', { preferTrainCode: 'T-UP-1' })).toEqual({
        etaSeconds: 1200,
        direction: 'up',
        trainCode: 'T-UP-1',
        matchedByTrainCode: true,
      });
    });

    it('preferTrainCode 매치값이 0 이하면 fallback', () => {
      const expired: StationArrival = {
        up: [
          info({ arrivalSeconds: 0, trainCode: 'T-UP-1' }), // 진입/통과 — 후보 제외
          info({ arrivalSeconds: 90, trainCode: 'T-UP-2' }),
        ],
        down: [],
      };
      expect(pickNextArrival(expired, 'up', { preferTrainCode: 'T-UP-1' })).toEqual({
        etaSeconds: 90,
        direction: 'up',
        trainCode: 'T-UP-2',
        matchedByTrainCode: false,
      });
    });

    it('filterDirection이 null이면 양방향에서 preferTrainCode 매치 시도', () => {
      // direction null → up/down 둘 다 검색. T-DN-1이 down에 있어도 매치.
      expect(pickNextArrival(arrival, null, { preferTrainCode: 'T-DN-1' })).toEqual({
        etaSeconds: 30,
        direction: 'down',
        trainCode: 'T-DN-1',
        matchedByTrainCode: true,
      });
    });

    it('preferTrainCode + isMock=true면 모두 null (mock 우선 차단)', () => {
      const mock: StationArrival = { ...arrival, isMock: true };
      expect(pickNextArrival(mock, 'up', { preferTrainCode: 'T-UP-1' })).toEqual(EMPTY);
    });
  });
});
