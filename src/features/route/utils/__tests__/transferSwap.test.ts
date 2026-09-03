/* eslint-disable import/no-restricted-paths --
 * 대상 util(transferSwap)이 nearest-station이 소유한 AutoLockCandidate를 산출하는 cross-feature
 * pure 함수로 file-level 옵트인되어 있으므로 그 테스트도 동일 정책으로 type을 직접 import한다.
 */
/**
 * #1281 — evaluateTransferSwap (FG hook 결정 로직).
 *
 * #2154 — BG task(backgroundTransferSwap)는 무탭 환승 auto-lock 사슬 삭제로 제거됨. 본 함수는
 * 현재 hook(useTransferAutoDetect) 단독 소비 — route 미설정 환승 자동 detect(#924) 전용.
 * 검증 대상:
 *   - onPlannedTransfer short-circuit
 *   - detect 실패(비환승/정지/임박 없음) → 빈 결과
 *   - 단일 후보 → candidate 산출, 다중 후보 → candidate null
 *   - collectOtherLineArrivals: null arrival / boardingLine 제외
 *   - buildAutoLockCandidate: destination express 우선순위 / null destination / trainCode 부재
 */
import {
  evaluateTransferSwap,
  collectOtherLineArrivals,
  buildAutoLockCandidate,
} from '../transferSwap';
import { makeArrivalInfo } from '../../../../testUtils/fixtures';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';
import type { NearestStationsResult, Station } from '../../../../shared/types/station';

const DDP_2: Station = { id: '0205', name: '동대문역사문화공원', line: '2', lineColor: '#009D3E', lat: 37.565, lng: 127.008 };
const DDP_4: Station = { id: '0405', name: '동대문역사문화공원', line: '4', lineColor: '#00A0E2', lat: 37.565, lng: 127.008 };
const DDP_5: Station = { id: '0505', name: '동대문역사문화공원', line: '5', lineColor: '#996CAC', lat: 37.565, lng: 127.008 };
const GANGNAM_2: Station = { id: '0222', name: '강남', line: '2', lineColor: '#009D3E', lat: 37.498, lng: 127.027 };

const transferNearest: NearestStationsResult = {
  primary: DDP_2,
  variants: [DDP_2, DDP_4, DDP_5],
  distanceKm: 0.03,
  isTransfer: true,
};

const nonTransferNearest: NearestStationsResult = {
  primary: GANGNAM_2,
  variants: [GANGNAM_2],
  distanceKm: 0.03,
  isTransfer: false,
};

function makeArrival(up: ArrivalInfo[] = [], down: ArrivalInfo[] = []): StationArrival {
  return { up, down };
}

function baseInput(overrides: Partial<Parameters<typeof evaluateTransferSwap>[0]> = {}) {
  return {
    nearestStations: transferNearest,
    motionStationary: false as boolean | undefined,
    arrival: makeArrival(),
    boardingLine: '2' as const,
    destinationName: null as string | null,
    onPlannedTransfer: false,
    onRouteStation: false,
    ...overrides,
  };
}

describe('evaluateTransferSwap', () => {
  it('onPlannedTransfer이면 즉시 빈 결과(detect 안 함)', () => {
    const result = evaluateTransferSwap(baseInput({ onPlannedTransfer: true }));
    expect(result).toEqual({ candidateLines: [], candidate: null });
  });

  // #U1 — 통과역(pass-through) 오출현 회귀 가드. 군자(5/7호선)처럼 물리적 환승역이라도
  // 활성 route가 이미 그 line을 알고 있으면(=onRouteStation) 재확인 모달을 띄우지 않는다.
  it('onRouteStation이면 즉시 빈 결과(활성 route 경로상 통과역, 재확인 불필요)', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4' }),
    ]);
    const result = evaluateTransferSwap(baseInput({ arrival, onRouteStation: true }));
    expect(result).toEqual({ candidateLines: [], candidate: null });
  });

  // 과억제 방지 가드: route가 모르는 line으로의 진짜(off-route) 환승은 onRouteStation=false로
  // 계속 detect되어야 한다 — 위 테스트와 짝을 이뤄 guard가 정확히 route-known line만 억제함을 검증.
  it('onRouteStation=false(route가 모르는 line) → 진짜 환승은 계속 detect됨(과억제 아님)', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4' }),
    ]);
    const result = evaluateTransferSwap(baseInput({ arrival, onRouteStation: false }));
    expect(result.candidateLines).toEqual(['4']);
    expect(result.candidate).toEqual({ trainCode: 'T-4', line: '4', subwayId: expect.any(String) });
  });

  it('비환승 역이면 빈 결과', () => {
    const result = evaluateTransferSwap(baseInput({ nearestStations: nonTransferNearest }));
    expect(result.candidateLines).toEqual([]);
    expect(result.candidate).toBeNull();
  });

  it('정지(motionStationary=true)이면 빈 결과', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4' }),
    ]);
    const result = evaluateTransferSwap(baseInput({ motionStationary: true, arrival }));
    expect(result.candidateLines).toEqual([]);
  });

  it('단일 다른 노선 임박 → candidate 산출(boardingLine 제외 후 다른 노선)', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4' }),
    ]);
    const result = evaluateTransferSwap(baseInput({ arrival }));
    expect(result.candidateLines).toEqual(['4']);
    expect(result.candidate).toEqual({ trainCode: 'T-4', line: '4', subwayId: expect.any(String) });
  });

  it('다중 다른 노선 임박 → candidateLines만, candidate는 null(사용자 선택 위임)', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4' }),
      makeArrivalInfo({ destination: '왕십리', arrivalSeconds: 90, line: '5', trainCode: 'T-5' }),
    ]);
    const result = evaluateTransferSwap(baseInput({ arrival }));
    expect(result.candidateLines).toHaveLength(2);
    expect(result.candidate).toBeNull();
  });

  it('현재 boardingLine만 임박이면 다른 노선 후보 없음 → 빈 결과', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2' }),
    ]);
    const result = evaluateTransferSwap(baseInput({ arrival }));
    expect(result.candidateLines).toEqual([]);
  });
});

