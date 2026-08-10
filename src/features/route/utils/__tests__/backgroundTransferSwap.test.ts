/**
 * #1281 — evaluateBackgroundTransferSwap (BG 환승 자동 detect).
 *
 * BG context에서 환승역 도착 + 다른 노선 임박(이동 중) 신호가 잡히면 swap candidate 평가 후
 * backend `/boarding-lock/sync`를 발사하는지, 그리고 같은 노선 직진(비환승) trip에서는 발사하지
 * 않는지(false positive = 0) 검증한다.
 */
import {
  evaluateBackgroundTransferSwap,
  resetBackgroundTransferSwapState,
} from '../backgroundTransferSwap';
import { makeArrivalInfo } from '../../../../testUtils/fixtures';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { NearestStationsResult, Station } from '../../../../shared/types/station';
import type {
  BackgroundTransferSwapDeps,
  BackgroundTransferSwapSyncPayload,
} from '../backgroundTransferSwap';

const DDP_7: Station = { id: '0707', name: '건대입구', line: '7', lineColor: '#54640D', lat: 37.54, lng: 127.07 };
const DDP_2: Station = { id: '0727', name: '건대입구', line: '2', lineColor: '#009D3E', lat: 37.54, lng: 127.07 };
const NON_TRANSFER: Station = { id: '0222', name: '강남', line: '2', lineColor: '#009D3E', lat: 37.498, lng: 127.027 };

const transferNearest: NearestStationsResult = {
  primary: DDP_7,
  variants: [DDP_7, DDP_2],
  distanceKm: 0.02,
  isTransfer: true,
};

const nonTransferNearest: NearestStationsResult = {
  primary: NON_TRANSFER,
  variants: [NON_TRANSFER],
  distanceKm: 0.02,
  isTransfer: false,
};

function makeArrival(up: ArrivalInfo[] = [], down: ArrivalInfo[] = []): StationArrival {
  return { up, down };
}

// 7호선 탑승 중 lock. 환승 시 2호선(다른 노선)으로 swap 기대.
const lock7: BoardingLock = {
  destinationId: 'dest-1',
  trainCode: 'T-7-old',
  boardingStationId: DDP_7.id,
  boardingLine: '7',
  boardedAt: Date.now(),
  expectedDurationMs: 30 * 60_000,
};

