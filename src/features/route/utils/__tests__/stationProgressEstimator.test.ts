import { arcIndexOfStation, estimateStationProgress } from '../stationProgressEstimator';
import { HOP_TIME_MS } from '../../../../shared/constants/boardingLock';
import { ESTIMATOR_STUCK_TIMEOUT_MS } from '../../../../shared/constants/realtime';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
import { SIMPLE_ARRIVAL_ARCH_ENV_KEY } from '../../../../shared/config/archFlag';
import type { ArrivalInfo } from '../../../../shared/types/arrival';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { Station } from '../../../../shared/types/station';
import type { TrainProgressResult } from '../trackTrainProgress';

const ORIGINAL_ARCH_ENV = process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];

beforeEach(() => {
  // 각 테스트가 명시적으로 flag 를 셋하지 않는 한 dormant 기본값 유지 (flag OFF).
  delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
});

afterAll(() => {
  if (ORIGINAL_ARCH_ENV === undefined) {
    delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
  } else {
    process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = ORIGINAL_ARCH_ENV;
  }
});

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

    it('Seam B (#898) — segment hop time과 무관하게 boardingIdx+1로 cap', () => {
      // 적분 자체는 segment별 hop time을 누적하지만(0→1:60s, 2→3:120s) Seam B cap이
      // 결과를 boardingIdx+1=1로 제한 — dead-zone forward 발산 차단. variable-hop math
      // 자체의 회귀 가드는 Strategy ③ ReanchoredHop 테스트(상위) 참고.
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
      expect(r?.index).toBe(1);
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

  describe('Strategy ⑤ LocklessRouteHop — lock 없는 trip 시간 적분 (#1207, Epic #1204 D1)', () => {
    it('lock null + locklessTrip 5분 경과 + 60s/hop → hop index 5 (종착으로 clamp, arc 길이 5)', () => {
      // arcLength=5, lastIdx=4. 300_000ms / 60_000ms = 5 hop → idx 5 > 4 → clamp to 4.
      // #1922 (M2) — 5분 경과지만 lastObserved를 fresh(now-10s)로 줘서 stuck guard 통과.
      const hop60s = (_fromIdx: number) => 60_000;
      const now = T0 + 5 * 60_000;
      const r = estimateStationProgress({
        lock: null,
        locklessTrip: { tripStartedAt: T0 },
        arcStations: ARC,
        now,
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: { arcIndex: 4, observedAtMs: now - 10_000 },
        hopTimeMsForHop: hop60s,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toEqual({
        station: ARC[4],
        index: 4,
        strategy: 'lockless-route-hop',
      });
    });

    it('lock null + locklessTrip + arc 충분히 길고 60s/hop → 정확한 hop index (5분에 5번째 hop)', () => {
      // 긴 arc로 종착 clamp가 아닌 정확한 hop index 검증.
      // #1922 (M2) — lastObserved 신선해야 5분 경과해도 stuck guard 통과.
      const longArc: Station[] = Array.from({ length: 10 }, (_v, i) => ({
        id: `7-${i}`,
        name: `역${i}`,
        line: '7',
        lineColor: '#x',
        lat: 0,
        lng: 0,
      }));
      const hop60s = (_fromIdx: number) => 60_000;
      const now = T0 + 5 * 60_000;
      const r = estimateStationProgress({
        lock: null,
        locklessTrip: { tripStartedAt: T0 },
        arcStations: longArc,
        now,
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: { arcIndex: 5, observedAtMs: now - 10_000 },
        hopTimeMsForHop: hop60s,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toEqual({
        station: longArc[5],
        index: 5,
        strategy: 'lockless-route-hop',
      });
    });

    it('lock null + locklessTrip + arcStations 비면 null', () => {
      const r = estimateStationProgress({
        lock: null,
        locklessTrip: { tripStartedAt: T0 },
        arcStations: [],
        now: T0 + 60_000,
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toBeNull();
    });

    it('#1605 lock null + locklessTrip + arcStations 단일 역(route hop count=0) → null', () => {
      // arc가 1개 역만 가지는 edge case(예: destination 미설정 직후 / origin==destination).
      // 시간 적분이 무의미하므로 estimator skip — strategy=null entry가 buffer에 push되어
      // trip context 미준비 상태가 명시된다.
      const singleArc: Station[] = [ARC[0]];
      const r = estimateStationProgress({
        lock: null,
        locklessTrip: { tripStartedAt: T0 },
        arcStations: singleArc,
        now: T0 + 60 * 60_000, // 60분 경과해도 idx=0 강제 의미 없음.
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toBeNull();
    });

    it('lock null + locklessTrip tripStartedAt 미래(시계 후진) → null', () => {
      const r = estimateStationProgress({
        lock: null,
        locklessTrip: { tripStartedAt: T0 + 60_000 },
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toBeNull();
    });

    it('lock null + locklessTrip + elapsed가 arc 전체 길이 초과 → 마지막 인덱스로 clamp', () => {
      // arcLength=5, 100 hop 경과 → idx 100을 lastIdx=4로 clamp.
      // #1922 (M2) — lastObserved fresh로 stuck guard 통과 후 종착 clamp 검증.
      const now = T0 + 100 * HOP_TIME_MS;
      const r = estimateStationProgress({
        lock: null,
        locklessTrip: { tripStartedAt: T0 },
        arcStations: ARC,
        now,
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: { arcIndex: 4, observedAtMs: now - 10_000 },
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toEqual({
        station: ARC[4],
        index: 4,
        strategy: 'lockless-route-hop',
      });
    });

    it('lock null + locklessTrip 미제공(undefined) → null (기존 동작 유지)', () => {
      // 호출자가 locklessTrip을 옵트인하지 않으면 lock null trip은 estimator 비활성 그대로.
      const r = estimateStationProgress({
        lock: null,
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toBeNull();
    });

    it('lock null + locklessTrip = null → null (명시적 null도 비활성)', () => {
      const r = estimateStationProgress({
        lock: null,
        locklessTrip: null,
        arcStations: ARC,
        now: T0,
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r).toBeNull();
    });

    it('lock 활성이면 locklessTrip이 제공돼도 lock 전략이 우선 (lock 우선)', () => {
      // lock이 있으면 locklessTrip 무시 — 기존 lock 기반 4단 전략으로 흐른다.
      const r = estimateStationProgress({
        lock: makeLock(),
        locklessTrip: { tripStartedAt: T0 - 999 * 60_000 },
        arcStations: ARC,
        now: T0 + HOP_TIME_MS,
        trainProgress: null,
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      // lock + lastObserved null → ④ DefaultHop, boardingIdx(0) + 1 hop = idx 1.
      expect(r?.strategy).toBe('default-hop');
      expect(r?.index).toBe(1);
    });

    it('lock null + locklessTrip + variable hop time (환승 leg) → segment별 적분', () => {
      // arc에 환승 leg 가정. fromIdx 0,1: 60s, fromIdx 2,3: 120s.
      // 240s 경과 → 60+60+120=240 정확히 → 3 hop → idx 3.
      // #1922 (M2) — lastObserved fresh로 stuck guard 통과 후 segment별 적분 검증.
      const variableHop = (fromIdx: number) =>
        fromIdx >= 2 ? 120_000 : 60_000;
      const now = T0 + 240_000;
      const r = estimateStationProgress({
        lock: null,
        locklessTrip: { tripStartedAt: T0 },
        arcStations: ARC,
        now,
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: { arcIndex: 2, observedAtMs: now - 10_000 },
        hopTimeMsForHop: variableHop,
        ...NO_ARRIVAL_INPUT,
      });
      expect(r?.strategy).toBe('lockless-route-hop');
      expect(r?.index).toBe(3);
    });

    describe('#1922 (M2) — 실측 신호 부재 90s+ stuck guard', () => {
      // 환승 leg 진입 후 lastObserved 끊긴 상태로 90s+ 지속되면 시간 적분 자체를 null 반환.
      // dump line 169~244의 estimator stuck → station-passed gate 매역 reject(61회) 회귀 차단.

      it('lastObserved 없음 + tripStartedAt 기준 90s 초과 → null', () => {
        const now = T0 + 91_000;
        const r = estimateStationProgress({
          lock: null,
          locklessTrip: { tripStartedAt: T0 },
          arcStations: ARC,
          now,
          trainProgress: null,
          lockedTrainCode: null,
          lastObserved: null, // 실측 신호 부재
          hopTimeMsForHop: UNIFORM_HOP,
          ...NO_ARRIVAL_INPUT,
        });
        expect(r).toBeNull();
      });

      it('lastObserved 없음 + tripStartedAt 기준 90s 이내 → 정상 lockless-route-hop', () => {
        // lockless trip 초기 90s 안에는 시간 적분 허용 (첫 실측 신호 도착 전 grace window).
        const now = T0 + 60_000;
        const r = estimateStationProgress({
          lock: null,
          locklessTrip: { tripStartedAt: T0 },
          arcStations: ARC,
          now,
          trainProgress: null,
          lockedTrainCode: null,
          lastObserved: null,
          hopTimeMsForHop: UNIFORM_HOP,
          ...NO_ARRIVAL_INPUT,
        });
        expect(r?.strategy).toBe('lockless-route-hop');
      });

      it('lastObserved 있지만 90s 초과 stale → null', () => {
        const now = T0 + 200_000;
        const r = estimateStationProgress({
          lock: null,
          locklessTrip: { tripStartedAt: T0 },
          arcStations: ARC,
          now,
          trainProgress: null,
          lockedTrainCode: null,
          lastObserved: { arcIndex: 1, observedAtMs: now - 95_000 }, // 95s 전 = stale
          hopTimeMsForHop: UNIFORM_HOP,
          ...NO_ARRIVAL_INPUT,
        });
        expect(r).toBeNull();
      });

      it('lastObserved fresh (90s 이내) → 정상 lockless-route-hop', () => {
        const now = T0 + 5 * 60_000; // 5분 경과 (오래)
        const r = estimateStationProgress({
          lock: null,
          locklessTrip: { tripStartedAt: T0 },
          arcStations: ARC,
          now,
          trainProgress: null,
          lockedTrainCode: null,
          lastObserved: { arcIndex: 3, observedAtMs: now - 30_000 }, // 30s 전 = fresh
          hopTimeMsForHop: UNIFORM_HOP,
          ...NO_ARRIVAL_INPUT,
        });
        expect(r?.strategy).toBe('lockless-route-hop');
      });
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

  describe('#1896 (RC-8) Strategy ④ DefaultHop — stuck timeout', () => {
    // ①②③ 모두 실패한 dead zone(DefaultHop만 활성)에서
    // ESTIMATOR_STUCK_TIMEOUT_MS(5분) 경과 + raw 적분 = boardingIdx (0 hop = 진짜 고착)이면 null 반환.
    // rawIdx = boardingIdx+1 (1 hop 진행)은 정상 진행이므로 null 반환 안 함.

    it('5분+ 경과 + 0 hop dead zone → null (stuck timeout)', () => {
      // ARC = [용마산, 중곡, 군자, 어린이대공원, 건대입구]. boardingIdx=0.
      // slowHop = elapsed+1 → 0 hops (stepMs > elapsedMs → break immediately) → rawIdx=0 → stuck.
      const elapsedMs = ESTIMATOR_STUCK_TIMEOUT_MS + 1;
      const slowHop = (_fromIdx: number) => elapsedMs + 1; // hop이 elapsed보다 더 걸림 → 0 hops
      const r = estimateStationProgress({
        lock: makeLock({ boardedAt: T0 }),
        arcStations: ARC, // 탑승역=ARC[0], arc 2개 이상
        now: T0 + elapsedMs,
        trainProgress: null, // ① dead
        lockedTrainCode: null, // ② dead
        lastObserved: null, // ③ dead
        hopTimeMsForHop: slowHop,
        ...NO_ARRIVAL_INPUT,
      });
      // 5분+ + rawIdx=0 = boardingIdx → 진짜 고착 → null
      expect(r).toBeNull();
    });

    it('5분+ 경과 + rawIdx = boardingIdx+1 (1 hop 완료) → 정상 반환 (고착 아님)', () => {
      // 1 hop이 정확히 5분+1ms 걸리는 세그먼트. 5분+1ms 경과 후 rawIdx=1=boardingIdx+1.
      // rawIdx <= boardingIdx (=0) → false → stuck 미판정 → 정상 반환.
      const oneHopSlowMs = ESTIMATOR_STUCK_TIMEOUT_MS + 1;
      // elapsedMs = oneHopSlowMs + 1 → 정확히 1hop 완료
      const r = estimateStationProgress({
        lock: makeLock({ boardedAt: T0 }),
        arcStations: ARC,
        now: T0 + oneHopSlowMs + 1,
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: null,
        hopTimeMsForHop: (_fromIdx: number) => oneHopSlowMs, // 정확히 1hop = timeout+1ms
        ...NO_ARRIVAL_INPUT,
      });
      // elapsed = oneHopSlowMs+1 ≥ oneHopSlowMs → 1 hop 완료 → rawIdx=1 > boardingIdx=0 → 정상
      expect(r).not.toBeNull();
      expect(r?.strategy).toBe('default-hop');
      expect(r?.index).toBe(1); // Seam B cap at boardingIdx+1
    });

    it('5분 미만 → 고착이어도 null 반환 안 함 (timeout 미충족)', () => {
      const slowHop = (_fromIdx: number) => ESTIMATOR_STUCK_TIMEOUT_MS + 1;
      const r = estimateStationProgress({
        lock: makeLock({ boardedAt: T0 }),
        arcStations: ARC,
        now: T0 + ESTIMATOR_STUCK_TIMEOUT_MS - 1, // 5분 미만
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: null,
        hopTimeMsForHop: slowHop,
        ...NO_ARRIVAL_INPUT,
      });
      // 5분 미만 → timeout 미충족 → Seam B cap 후 boardingIdx 반환
      expect(r).not.toBeNull();
      expect(r?.strategy).toBe('default-hop');
      expect(r?.index).toBe(0);
    });

    it('5분+ 경과 + rawIdx ≥ boardingIdx+1 → 정상 반환 (hop 1+ 진행 = 고착 아님)', () => {
      // rawIdx >= boardingIdx+1이면 stuck 미판정. UNIFORM_HOP=90s, 5분30초 = 330s → 3 hops.
      // rawIdx=3 > boardingIdx=0 → not stuck → Seam B cap → boardingIdx+1=1.
      const r = estimateStationProgress({
        lock: makeLock({ boardedAt: T0 }),
        arcStations: ARC,
        now: T0 + ESTIMATOR_STUCK_TIMEOUT_MS + 30_000, // 5분 30초 elapsed, 90s/hop → 3 hops
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP, // 90s per hop
        ...NO_ARRIVAL_INPUT,
      });
      // rawIdx=3 > boardingIdx=0 → not stuck → Seam B cap → boardingIdx+1=1
      expect(r).not.toBeNull();
      expect(r?.strategy).toBe('default-hop');
      expect(r?.index).toBe(1); // Seam B cap
    });

    it('boardingIdx가 arc 마지막이면 stuck timeout 게이트 미진입 — over-terminal grace가 자연 차단', () => {
      // boardingIdx+1 >= arcStations.length이면 stuck timeout 게이트 자체를 skip.
      // 그러나 arc 경계에서 hopsElapsedFrom이 HOP_TIME_MS(90s) fallback으로 over-terminal grace를
      // 초과하면 projectIndexByHopTime이 null → tryDefaultHop도 null — stuck timeout 게이트와 무관.
      // 본 테스트는 "게이트 skip → 기존 over-terminal 동작 유지"를 검증.
      const singleArc = [ARC[0], ARC[1]]; // boardingIdx=1이 마지막
      const slowHop = (_fromIdx: number) => ESTIMATOR_STUCK_TIMEOUT_MS + 1;
      const r = estimateStationProgress({
        lock: makeLock({ boardingStationId: ARC[1].id, boardedAt: T0 }),
        arcStations: singleArc,
        now: T0 + ESTIMATOR_STUCK_TIMEOUT_MS + 1,
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: null,
        hopTimeMsForHop: slowHop,
        ...NO_ARRIVAL_INPUT,
      });
      // boardingIdx=1, arcStations.length=2 → 게이트 skip.
      // hopsElapsedFrom(2, 1, 300001, slowHop): arc 경계에서 HOP_TIME_MS(90s) fallback → 3 hops → idx=4
      // over-terminal check: 4 > lastIdx(1) + GRACE(2) = 3 → projectIndexByHopTime null → tryDefaultHop null.
      expect(r).toBeNull();
    });

    it('Strategy ① LivePosition 활성이면 stuck timeout 도달 안 함', () => {
      // ①이 살아있으면 tryLivePosition에서 반환 → tryDefaultHop 미도달 → timeout gate 미진입.
      const r = estimateStationProgress({
        lock: makeLock({ boardedAt: T0 }),
        arcStations: ARC,
        now: T0 + ESTIMATOR_STUCK_TIMEOUT_MS + 1,
        trainProgress: makeTrainProgress({ stationIdx: 2, trainNo: '7093' }),
        lockedTrainCode: '7093',
        lastObserved: null,
        hopTimeMsForHop: UNIFORM_HOP,
        ...NO_ARRIVAL_INPUT,
      });
      // ① 채택 → live-position, index=2
      expect(r?.strategy).toBe('live-position');
      expect(r?.index).toBe(2);
    });
  });

  describe('#2012 (Phase 4-2) SIMPLE_ARRIVAL_ARCH flag guard', () => {
    // flag ON 시 arrival API (`arvlCd` 조합) 가 SSoT 이므로 estimator 내부 두 strategy 를 dormant.
    //   - tryLivePosition skip → ArrivalEta / ReanchoredHop / DefaultHop 만
    //   - tryLocklessRouteHop skip → null 반환 (arvlCd SSoT 가 lockless 진행 담당)
    // flag OFF (기본) 은 기존 4단 + LocklessRouteHop 100% 유지.

    describe('lock 활성 — live-position dormant', () => {
      it('flag OFF: LivePosition 매칭 시나리오 → live-position 채택', () => {
        // 기존 우선순위 합성 시나리오와 동일 — flag 명시 OFF 도 default 와 같음.
        process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'false';
        const r = estimateStationProgress({
          lock: makeLock(),
          arcStations: ARC,
          now: T0,
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

      it('flag ON: 동일 시나리오 → live-position skip → default-hop fallback (② ③ 입력 없음)', () => {
        // trainProgress 완비 + lockedTrainCode 매칭이지만 flag ON 이라 ① skip.
        // ② ArrivalEta 입력 없음(NO_ARRIVAL_INPUT), ③ ReanchoredHop 앵커 없음(lastObserved null)
        // → ④ DefaultHop 이 boardedAt 앵커로 fallback (elapsed=0 → boardingIdx=0).
        process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
        const r = estimateStationProgress({
          lock: makeLock(),
          arcStations: ARC,
          now: T0,
          trainProgress: makeTrainProgress({ stationIdx: 2 }),
          lockedTrainCode: '7093',
          lastObserved: null,
          hopTimeMsForHop: UNIFORM_HOP,
          ...NO_ARRIVAL_INPUT,
        });
        expect(r?.strategy).toBe('default-hop');
        expect(r?.index).toBe(0);
      });

      it('flag ON: ① skip 후 ② ArrivalEta 가능하면 arrival-eta 채택', () => {
        // flag ON 에서도 ArrivalEta 는 유효 — arrival API 응답 자체를 소비하는 strategy.
        process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
        const r = estimateStationProgress({
          lock: makeLock(),
          arcStations: ARC,
          now: T0,
          trainProgress: makeTrainProgress({ stationIdx: 1 }), // ① 매칭됐어도 flag ON 이라 skip
          lockedTrainCode: '7093',
          lastObserved: null,
          hopTimeMsForHop: UNIFORM_HOP,
          nextStationArrivals: [
            makeArrival({ arrivalCode: ARRIVAL_CODE.ENTERING, arrivalSeconds: 14 }),
          ],
          arrivalEtaTtlMs: ARRIVAL_TTL_MS,
          currentIdxHint: 2,
        });
        expect(r?.strategy).toBe('arrival-eta');
        expect(r?.index).toBe(3);
      });

      it('flag ON: ① skip 후 ③ ReanchoredHop 가능하면 reanchored-hop 채택', () => {
        // lastObserved 있고 ② 입력 없음 → ③ ReanchoredHop 채택 (flag 와 무관하게 유지).
        process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
        const observedAt = T0 + 200_000;
        const r = estimateStationProgress({
          lock: makeLock(),
          arcStations: ARC,
          now: observedAt + 2 * HOP_TIME_MS,
          trainProgress: makeTrainProgress({ stationIdx: 0 }), // ① 매칭됐어도 flag ON 이라 skip
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
    });

    describe('lockless — lockless-route-hop dormant', () => {
      it('flag OFF: lockless trip 진행 → lockless-route-hop 채택', () => {
        process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'false';
        const now = T0 + 60_000;
        const r = estimateStationProgress({
          lock: null,
          locklessTrip: { tripStartedAt: T0 },
          arcStations: ARC,
          now,
          trainProgress: null,
          lockedTrainCode: null,
          lastObserved: null,
          hopTimeMsForHop: UNIFORM_HOP,
          ...NO_ARRIVAL_INPUT,
        });
        expect(r?.strategy).toBe('lockless-route-hop');
      });

      it('flag ON: lockless trip 제공돼도 null 반환 (arvlCd SSoT 담당)', () => {
        process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
        const now = T0 + 60_000;
        const r = estimateStationProgress({
          lock: null,
          locklessTrip: { tripStartedAt: T0 },
          arcStations: ARC,
          now,
          trainProgress: null,
          lockedTrainCode: null,
          lastObserved: null,
          hopTimeMsForHop: UNIFORM_HOP,
          ...NO_ARRIVAL_INPUT,
        });
        expect(r).toBeNull();
      });

      it('flag ON: locklessTrip 미제공 시 여전히 null (기존 동작 유지)', () => {
        // locklessTrip 미제공은 원래도 null → flag 와 무관.
        process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
        const r = estimateStationProgress({
          lock: null,
          arcStations: ARC,
          now: T0 + 60_000,
          trainProgress: null,
          lockedTrainCode: null,
          lastObserved: null,
          hopTimeMsForHop: UNIFORM_HOP,
          ...NO_ARRIVAL_INPUT,
        });
        expect(r).toBeNull();
      });
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

/**
 * Phase 1-7 (#1996, ADR-022 A4) — boardingStationId 불변 회귀 가드.
 *
 * estimator는 arc 위 hop index만 계산한다. reanchored-hop / default-hop / arrival-eta /
 * lockless-route-hop 등 모든 strategy가 `lock.boardingStationId` 자체를 mutate하지 않아야 한다
 * (route 등록 시 확정된 boardingStationId는 auto-swap / reanchored / fusion cascade에서 절대 자동 변경 금지).
 *
 * 회귀 신호: 사용자 관찰 `reanchored-hop | 어린이대공원 idx=3` (Estimator State) —
 * 정상은 lock.boardingStationId 유지 + arc 위 idx=3 station을 return. 만약 미래 어떤 refactor에서
 * estimator가 lock 객체를 직접 mutate하거나 새 boardingStationId를 담은 lock 객체를 wrap해 반환하면 본 test가 실패.
 */
describe('Phase 1-7 (#1996) — boardingStationId 불변 (estimator)', () => {
  it('reanchored-hop 전략은 lock.boardingStationId를 mutate하지 않는다', () => {
    const lock = makeLock({ boardingStationId: '7-001' });
    const originalBoardingStationId = lock.boardingStationId;
    const observedAt = T0 + 200_000;

    // reanchored-hop 채택 조건: lastObserved 있음 + hop 진행.
    const r = estimateStationProgress({
      lock,
      arcStations: ARC,
      now: observedAt + 3 * HOP_TIME_MS,
      trainProgress: null,
      lockedTrainCode: '7093',
      lastObserved: { arcIndex: 1, observedAtMs: observedAt },
      hopTimeMsForHop: UNIFORM_HOP,
      ...NO_ARRIVAL_INPUT,
    });

    // estimator는 arc 위 앞 station으로 hop 진행 결과를 return.
    expect(r?.strategy).toBe('reanchored-hop');
    expect(r?.index).toBe(4); // idx 1 + 3 hop
    expect(r?.station).toBe(ARC[4]);

    // 핵심: lock 객체 자체는 어떤 필드도 변경되지 않아야 한다.
    expect(lock.boardingStationId).toBe(originalBoardingStationId);
    expect(lock.boardingStationId).toBe('7-001');
  });

  it('default-hop 전략은 lock.boardingStationId를 mutate하지 않는다', () => {
    const lock = makeLock({ boardingStationId: '7-001' });
    const originalBoardingStationId = lock.boardingStationId;

    // default-hop 채택 조건: lastObserved 없음.
    const r = estimateStationProgress({
      lock,
      arcStations: ARC,
      now: T0 + HOP_TIME_MS,
      trainProgress: null,
      lockedTrainCode: '7093',
      lastObserved: null,
      hopTimeMsForHop: UNIFORM_HOP,
      ...NO_ARRIVAL_INPUT,
    });

    expect(r?.strategy).toBe('default-hop');
    expect(r?.index).toBe(1);
    // lock 객체 immutable.
    expect(lock.boardingStationId).toBe(originalBoardingStationId);
  });

  it('live-position 전략은 lock.boardingStationId를 mutate하지 않는다', () => {
    const lock = makeLock({ boardingStationId: '7-001' });
    const originalBoardingStationId = lock.boardingStationId;

    // live-position 채택 조건: trainProgress + lockedTrainCode 매칭.
    const r = estimateStationProgress({
      lock,
      arcStations: ARC,
      now: T0 + HOP_TIME_MS,
      trainProgress: makeTrainProgress({ stationIdx: 2 }),
      lockedTrainCode: '7093',
      lastObserved: null,
      hopTimeMsForHop: UNIFORM_HOP,
      ...NO_ARRIVAL_INPUT,
    });

    expect(r?.strategy).toBe('live-position');
    expect(r?.index).toBe(2);
    // lock 객체 immutable.
    expect(lock.boardingStationId).toBe(originalBoardingStationId);
  });

  it('estimator 다수 tick 반복해도 lock 원본 객체가 mutate되지 않는다 (frozen 동작)', () => {
    const lock = makeLock({ boardingStationId: '7-001' });
    // Object.freeze로 실제 write attempt 시 strict mode에서 throw — estimator가 write 시도 자체를 하지 않음을 강제.
    Object.freeze(lock);

    // 다양한 시점의 tick을 반복 — reanchored-hop / default-hop / live-position 모두 순회.
    const inputs = [
      { now: T0, lastObserved: null, trainProgress: null },
      { now: T0 + HOP_TIME_MS, lastObserved: null, trainProgress: null },
      { now: T0 + 2 * HOP_TIME_MS, lastObserved: { arcIndex: 0, observedAtMs: T0 }, trainProgress: null },
      { now: T0 + 3 * HOP_TIME_MS, lastObserved: { arcIndex: 1, observedAtMs: T0 }, trainProgress: null },
      { now: T0 + HOP_TIME_MS, lastObserved: null, trainProgress: makeTrainProgress({ stationIdx: 3 }) },
    ];

    // 각 tick에서 exception 없이 estimator가 결과를 return + lock은 여전히 원본 boardingStationId 유지.
    expect(() => {
      for (const input of inputs) {
        estimateStationProgress({
          lock,
          arcStations: ARC,
          hopTimeMsForHop: UNIFORM_HOP,
          lockedTrainCode: '7093',
          ...NO_ARRIVAL_INPUT,
          ...input,
        });
      }
    }).not.toThrow();

    expect(lock.boardingStationId).toBe('7-001');
  });
});