describe('collectOtherLineArrivals', () => {
  it('arrival null이면 빈 배열', () => {
    expect(collectOtherLineArrivals(null, '2')).toEqual([]);
  });

  it('boardingLine과 같은 노선은 제외, 다른 노선만 수집', () => {
    const arrival = makeArrival(
      [makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2' })],
      [makeArrivalInfo({ destination: '서울역', arrivalSeconds: 90, line: '4', trainCode: 'T-4' })],
    );
    const out = collectOtherLineArrivals(arrival, '2');
    expect(out).toEqual([{ line: '4', arrivalSeconds: 90, arrivalCode: -1 }]);
  });

  it('boardingLine null이면 전체 수집', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2' }),
    ]);
    const out = collectOtherLineArrivals(arrival, null);
    expect(out).toHaveLength(1);
  });
});

describe('buildAutoLockCandidate', () => {
  it('arrival null이면 trainCode 없음 → null', () => {
    expect(buildAutoLockCandidate('4', null, null)).toBeNull();
  });

  it('해당 노선 도착 없으면 null', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2' }),
    ]);
    expect(buildAutoLockCandidate('4', arrival, null)).toBeNull();
  });

  it('destinationName 없으면 가장 임박한 trainCode', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 120, line: '4', trainCode: 'T-late' }),
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-soon' }),
    ]);
    expect(buildAutoLockCandidate('4', arrival, null)?.trainCode).toBe('T-soon');
  });

  it('나중 도착은 fallback(가장 임박)을 교체하지 않음', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-soon' }),
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 120, line: '4', trainCode: 'T-late' }),
    ]);
    expect(buildAutoLockCandidate('4', arrival, null)?.trainCode).toBe('T-soon');
  });

  it('destinationName 미정차 express는 후보에서 제외하고 정차 후보 우선', () => {
    // 9호선 급행 데이터 보유. '강남'은 express 정차역이 아니므로 express는 제외, normal 선택.
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '개화', arrivalSeconds: 60, line: '9', trainCode: 'T-exp', trainType: 'express' }),
      makeArrivalInfo({ destination: '개화', arrivalSeconds: 90, line: '9', trainCode: 'T-norm', trainType: 'normal' }),
    ]);
    expect(buildAutoLockCandidate('9', arrival, '강남')?.trainCode).toBe('T-norm');
  });

  it('정차 후보가 여럿이면 가장 임박한 정차 후보를 preferred로 선택', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '개화', arrivalSeconds: 120, line: '9', trainCode: 'T-norm-late', trainType: 'normal' }),
      makeArrivalInfo({ destination: '개화', arrivalSeconds: 60, line: '9', trainCode: 'T-norm-soon', trainType: 'normal' }),
    ]);
    expect(buildAutoLockCandidate('9', arrival, '강남')?.trainCode).toBe('T-norm-soon');
  });

  it('나중 정차 후보는 preferred를 교체하지 않음', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '개화', arrivalSeconds: 60, line: '9', trainCode: 'T-norm-soon', trainType: 'normal' }),
      makeArrivalInfo({ destination: '개화', arrivalSeconds: 120, line: '9', trainCode: 'T-norm-late', trainType: 'normal' }),
    ]);
    expect(buildAutoLockCandidate('9', arrival, '강남')?.trainCode).toBe('T-norm-soon');
  });
});
