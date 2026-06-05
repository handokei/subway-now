import { arcIndexOfStation, estimateStationProgress } from '../stationProgressEstimator';
import { HOP_TIME_MS } from '../../../../shared/constants/boardingLock';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
import type { ArrivalInfo } from '../../../../shared/types/arrival';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { Station } from '../../../../shared/types/station';
import type { TrainProgressResult } from '../trackTrainProgress';

// 기존 테스트들이 HOP_TIME_MS uniform 가정을 그대로 사용 — Stage 3에서도 estimator의 시간 적분
// 로직 회귀를 검증하려면 동일한 시간 단위가 필요. lookup closure로 감싸 시그니처만 신규 형태로 맞춘다.
// Strategy ③④의 segment별 누적 회귀는 별도 describe(Stage 3) 블록에서 가변 hop time으로 검증.
const UNIFORM_HOP = (_fromIdx: number) => HOP_TIME_MS;

const ARC: Station[] = [
  { id: '7-001', name: '용마산', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: '7-002', name: '중곡', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: '7-003', name: '군자', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: '7-004', name: '어린이대공원', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: '7-005', name: '건대입구', line: '7', lineColor: '#x', lat: 0, lng: 0 },
];

const T0 = 1_700_000_000_000;

function makeLock(overrides: Partial<BoardingLock> = {}): BoardingLock {
  return {
    destinationId: '2-011',
    trainCode: '7093',
    boardingStationId: '7-001',
    boardingLine: '7',
    boardedAt: T0,
    expectedDurationMs: 10 * 60 * 1000,
    ...overrides,
  };
}

function makeTrainProgress(
  overrides: Partial<TrainProgressResult> & { stationIdx?: number } = {},
): TrainProgressResult {
  const { stationIdx, ...rest } = overrides;
  const station = stationIdx != null ? ARC[stationIdx] : ARC[1];
  return {
    trainNo: '7093',
    currentStation: station,
    trainStatus: 1,
    confidence: 'single',
    ...rest,
  };
}

const ARRIVAL_TTL_MS = 60_000;