function baseInput(overrides: Partial<Parameters<typeof evaluateBackgroundTransferSwap>[0]> = {}) {
  return {
    lat: 37.54,
    lng: 127.07,
    accuracy: 20,
    observedAtMs: 1_700_000_000_000,
    apnsToken: 'tok-abc',
    lock: lock7 as BoardingLock | null,
    motionStationary: false,
    destinationName: null as string | null,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<BackgroundTransferSwapDeps> & {
    arrival?: StationArrival;
    arrivalError?: boolean;
    syncSpy?: jest.Mock;
    nearest?: NearestStationsResult | null;
  } = {},
): { deps: BackgroundTransferSwapDeps; syncSpy: jest.Mock } {
  const syncSpy = overrides.syncSpy ?? jest.fn().mockResolvedValue({ ok: true });
  const getArrival = overrides.arrivalError
    ? jest.fn().mockRejectedValue(new Error('network'))
    : jest.fn().mockResolvedValue(overrides.arrival ?? makeArrival());
  const deps: BackgroundTransferSwapDeps = {
    findNearestStations:
      overrides.findNearestStations ??
      jest.fn(() => (overrides.nearest !== undefined ? overrides.nearest : transferNearest)),
    arrivalProvider: { getArrival },
    syncBoardingLock: overrides.syncBoardingLock ?? syncSpy,
  };
  return { deps, syncSpy };
}

describe('evaluateBackgroundTransferSwap', () => {
  beforeEach(() => {
    resetBackgroundTransferSwapState();
  });

  it('lock 없으면 no-op', async () => {
    const { deps, syncSpy } = makeDeps();
    const result = await evaluateBackgroundTransferSwap(baseInput({ lock: null }), deps);
    expect(result).toEqual({ fired: false });
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('최근접 역이 환승역이 아니면 no-op (arrival fetch도 안 함)', async () => {
    const { deps, syncSpy } = makeDeps({ nearest: nonTransferNearest });
    const result = await evaluateBackgroundTransferSwap(baseInput(), deps);
    expect(result.fired).toBe(false);
    expect(deps.arrivalProvider.getArrival).not.toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('최근접 역 결과가 null이면 no-op', async () => {
    const { deps, syncSpy } = makeDeps({ nearest: null });
    const result = await evaluateBackgroundTransferSwap(baseInput(), deps);
    expect(result.fired).toBe(false);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('arrival 조회 실패는 graceful no-op', async () => {
    const { deps, syncSpy } = makeDeps({ arrivalError: true });
    const result = await evaluateBackgroundTransferSwap(baseInput(), deps);
    expect(result.fired).toBe(false);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('환승역 + 다른 노선 임박 + 이동 중 → swap candidate 평가 후 sync 발사', async () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2-new' }),
    ]);
    const { deps, syncSpy } = makeDeps({ arrival });
    const result = await evaluateBackgroundTransferSwap(baseInput({ motionStationary: false }), deps);

    expect(result).toEqual({ fired: true, trainCode: 'T-2-new' });
    expect(deps.arrivalProvider.getArrival).toHaveBeenCalledWith('건대입구', { lineHint: '7' });
    expect(syncSpy).toHaveBeenCalledTimes(1);
    const payload = syncSpy.mock.calls[0][0] as BackgroundTransferSwapSyncPayload;
    expect(payload).toMatchObject({
      token: 'tok-abc',
      observedStationName: '건대입구',
      observedAtMs: 1_700_000_000_000,
      accuracy: 20,
      trainCode: 'T-2-new',
      boardingLine: '2',
    });
  });

  it('같은 노선 직진(비환승) — 현재 boardingLine 도착만 있으면 swap 미발사 (false positive 0)', async () => {
    // 7호선 lock 유지 중 7호선 도착만 잡힘 → 다른 노선 후보 없음 → 발사 X.
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '온수', arrivalSeconds: 60, line: '7', trainCode: 'T-7-next' }),
    ]);
    const { deps, syncSpy } = makeDeps({ arrival });
    const result = await evaluateBackgroundTransferSwap(baseInput(), deps);

    expect(result.fired).toBe(false);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('정지 중(motionStationary=true)이면 다른 노선 임박이어도 swap 미발사', async () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2-new' }),
    ]);
    const { deps, syncSpy } = makeDeps({ arrival });
    const result = await evaluateBackgroundTransferSwap(baseInput({ motionStationary: true }), deps);

    expect(result.fired).toBe(false);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('다중 다른 노선 후보(단일 trainCode 미확정)면 swap 미발사', async () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2' }),
      makeArrivalInfo({ destination: '천호', arrivalSeconds: 90, line: '5', trainCode: 'T-5' }),
    ]);
    const { deps, syncSpy } = makeDeps({ arrival });
    const result = await evaluateBackgroundTransferSwap(baseInput(), deps);

    expect(result.fired).toBe(false);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('같은 환승역 + 같은 leg lock으로 두 번째 tick은 arrival 재조회 없이 skip', async () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2-new' }),
    ]);
    const { deps, syncSpy } = makeDeps({ arrival });

    const first = await evaluateBackgroundTransferSwap(baseInput(), deps);
    expect(first.fired).toBe(true);

    const second = await evaluateBackgroundTransferSwap(baseInput(), deps);
    expect(second.fired).toBe(false);
    // arrival 조회/ sync 모두 1회만 — 두 번째 tick은 dedup으로 차단.
    expect(deps.arrivalProvider.getArrival).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it('새 leg lock(boardingLine 변경)으로 hydrate되면 다음 환승은 다시 발사 허용', async () => {
    const arrival2 = makeArrival([
      makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2-new' }),
    ]);
    const { deps, syncSpy } = makeDeps({ arrival: arrival2 });

    await evaluateBackgroundTransferSwap(baseInput(), deps);
    // silent push가 2호선 leg로 hydrate → lock.boardingLine='2'. 다음 환승역(2→5)에서 다시 평가.
    const lock2: BoardingLock = { ...lock7, boardingLine: '2', trainCode: 'T-2-new', boardingStationId: DDP_2.id };
    const arrival5 = makeArrival([
      makeArrivalInfo({ destination: '천호', arrivalSeconds: 60, line: '5', trainCode: 'T-5-new' }),
    ]);
    (deps.arrivalProvider.getArrival as jest.Mock).mockResolvedValue(arrival5);

    const result = await evaluateBackgroundTransferSwap(baseInput({ lock: lock2 }), deps);
    expect(result).toEqual({ fired: true, trainCode: 'T-5-new' });
    expect(syncSpy).toHaveBeenCalledTimes(2);
  });

  it('lock 해제(null) 시 dedup 키 reset — 재탑승 시 같은 환승역 다시 발사', async () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2-new' }),
    ]);
    const { deps, syncSpy } = makeDeps({ arrival });

    await evaluateBackgroundTransferSwap(baseInput(), deps);
    await evaluateBackgroundTransferSwap(baseInput({ lock: null }), deps); // 하차 → reset
    const result = await evaluateBackgroundTransferSwap(baseInput(), deps);

    expect(result.fired).toBe(true);
    expect(syncSpy).toHaveBeenCalledTimes(2);
  });

  // #2268 — 2026-08-10 실탑승 RCA: sync 응답의 autoLockCandidate를 버리고 죽은 silent push를
  // 기다리던 회귀. sync 응답에 candidate가 실려오면 hydrateLock으로 직접 hydrate해야 한다.
  it('sync 응답에 autoLockCandidate가 있으면 hydrateLock을 후보+역명 컨텍스트로 호출', async () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2-new' }),
    ]);
    const candidate = { trainCode: 'T-2-new', line: '2', subwayId: '1002', from: 'transfer-swap' as const };
    const syncSpy = jest.fn().mockResolvedValue({ ok: true, autoLockCandidate: candidate });
    const { deps } = makeDeps({ arrival, syncSpy });
    const hydrateLock = jest.fn();

    const result = await evaluateBackgroundTransferSwap(baseInput(), { ...deps, hydrateLock });

    expect(result).toEqual({ fired: true, trainCode: 'T-2-new' });
    expect(hydrateLock).toHaveBeenCalledTimes(1);
    expect(hydrateLock).toHaveBeenCalledWith(candidate, { stationName: '건대입구' });
  });

  it('sync 응답에 autoLockCandidate가 없으면 hydrateLock 미호출', async () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2-new' }),
    ]);
    const syncSpy = jest.fn().mockResolvedValue({ ok: true });
    const { deps } = makeDeps({ arrival, syncSpy });
    const hydrateLock = jest.fn();

    await evaluateBackgroundTransferSwap(baseInput(), { ...deps, hydrateLock });

    expect(hydrateLock).not.toHaveBeenCalled();
  });

  it('hydrateLock 미주입이어도 sync 응답 처리는 graceful (throw 없음)', async () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '성수', arrivalSeconds: 60, line: '2', trainCode: 'T-2-new' }),
    ]);
    const candidate = { trainCode: 'T-2-new', line: '2', subwayId: '1002', from: 'transfer-swap' as const };
    const syncSpy = jest.fn().mockResolvedValue({ ok: true, autoLockCandidate: candidate });
    const { deps } = makeDeps({ arrival, syncSpy });

    await expect(evaluateBackgroundTransferSwap(baseInput(), deps)).resolves.toEqual({
      fired: true,
      trainCode: 'T-2-new',
    });
  });
});
