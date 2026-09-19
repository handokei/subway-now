import { projectArrivalEtaStation } from '../arrivalEtaProjection';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
import type { ArrivalInfo } from '../../api/arrivalApi';
import type { Station } from '../../../../shared/types/station';

const ARC: Station[] = [
  { id: '7-001', name: '용마산', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: '7-002', name: '중곡', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: '7-003', name: '군자', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: '7-004', name: '어린이대공원', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: '7-005', name: '건대입구', line: '7', lineColor: '#x', lat: 0, lng: 0 },
];

const T0 = 1_700_000_000_000;
const TTL_MS = 60_000;
const TRAIN_CODE = '7093';
const OTHER_TRAIN_CODE = '9999';

function makeArrival(overrides: Partial<ArrivalInfo> = {}): ArrivalInfo {
  return {
    destination: '장암행',
    arrivalMinutes: 0,
    arrivalSeconds: 30,
    statusMessage: '',
    trainCode: TRAIN_CODE,
    line: '7',
    receivedAtMs: T0,
    arrivalCode: ARRIVAL_CODE.ENTERING,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

describe('projectArrivalEtaStation', () => {
  it('empty arrivals → null', () => {
    expect(
      projectArrivalEtaStation({
        arrivals: [],
        trainCode: TRAIN_CODE,
        currentIdx: 0,
        arcStations: ARC,
        nowMs: T0,
        ttlMs: TTL_MS,
      }),
    ).toBeNull();
  });

  it('trainCode 미일치 → null', () => {
    expect(
      projectArrivalEtaStation({
        arrivals: [makeArrival({ trainCode: OTHER_TRAIN_CODE })],
        trainCode: TRAIN_CODE,
        currentIdx: 0,
        arcStations: ARC,
        nowMs: T0,
        ttlMs: TTL_MS,
      }),
    ).toBeNull();
  });

  it('모든 row stale (receivedAtMs=0) → null', () => {
    expect(
      projectArrivalEtaStation({
        arrivals: [makeArrival({ receivedAtMs: 0 })],
        trainCode: TRAIN_CODE,
        currentIdx: 0,
        arcStations: ARC,
        nowMs: T0,
        ttlMs: TTL_MS,
      }),
    ).toBeNull();
  });

  it('모든 row TTL 초과 → null', () => {
    expect(
      projectArrivalEtaStation({
        arrivals: [makeArrival({ receivedAtMs: T0 })],
        trainCode: TRAIN_CODE,
        currentIdx: 0,
        arcStations: ARC,
        nowMs: T0 + TTL_MS + 1,
        ttlMs: TTL_MS,
      }),
    ).toBeNull();
  });

  it('PREV_ARRIVED(5: 전역도착) → 열차가 currentIdx에 머묾', () => {
    const r = projectArrivalEtaStation({
      arrivals: [makeArrival({ arrivalCode: ARRIVAL_CODE.PREV_ARRIVED, arrivalSeconds: 46 })],
      trainCode: TRAIN_CODE,
      currentIdx: 2,
      arcStations: ARC,
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    expect(r).toEqual({
      index: 2,
      station: ARC[2],
      etaSeconds: 46,
      source: 'arrival-eta',
    });
  });

  it('ENTERING(0: 진입) → 열차가 다음 역(currentIdx+1)으로 이동', () => {
    const r = projectArrivalEtaStation({
      arrivals: [makeArrival({ arrivalCode: ARRIVAL_CODE.ENTERING, arrivalSeconds: 16 })],
      trainCode: TRAIN_CODE,
      currentIdx: 2,
      arcStations: ARC,
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    expect(r).toEqual({
      index: 3,
      station: ARC[3],
      etaSeconds: 16,
      source: 'arrival-eta',
    });
  });

  it('ARRIVED(1: 도착) → 열차가 다음 역(currentIdx+1)으로 이동', () => {
    const r = projectArrivalEtaStation({
      arrivals: [makeArrival({ arrivalCode: ARRIVAL_CODE.ARRIVED, arrivalSeconds: 0 })],
      trainCode: TRAIN_CODE,
      currentIdx: 2,
      arcStations: ARC,
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    expect(r).toEqual({
      index: 3,
      station: ARC[3],
      etaSeconds: 0,
      source: 'arrival-eta',
    });
  });

  it('알 수 없는 arrivalCode(2: 출발 등) → null (안전 fallback)', () => {
    expect(
      projectArrivalEtaStation({
        arrivals: [makeArrival({ arrivalCode: ARRIVAL_CODE.DEPARTED })],
        trainCode: TRAIN_CODE,
        currentIdx: 0,
        arcStations: ARC,
        nowMs: T0,
        ttlMs: TTL_MS,
      }),
    ).toBeNull();
  });

  it('RUNNING(99) → null (현재 위치 신호 부적합)', () => {
    expect(
      projectArrivalEtaStation({
        arrivals: [makeArrival({ arrivalCode: ARRIVAL_CODE.RUNNING })],
        trainCode: TRAIN_CODE,
        currentIdx: 0,
        arcStations: ARC,
        nowMs: T0,
        ttlMs: TTL_MS,
      }),
    ).toBeNull();
  });

  it('arrivalCode=-1 (누락) → null', () => {
    expect(
      projectArrivalEtaStation({
        arrivals: [makeArrival({ arrivalCode: -1 })],
        trainCode: TRAIN_CODE,
        currentIdx: 0,
        arcStations: ARC,
        nowMs: T0,
        ttlMs: TTL_MS,
      }),
    ).toBeNull();
  });

  it('일부 fresh + 일부 stale — fresh row 사용', () => {
    const r = projectArrivalEtaStation({
      arrivals: [
        makeArrival({ receivedAtMs: 0, arrivalCode: ARRIVAL_CODE.ARRIVED, arrivalSeconds: 999 }),
        makeArrival({ receivedAtMs: T0, arrivalCode: ARRIVAL_CODE.ENTERING, arrivalSeconds: 12 }),
      ],
      trainCode: TRAIN_CODE,
      currentIdx: 1,
      arcStations: ARC,
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    expect(r).toEqual({
      index: 2,
      station: ARC[2],
      etaSeconds: 12,
      source: 'arrival-eta',
    });
  });

  it('fresh row 중 trainCode 매칭만 사용 (다른 trainCode는 무시)', () => {
    const r = projectArrivalEtaStation({
      arrivals: [
        makeArrival({ trainCode: OTHER_TRAIN_CODE, arrivalCode: ARRIVAL_CODE.ARRIVED, arrivalSeconds: 1 }),
        makeArrival({ trainCode: TRAIN_CODE, arrivalCode: ARRIVAL_CODE.PREV_ARRIVED, arrivalSeconds: 50 }),
      ],
      trainCode: TRAIN_CODE,
      currentIdx: 1,
      arcStations: ARC,
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    expect(r).toEqual({
      index: 1,
      station: ARC[1],
      etaSeconds: 50,
      source: 'arrival-eta',
    });
  });

  it('종착 경계 — ENTERING이면서 currentIdx+1 >= arcStations.length → 마지막 인덱스 cap', () => {
    const r = projectArrivalEtaStation({
      arrivals: [makeArrival({ arrivalCode: ARRIVAL_CODE.ENTERING, arrivalSeconds: 10 })],
      trainCode: TRAIN_CODE,
      currentIdx: ARC.length - 1, // 마지막 역
      arcStations: ARC,
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    expect(r).toEqual({
      index: ARC.length - 1,
      station: ARC[ARC.length - 1],
      etaSeconds: 10,
      source: 'arrival-eta',
    });
  });

  it('종착 경계 — ARRIVED이면서 currentIdx+1 >= arcStations.length → 마지막 인덱스 cap', () => {
    const r = projectArrivalEtaStation({
      arrivals: [makeArrival({ arrivalCode: ARRIVAL_CODE.ARRIVED, arrivalSeconds: 0 })],
      trainCode: TRAIN_CODE,
      currentIdx: ARC.length - 1,
      arcStations: ARC,
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    expect(r).toEqual({
      index: ARC.length - 1,
      station: ARC[ARC.length - 1],
      etaSeconds: 0,
      source: 'arrival-eta',
    });
  });

  it('arcStations 비었으면 → null', () => {
    expect(
      projectArrivalEtaStation({
        arrivals: [makeArrival({ arrivalCode: ARRIVAL_CODE.PREV_ARRIVED })],
        trainCode: TRAIN_CODE,
        currentIdx: 0,
        arcStations: [],
        nowMs: T0,
        ttlMs: TTL_MS,
      }),
    ).toBeNull();
  });

  it('currentIdx가 arc 범위 밖이면 → null (안전 가드)', () => {
    expect(
      projectArrivalEtaStation({
        arrivals: [makeArrival({ arrivalCode: ARRIVAL_CODE.PREV_ARRIVED })],
        trainCode: TRAIN_CODE,
        currentIdx: -1,
        arcStations: ARC,
        nowMs: T0,
        ttlMs: TTL_MS,
      }),
    ).toBeNull();

    expect(
      projectArrivalEtaStation({
        arrivals: [makeArrival({ arrivalCode: ARRIVAL_CODE.PREV_ARRIVED })],
        trainCode: TRAIN_CODE,
        currentIdx: ARC.length,
        arcStations: ARC,
        nowMs: T0,
        ttlMs: TTL_MS,
      }),
    ).toBeNull();
  });

  it('TTL 경계 — nowMs - receivedAtMs == ttlMs 정확히는 fresh로 통과', () => {
    const r = projectArrivalEtaStation({
      arrivals: [makeArrival({ receivedAtMs: T0, arrivalCode: ARRIVAL_CODE.PREV_ARRIVED, arrivalSeconds: 30 })],
      trainCode: TRAIN_CODE,
      currentIdx: 1,
      arcStations: ARC,
      nowMs: T0 + TTL_MS,
      ttlMs: TTL_MS,
    });
    expect(r).toEqual({
      index: 1,
      station: ARC[1],
      etaSeconds: 30,
      source: 'arrival-eta',
    });
  });

  it('우선순위 — fresh trainCode 매칭 행이 여러 개면 첫 적격 행을 사용', () => {
    // arrivals API가 동일 trainCode 행을 여러 개 줄 일은 드물지만, 정책을 테스트로 고정.
    const r = projectArrivalEtaStation({
      arrivals: [
        makeArrival({ receivedAtMs: T0, arrivalCode: ARRIVAL_CODE.PREV_ARRIVED, arrivalSeconds: 11 }),
        makeArrival({ receivedAtMs: T0, arrivalCode: ARRIVAL_CODE.ENTERING, arrivalSeconds: 22 }),
      ],
      trainCode: TRAIN_CODE,
      currentIdx: 1,
      arcStations: ARC,
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    // 첫 행(PREV_ARRIVED) 사용 → 현재 idx 유지
    expect(r).toEqual({
      index: 1,
      station: ARC[1],
      etaSeconds: 11,
      source: 'arrival-eta',
    });
  });
});