function makeArrival(overrides: Partial<ArrivalInfo> = {}): ArrivalInfo {
  return {
    destination: 'X',
    arrivalMinutes: 0,
    arrivalSeconds: 30,
    statusMessage: '',
    trainCode: '7093',
    line: '7',
    receivedAtMs: T0,
    arrivalCode: ARRIVAL_CODE.ENTERING,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

/** Strategy ②(ArrivalEta) 입력이 모두 비어있는 기본값 — 기존 테스트 호환. */
const NO_ARRIVAL_INPUT = {
  nextStationArrivals: [] as readonly ArrivalInfo[],
  arrivalEtaTtlMs: ARRIVAL_TTL_MS,
  currentIdxHint: null as number | null,
};

describe('estimateStationProgress', () => {
  describe('가드 — 모든 전략 비활성', () => {
    it('lock null이면 null', () => {
      expect(
        estimateStationProgress({
          lock: null,
          arcStations: ARC,
          now: T0,
          trainProgress: null,
          lockedTrainCode: null,
          lastObserved: null,
          hopTimeMsForHop: UNIFORM_HOP,
          ...NO_ARRIVAL_INPUT,
        }),
      ).toBeNull();
    });

    it('arcStations 비면 null', () => {
      expect(
        estimateStationProgress({
          lock: makeLock(),
          arcStations: [],
          now: T0,
          trainProgress: null,
          lockedTrainCode: '7093',
          lastObserved: null,
          hopTimeMsForHop: UNIFORM_HOP,
          ...NO_ARRIVAL_INPUT,
        }),
      ).toBeNull();
    });

    it('lock 만료 시 null', () => {
      const lock = makeLock({ expectedDurationMs: 60_000 });
      const expired = T0 + 60_000 * 1.5 + 1;
      expect(
        estimateStationProgress({
          lock,
          arcStations: ARC,
          now: expired,
          trainProgress: null,
          lockedTrainCode: '7093',
          lastObserved: null,
          hopTimeMsForHop: UNIFORM_HOP,
          ...NO_ARRIVAL_INPUT,
        }),
      ).toBeNull();
    });
  });

  describe('Strategy ① LivePosition — trainCode 매칭 + arc 위', () => {
    it('trainProgress.trainNo === lockedTrainCode이고 arc 위면 그 역 즉시 반환 (drift=0)', () => {
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0 + 5 * HOP_TIME_MS, // 시간은 한참 흘렀어도
        trainProgress: makeTrainProgress({ stationIdx: 2 }),
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toEqual({
        station: ARC[2],
        index: 2,
        strategy: 'live-position',
      });
    });

    it('lockedTrainCode null이면 LivePosition skip', () => {
      // lockedTrainCode 없으면 매칭 불가 → ③ skip(lastObs null) → ④ DefaultHop이 boardedAt 앵커로 fallback.
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: makeTrainProgress({ stationIdx: 2 }),
        lockedTrainCode: null,
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r?.strategy).toBe('default-hop');
      expect(r?.station).toBe(ARC[0]); // boarding 앵커, elapsed=0
    });

    it('trainNo 불일치면 LivePosition skip', () => {
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: makeTrainProgress({ trainNo: '9999', stationIdx: 2 }),
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r?.strategy).toBe('default-hop');
      expect(r?.station).toBe(ARC[0]);
    });

    it('trainProgress.currentStation이 arc 위에 없으면 LivePosition skip', () => {
      const offArc: Station = {
        id: '9-999',
        name: '딴노선역',
        line: '9',
        lineColor: '#x',
        lat: 0,
        lng: 0,
      };
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: makeTrainProgress({ currentStation: offArc }),
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r?.strategy).toBe('default-hop');
    });

    it('trainProgress null이면 LivePosition skip', () => {
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r?.strategy).toBe('default-hop');
    });
  });

  describe('Strategy ③ ReanchoredHop — lastObserved 앵커', () => {
    it('lastObserved 있으면 그 시각/인덱스에 재앵커 + (now - ts)/hopTime hop 추가', () => {
      // 마지막 관측 = idx 2 (군자), T0+200s. now = T0+200s + 2*hopTime → 2+2 = 4
      const observedAt = T0 + 200_000;
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: observedAt + 2 * HOP_TIME_MS,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: { arcIndex: 2, observedAtMs: observedAt },
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toEqual({
        station: ARC[4],
        index: 4,
        strategy: 'reanchored-hop',
      });
    });

    it('lastObserved 시각이 미래(시계 후진)면 ReanchoredHop skip → ④ DefaultHop fallback', () => {
      // ③ skip(시계 후진) → ④에서 boardedAt 기준 elapsed=0이므로 idx=0(boarding).
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: { arcIndex: 2, observedAtMs: T0 + 1_000 },
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r?.strategy).toBe('default-hop');
      expect(r?.station).toBe(ARC[0]);
    });

    it('lastObserved.arcIndex가 범위 밖이면 ④ DefaultHop으로 fallback', () => {
      // ③은 안전을 위해 범위 밖 lastObserved는 skip → ④가 boardedAt 앵커로 fallback.
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0 + HOP_TIME_MS,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: { arcIndex: 99, observedAtMs: T0 },
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r?.strategy).toBe('default-hop');
      expect(r?.station).toBe(ARC[1]); // boardingIdx(0) + 1 hop
    });

    it('종착역 초과 cap + grace 초과 시 ③ null', () => {
      // ③에서 종착역 cap+grace 초과 검출 → null. ④도 동일 boardedAt 기준이면 동일 결과지만, 본 케이스는
      // lastObserved가 이미 cap 직전이라 ④의 boardedAt 적분과 분리해 검증한다.
      const lock = makeLock({ expectedDurationMs: 100 * HOP_TIME_MS });
      const observedAt = T0;
      const r = estimateStationProgress({
        lock,
        arcStations: ARC,
        now: observedAt + 100 * HOP_TIME_MS, // arc 길이 5, idx 0 + 100 hop → 종착 초과
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: { arcIndex: 0, observedAtMs: observedAt },
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toBeNull();
    });

    it('종착역 cap + grace 이내는 종착역 유지', () => {
      // ARC len 5, last idx 4. observedIdx=0, hops=6 → 0+6=6 > 4 cap → idx 4. grace=2 안.
      const lock = makeLock({ expectedDurationMs: 100 * HOP_TIME_MS });
      const observedAt = T0;
      const r = estimateStationProgress({
        lock,
        arcStations: ARC,
        now: observedAt + 6 * HOP_TIME_MS,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: { arcIndex: 0, observedAtMs: observedAt },
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toEqual({
        station: ARC[4],
        index: 4,
        strategy: 'reanchored-hop',
      });
    });
  });

  describe('Strategy ④ DefaultHop — boardedAt + boardingStationId 앵커 (Stage 3/#779)', () => {
    it('lastObserved 없으면 boardedAt + boardingIdx 앵커로 fallback', () => {
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0 + HOP_TIME_MS,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toEqual({
        station: ARC[1],
        index: 1,
        strategy: 'default-hop',
      });
    });

    it('boardingStationId가 arc에 없으면 ④ null', () => {
      const r = estimateStationProgress({
        lock: makeLock({ boardingStationId: '9-999' }),
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toBeNull();
    });

    it('boardedAt이 미래(시계 후진)면 ④ null', () => {
      // now < boardedAt → elapsed < 0 → ④ null.
      const lock = makeLock({ boardedAt: T0 + 60_000 });
      const r = estimateStationProgress({
        lock,
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toBeNull();
    });

    it('종착역 cap+grace 초과 시 ④ null', () => {
      const lock = makeLock({ expectedDurationMs: 100 * HOP_TIME_MS });
      const r = estimateStationProgress({
        lock,
        arcStations: ARC,
        now: T0 + 100 * HOP_TIME_MS,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toBeNull();
    });

    it('segment별 hop time이 다르면 누적 시간 기준으로 hop 산정 (ADR-008 §④)', () => {
      // lookup이 idx에 따라 가변 — 0→1: 60s, 1→2: 60s, 2→3: 120s, 3→4: 60s.
      // elapsed=150s → 0+1(60s 소비) → 1+1(120s 소비) → 다음 hop 120s는 30s만 남아 stop. hops=2.
      const variableHop = (fromIdx: number) =>
        fromIdx === 2 ? 120_000 : 60_000;
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0 + 150_000,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: variableHop,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r?.strategy).toBe('default-hop');
      expect(r?.index).toBe(2);
    });
  });

  describe('Strategy ② ArrivalEta — 다음 역 arrival로 ETA 투영 (#745)', () => {
    it('LivePosition stale + ArrivalEta 신선(ENTERING) → ② 채택, strategy=arrival-eta', () => {
      // currentIdxHint=2(군자). 다음 역=arcStations[3]=어린이대공원. ENTERING(0) → idx 2+1=3.
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: null, // ① stale
        lockedTrainCode: '7093',
        lastObserved: { arcIndex: 2, observedAtMs: T0 - 10_000 }, // ③도 가능하지만 ②가 우선
        hopTimeMsForHop: UNIFORM_HOP,
        nextStationArrivals: [
          makeArrival({ arrivalCode: ARRIVAL_CODE.ENTERING, arrivalSeconds: 14 }),
        ],
        arrivalEtaTtlMs: ARRIVAL_TTL_MS,
        currentIdxHint: 2,
      });
      expect(r).toEqual({
        station: ARC[3],
        index: 3,
        strategy: 'arrival-eta',
      });
    });

    it('PREV_ARRIVED(5) → currentIdx 유지, strategy=arrival-eta', () => {
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        nextStationArrivals: [
          makeArrival({ arrivalCode: ARRIVAL_CODE.PREV_ARRIVED, arrivalSeconds: 45 }),
        ],
        arrivalEtaTtlMs: ARRIVAL_TTL_MS,
        currentIdxHint: 2,
      });
      expect(r).toEqual({
        station: ARC[2],
        index: 2,
        strategy: 'arrival-eta',
      });
    });

    it('ArrivalEta stale(TTL 초과) → ReanchoredHop으로 fallback', () => {
      // arrival row receivedAtMs가 TTL 초과 → ② null → ③ ReanchoredHop 채택.
      const observedAt = T0 - 200_000;
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: { arcIndex: 1, observedAtMs: observedAt },
        hopTimeMsForHop: UNIFORM_HOP,
        nextStationArrivals: [
          makeArrival({
            arrivalCode: ARRIVAL_CODE.ENTERING,
            receivedAtMs: T0 - ARRIVAL_TTL_MS - 1,
          }),
        ],
        arrivalEtaTtlMs: ARRIVAL_TTL_MS,
        currentIdxHint: 1,
      });
      expect(r?.strategy).toBe('reanchored-hop');
    });

    it('currentIdxHint null → ② skip → ③ lastObs null이라 ④ DefaultHop fallback', () => {
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        nextStationArrivals: [
          makeArrival({ arrivalCode: ARRIVAL_CODE.ENTERING, arrivalSeconds: 14 }),
        ],
        arrivalEtaTtlMs: ARRIVAL_TTL_MS,
        currentIdxHint: null,
      });
      expect(r?.strategy).toBe('default-hop');
    });

    it('lockedTrainCode null → ② skip → ④ DefaultHop', () => {
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        nextStationArrivals: [
          makeArrival({ arrivalCode: ARRIVAL_CODE.ENTERING }),
        ],
        arrivalEtaTtlMs: ARRIVAL_TTL_MS,
        currentIdxHint: 2,
      });
      expect(r?.strategy).toBe('default-hop');
    });

    it('nextStationArrivals 빈 배열 → ② skip → ④ DefaultHop', () => {
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        nextStationArrivals: [],
        arrivalEtaTtlMs: ARRIVAL_TTL_MS,
        currentIdxHint: 2,
      });
      expect(r?.strategy).toBe('default-hop');
    });

    it('trainCode 미일치 → ② skip → ④ DefaultHop', () => {
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        nextStationArrivals: [
          makeArrival({ trainCode: '9999', arrivalCode: ARRIVAL_CODE.ENTERING }),
        ],
        arrivalEtaTtlMs: ARRIVAL_TTL_MS,
        currentIdxHint: 2,
      });
      expect(r?.strategy).toBe('default-hop');
    });
  });

  describe('우선순위 합성', () => {
    it('LivePosition 신선하면 ReanchoredHop이 있어도 LivePosition 채택', () => {
      const observedAt = T0;
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: observedAt + 5 * HOP_TIME_MS,
        trainProgress: makeTrainProgress({ stationIdx: 1 }), // LivePosition: idx 1
        lockedTrainCode: '7093',
        lastObserved: { arcIndex: 3, observedAtMs: observedAt }, // ReanchoredHop이 가능했다면 더 앞쪽
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      // LivePosition 우선 — strategy='live-position', index=1.
      expect(r).toEqual({
        station: ARC[1],
        index: 1,
        strategy: 'live-position',
      });
    });

    it('LivePosition 신선 + ArrivalEta도 가능 → LivePosition 우선 (① > ②)', () => {
      const r = estimateStationProgress({
        lock: makeLock(),
        arcStations: ARC,
        now: T0,
        trainProgress: makeTrainProgress({ stationIdx: 1 }),
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        nextStationArrivals: [
          makeArrival({ arrivalCode: ARRIVAL_CODE.ENTERING, arrivalSeconds: 10 }),
        ],
        arrivalEtaTtlMs: ARRIVAL_TTL_MS,
        currentIdxHint: 1,
      });
      expect(r?.strategy).toBe('live-position');
    });
  });
});

describe('arcIndexOfStation', () => {
  it('null 입력 시 -1', () => {
    expect(arcIndexOfStation(ARC, null)).toBe(-1);
    expect(arcIndexOfStation(ARC, undefined)).toBe(-1);
  });

  it('arc에 있는 station이면 인덱스 반환', () => {
    expect(arcIndexOfStation(ARC, ARC[2])).toBe(2);
  });

  it('arc에 없는 station이면 -1', () => {
    expect(
      arcIndexOfStation(ARC, { id: 'x', name: 'x', line: '1', lineColor: '', lat: 0, lng: 0 }),
    ).toBe(-1);
  });
});
