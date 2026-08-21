/* eslint-disable import/no-restricted-paths --
 * 대상 hook(useTransferAutoDetect)이 본질적 cross-feature orchestrator로 file-level 옵트인되어
 * 있으므로 그 테스트도 동일 정책으로 nearest-station type을 직접 import한다.
 */
/**
 * #924 — useTransferAutoDetect (D1 후속 PR — production wire).
 * #2342 — 단일 후보 무탭 auto-lock 삭제. 후보 1개든 N개든 모달로 탭을 요구한다.
 *
 * pure 알고리즘은 transferDetect.test.ts에서 커버. 본 테스트는 hook 차원에서:
 *   - 다른 노선 arrival 수집 + boardingLine 제외
 *   - 단일/다중 후보 모두 → 모달 open (무탭 onAutoLock 없음) + selectLine으로만 hydrate
 *   - planned route transfer waypoint이면 detect skip
 *   - 환승역 벗어나면 dismiss flag 리셋
 */
import { act, renderHook } from '@testing-library/react-native';
import { useTransferAutoDetect } from '../useTransferAutoDetect';
import { MOCK_STATIONS, makeArrivalInfo } from '../../../../testUtils/fixtures';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { NearestStationsResult, Station } from '../../../../shared/types/station';
import type { AutoLockCandidate } from '../../../nearest-station/api/boardingLockSync';

// 동대문역사문화공원 — 2호선/4호선/5호선 환승역 fixture(테스트 전용 stations.json 무관).
const DDP_2: Station = { id: '0205', name: '동대문역사문화공원', line: '2', lineColor: '#009D3E', lat: 37.565, lng: 127.008 };
const DDP_4: Station = { id: '0405', name: '동대문역사문화공원', line: '4', lineColor: '#00A0E2', lat: 37.565, lng: 127.008 };
const DDP_5: Station = { id: '0505', name: '동대문역사문화공원', line: '5', lineColor: '#996CAC', lat: 37.565, lng: 127.008 };

const transferNearest: NearestStationsResult = {
  primary: DDP_2,
  variants: [DDP_2, DDP_4, DDP_5],
  distanceKm: 0.03,
  isTransfer: true,
};

const nonTransferNearest: NearestStationsResult = {
  primary: MOCK_STATIONS.gangnam,
  variants: [MOCK_STATIONS.gangnam],
  distanceKm: 0.03,
  isTransfer: false,
};

function makeArrival(up: ArrivalInfo[] = [], down: ArrivalInfo[] = []): StationArrival {
  return { up, down };
}

function makeLock(overrides: Partial<BoardingLock> = {}): BoardingLock {
  return {
    destinationId: 'dest-1',
    trainCode: 'T001',
    boardingStationId: DDP_2.id,
    boardingLine: '2',
    boardedAt: Date.now(),
    expectedDurationMs: 30 * 60_000,
    ...overrides,
  };
}

function baseInputs(overrides: Partial<Parameters<typeof useTransferAutoDetect>[0]> = {}) {
  return {
    nearestStations: transferNearest,
    motionStationary: false,
    arrival: makeArrival(),
    boardingLock: null,
    route: null,
    destinationName: null,
    onAutoLock: jest.fn(),
    ...overrides,
  };
}

/** 5호선 90s 왕십리 임박 1줄. 다중 후보 fixture에서 line 5 슬롯으로 재사용. */
function line5Arrival(): ArrivalInfo {
  return makeArrivalInfo({ destination: '왕십리', arrivalSeconds: 90, line: '5', trainCode: 'T-5' });
}

/** 4호선 60s + 5호선 90s 두 줄 임박. 다중 후보 detect의 표준 fixture. */
function multiCandidateArrival(): StationArrival {
  return makeArrival([
    makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4' }),
    line5Arrival(),
  ]);
}

/** rerender-capable hook 실행. props prop으로 동적 재실행. */
function renderTransferDetect(initialProps: Parameters<typeof useTransferAutoDetect>[0]) {
  return renderHook(
    (props: Parameters<typeof useTransferAutoDetect>[0]) => useTransferAutoDetect(props),
    { initialProps },
  );
}

describe('useTransferAutoDetect', () => {
  it('단일 후보 detect → 무탭 onAutoLock 호출 없음, 모달만 open (#2342)', () => {
    const onAutoLock = jest.fn();
    const arrival = makeArrival(
      [makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4-A' })],
      [makeArrivalInfo({ destination: '잠실', arrivalSeconds: 30, line: '2', trainCode: 'T-2-A' })],
    );
    const { result } = renderHook(() =>
      useTransferAutoDetect(baseInputs({ arrival, boardingLock: makeLock(), onAutoLock })),
    );
    expect(onAutoLock).not.toHaveBeenCalled();
    expect(result.current.modalVisible).toBe(true);
    expect(result.current.candidateLines).toEqual(['4']);
  });

  it('단일 후보 → 모달에서 selectLine 탭 시에만 onAutoLock 호출', () => {
    const onAutoLock = jest.fn();
    const arrival = makeArrival(
      [makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4-A' })],
      [makeArrivalInfo({ destination: '잠실', arrivalSeconds: 30, line: '2', trainCode: 'T-2-A' })],
    );
    const { result } = renderHook(() =>
      useTransferAutoDetect(baseInputs({ arrival, boardingLock: makeLock(), onAutoLock })),
    );
    expect(onAutoLock).not.toHaveBeenCalled();
    act(() => result.current.selectLine('4'));
    expect(onAutoLock).toHaveBeenCalledTimes(1);
    const candidate: AutoLockCandidate = onAutoLock.mock.calls[0][0];
    expect(candidate).toEqual({ trainCode: 'T-4-A', line: '4', subwayId: '1004' });
    expect(result.current.modalVisible).toBe(false);
  });

  it('motionStationary=true(정지) → no-op', () => {
    const onAutoLock = jest.fn();
    const arrival = makeArrival(
      [makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4' })],
    );
    renderHook(() =>
      useTransferAutoDetect(baseInputs({ arrival, motionStationary: true, onAutoLock })),
    );
    expect(onAutoLock).not.toHaveBeenCalled();
  });

  it('nearestStations=null → no-op', () => {
    const onAutoLock = jest.fn();
    renderHook(() => useTransferAutoDetect(baseInputs({ nearestStations: null, onAutoLock })));
    expect(onAutoLock).not.toHaveBeenCalled();
  });

  it('환승역 아님 → no-op', () => {
    const onAutoLock = jest.fn();
    const arrival = makeArrival(
      [makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4' })],
    );
    renderHook(() =>
      useTransferAutoDetect(baseInputs({ nearestStations: nonTransferNearest, arrival, onAutoLock })),
    );
    expect(onAutoLock).not.toHaveBeenCalled();
  });

  it('다중 후보 → 모달 open + modalCandidates 노출', () => {
    const onAutoLock = jest.fn();
    const { result } = renderHook(() =>
      useTransferAutoDetect(baseInputs({ arrival: multiCandidateArrival(), onAutoLock })),
    );
    expect(onAutoLock).not.toHaveBeenCalled();
    expect(result.current.modalVisible).toBe(true);
    expect(result.current.modalCandidates.map((s) => s.line)).toEqual(['4', '5']);
    expect(result.current.candidateLines).toEqual(['4', '5']);
  });

  it('selectLine → 해당 line의 임박 trainCode로 onAutoLock + 모달 close', () => {
    const onAutoLock = jest.fn();
    const { result } = renderTransferDetect(baseInputs({ arrival: multiCandidateArrival(), onAutoLock }));
    act(() => result.current.selectLine('5'));
    expect(onAutoLock).toHaveBeenCalledWith({ trainCode: 'T-5', line: '5', subwayId: '1005' });
    expect(result.current.modalVisible).toBe(false);
  });

  it('dismissModal → 같은 환승역에서 재오픈 안 됨, 다른 역으로 이동하면 재오픈 가능', () => {
    const onAutoLock = jest.fn();
    const arrival = multiCandidateArrival();
    const { result, rerender } = renderTransferDetect(baseInputs({ arrival, onAutoLock }));
    expect(result.current.modalVisible).toBe(true);
    act(() => result.current.dismissModal());
    expect(result.current.modalVisible).toBe(false);
    // 같은 station에서 새 polling — 다시 detect 일어나도 모달은 닫힌 채.
    rerender(baseInputs({ arrival, onAutoLock }));
    expect(result.current.modalVisible).toBe(false);
    // 환승역을 벗어남 → 다른 환승역에 다시 도착하면 모달이 다시 열린다.
    rerender(baseInputs({ nearestStations: nonTransferNearest, arrival, onAutoLock }));
    rerender(baseInputs({ arrival, onAutoLock }));
    expect(result.current.modalVisible).toBe(true);
  });

  it('단일 후보 — polling 반복돼도 무탭 onAutoLock 없음, 모달만 유지', () => {
    const onAutoLock = jest.fn();
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4-A' }),
    ]);
    const { result, rerender } = renderTransferDetect(baseInputs({ arrival, onAutoLock }));
    rerender(baseInputs({ arrival, onAutoLock }));
    rerender(baseInputs({ arrival, onAutoLock }));
    expect(onAutoLock).not.toHaveBeenCalled();
    expect(result.current.modalVisible).toBe(true);
  });

  it('단일 후보 — 다른 trainCode로 갱신돼도 여전히 탭(selectLine) 시에만 최신 trainCode로 hydrate', () => {
    const onAutoLock = jest.fn();
    const arrivalA = makeArrival([
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4-A' }),
    ]);
    const arrivalB = makeArrival([
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4-B' }),
    ]);
    const { result, rerender } = renderTransferDetect(baseInputs({ arrival: arrivalA, onAutoLock }));
    rerender(baseInputs({ arrival: arrivalB, onAutoLock }));
    expect(onAutoLock).not.toHaveBeenCalled();
    act(() => result.current.selectLine('4'));
    expect(onAutoLock).toHaveBeenCalledTimes(1);
    expect(onAutoLock.mock.calls[0][0].trainCode).toBe('T-4-B');
  });

  it('도착 데이터 없음 → trainCode pick 실패 → no-op', () => {
    const onAutoLock = jest.fn();
    renderHook(() =>
      useTransferAutoDetect(baseInputs({ arrival: null, onAutoLock })),
    );
    expect(onAutoLock).not.toHaveBeenCalled();
  });

  it('도착 음수만 있음(이미 지나간 차) → no-op', () => {
    const onAutoLock = jest.fn();
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: -10, line: '4', trainCode: 'T-4' }),
    ]);
    renderHook(() => useTransferAutoDetect(baseInputs({ arrival, onAutoLock })));
    expect(onAutoLock).not.toHaveBeenCalled();
  });

  it('boardingLock이 후보 line과 같음 → 자기 노선은 제외되어 후보 0', () => {
    const onAutoLock = jest.fn();
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '왕십리', arrivalSeconds: 60, line: '5', trainCode: 'T-5' }),
    ]);
    renderHook(() =>
      useTransferAutoDetect(
        baseInputs({ arrival, boardingLock: makeLock({ boardingLine: '5' }), onAutoLock }),
      ),
    );
    expect(onAutoLock).not.toHaveBeenCalled();
  });

  it('planned route의 transfer waypoint면 detect skip (useTransferTrainList가 책임)', () => {
    // findActiveTransferContext가 non-null을 반환하도록: 환승 route + 현재역이 환승 waypoint.
    // 간단 fixture: 충무로(3↔4) 환승 route.
    // stations.json 의존을 피하기 위해 lock+route 모두 fixture로 구성하되,
    // findActiveTransferContext는 resolveAllTargets를 거치므로 실 route 사용.
    const onAutoLock = jest.fn();
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4' }),
    ]);
    // TransferRoute 실 shape. resolveAllTargets는 transferName/destinationName으로 매칭.
    const route = {
      type: 'transfer' as const,
      transferName: '충무로',
      fromLine: '3' as const,
      toLine: '4' as const,
      stopsToTransfer: 1,
      stopsFromTransfer: 2,
      secondsToTransfer: 60,
      secondsFromTransfer: 120,
    };
    const chungmuro3: Station = { id: '0330', name: '충무로', line: '3', lineColor: '#EF7C1C', lat: 37.561, lng: 126.994 };
    const nearestChungmuro: NearestStationsResult = {
      primary: chungmuro3,
      variants: [chungmuro3],
      distanceKm: 0.03,
      isTransfer: true,
    };
    renderHook(() =>
      useTransferAutoDetect(
        baseInputs({
          nearestStations: nearestChungmuro,
          arrival,
          boardingLock: makeLock({ boardingLine: '3', boardingStationId: chungmuro3.id }),
          route,
          destinationName: '서울역',
          onAutoLock,
        }),
      ),
    );
    expect(onAutoLock).not.toHaveBeenCalled();
  });

  it('variants에 candidate line 없음 → 모달 후보 0 (selectLine 호출해도 no-op)', () => {
    const onAutoLock = jest.fn();
    const arrival = multiCandidateArrival();
    // variants에 4호선만 있고 5호선 없음 — 5호선은 modalCandidates에서 제외.
    const partialNearest: NearestStationsResult = {
      primary: DDP_2,
      variants: [DDP_2, DDP_4], // 5호선 없음
      distanceKm: 0.03,
      isTransfer: true,
    };
    const { result } = renderHook(() =>
      useTransferAutoDetect(baseInputs({ nearestStations: partialNearest, arrival, onAutoLock })),
    );
    expect(result.current.candidateLines).toEqual(['4', '5']);
    expect(result.current.modalCandidates.map((s) => s.line)).toEqual(['4']);
  });

  it('selectLine — arrival이 사라진 뒤 호출되면 trainCode pick 실패로 no-op', () => {
    const onAutoLock = jest.fn();
    const arrival = multiCandidateArrival();
    const { result, rerender } = renderTransferDetect(baseInputs({ arrival, onAutoLock }));
    // arrival null로 전환 — modalVisible은 close 효과 effect로 false 가지만 selectLine 콜백은 유효.
    rerender(baseInputs({ arrival: null, onAutoLock }));
    onAutoLock.mockClear();
    act(() => result.current.selectLine('4'));
    expect(onAutoLock).not.toHaveBeenCalled();
  });

  /**
   * #1637 — 환승역 line selection 모달 반복 표시 회귀 가드.
   *
   * Evidence: 2026-06-22 14:01:55 합정 환승역(2호선/6호선) 스크린샷 — 사용자 선택 후에도
   * 매 GPS cycle 모달 반복. root cause: stationKey = currentStation.id는 line별로 분리되어
   * fusion이 같은 환승역의 다른 line variant를 primary로 채택하면 stationKey 변경 →
   * dismissedAtStationRef reset → 모달 재오픈. fix: stationKey를 normalize(name)으로 변경.
   *
   * 부수 fix: selectLine arrival race(candidate=null) 시에도 dismiss flag stamp.
   */
  describe('#1637 환승역 dismiss 보존', () => {
    // 합정 — 2호선/6호선 환승역. line별 id 분리 fixture.
    const HAPJEONG_2: Station = { id: '0238', name: '합정', line: '2', lineColor: '#009D3E', lat: 37.549, lng: 126.913 };
    const HAPJEONG_6: Station = { id: '0622', name: '합정', line: '6', lineColor: '#CD7C2F', lat: 37.549, lng: 126.913 };
    const hapjeongNearestLine2: NearestStationsResult = {
      primary: HAPJEONG_2,
      variants: [HAPJEONG_2, HAPJEONG_6],
      distanceKm: 0.03,
      isTransfer: true,
    };
    const hapjeongNearestLine6: NearestStationsResult = {
      primary: HAPJEONG_6,
      variants: [HAPJEONG_2, HAPJEONG_6],
      distanceKm: 0.03,
      isTransfer: true,
    };
    /** 2호선 60s + 6호선 90s 두 줄 임박. */
    function hapjeongMultiArrival(): StationArrival {
      return makeArrival([
        makeArrivalInfo({ destination: '잠실', arrivalSeconds: 60, line: '2', trainCode: 'T-2-A' }),
        makeArrivalInfo({ destination: '봉화산', arrivalSeconds: 90, line: '6', trainCode: 'T-6-A' }),
      ]);
    }

    it('Case A: 환승역 line variant 변경 시 dismiss 보존 (line=2 dismiss → line=6 primary 채택 → 모달 재오픈 X)', () => {
      const onAutoLock = jest.fn();
      const arrival = hapjeongMultiArrival();
      // 2호선 primary로 시작 → 다중 후보 모달 open
      const { result, rerender } = renderTransferDetect(
        baseInputs({ nearestStations: hapjeongNearestLine2, arrival, onAutoLock }),
      );
      expect(result.current.modalVisible).toBe(true);
      // 사용자 dismiss
      act(() => result.current.dismissModal());
      expect(result.current.modalVisible).toBe(false);
      // 다음 GPS cycle: fusion이 6호선 variant를 primary로 채택 — id가 '0238' → '0622'로 변경.
      // station.name은 둘 다 '합정'이라 normalize 기반 stationKey는 보존되어야 한다.
      rerender(baseInputs({ nearestStations: hapjeongNearestLine6, arrival, onAutoLock }));
      expect(result.current.modalVisible).toBe(false);
    });

    it('Case B: selectLine early return (arrival race) 시에도 dismiss flag stamp', () => {
      const onAutoLock = jest.fn();
      const arrival = hapjeongMultiArrival();
      const { result, rerender } = renderTransferDetect(
        baseInputs({ nearestStations: hapjeongNearestLine2, arrival, onAutoLock }),
      );
      expect(result.current.modalVisible).toBe(true);
      // arrival을 단일-line-only로 갱신 — 사용자가 6호선 선택하지만 6호선 arrival이 사라진 race.
      // arrival에 line 6 train이 없어 buildAutoLockCandidate(6, ...) → null.
      const arrivalOnly2 = makeArrival([
        makeArrivalInfo({ destination: '잠실', arrivalSeconds: 60, line: '2', trainCode: 'T-2-A' }),
      ]);
      rerender(baseInputs({ nearestStations: hapjeongNearestLine2, arrival: arrivalOnly2, onAutoLock }));
      onAutoLock.mockClear();
      act(() => result.current.selectLine('6'));
      // candidate=null이라 onAutoLock은 호출 안 됨 (정상)
      expect(onAutoLock).not.toHaveBeenCalled();
      // 모달은 닫혀야 하고, 다음 polling에서도 재오픈 안 됨 — 사용자 선택 의도 보존.
      expect(result.current.modalVisible).toBe(false);
      rerender(baseInputs({ nearestStations: hapjeongNearestLine2, arrival: hapjeongMultiArrival(), onAutoLock }));
      expect(result.current.modalVisible).toBe(false);
    });

    it('Case C: 다른 환승역으로 이동 시는 모달 재오픈 (정상 동작 보존)', () => {
      const onAutoLock = jest.fn();
      const arrival = hapjeongMultiArrival();
      const { result, rerender } = renderTransferDetect(
        baseInputs({ nearestStations: hapjeongNearestLine2, arrival, onAutoLock }),
      );
      expect(result.current.modalVisible).toBe(true);
      act(() => result.current.dismissModal());
      expect(result.current.modalVisible).toBe(false);
      // 합정에서 dismiss 후 동대문역사문화공원(다른 환승역)으로 이동 → 다시 모달 open 가능
      rerender(baseInputs({ nearestStations: transferNearest, arrival: multiCandidateArrival(), onAutoLock }));
      expect(result.current.modalVisible).toBe(true);
    });
  });

  it('currentStation 없는 동안 selectLine 호출 — 안전 no-op', () => {
    const onAutoLock = jest.fn();
    const { result } = renderHook(() =>
      useTransferAutoDetect(baseInputs({ nearestStations: null, onAutoLock })),
    );
    act(() => result.current.selectLine('4'));
    expect(onAutoLock).not.toHaveBeenCalled();
  });

  it('환승역에서 GPS 끊김(stationKey → null) 후 dismiss 상태로 재진입해도 dismiss 리셋되어 모달 재오픈', () => {
    const onAutoLock = jest.fn();
    const arrival = multiCandidateArrival();
    const { result, rerender } = renderTransferDetect(baseInputs({ arrival, onAutoLock }));
    expect(result.current.modalVisible).toBe(true);
    act(() => result.current.dismissModal());
    expect(result.current.modalVisible).toBe(false);
    // GPS 끊김 — nearestStations null → stationKey null 전환으로 dismiss ref 리셋.
    rerender(baseInputs({ nearestStations: null, arrival, onAutoLock }));
    // 다시 같은 환승역 진입 — dismiss가 리셋되었으므로 모달 재오픈.
    rerender(baseInputs({ arrival, onAutoLock }));
    expect(result.current.modalVisible).toBe(true);
    expect(onAutoLock).not.toHaveBeenCalled();
  });

  it('단일 후보 — 같은 trainCode + 새 arrival object여도 무탭 onAutoLock 없음(모달만 유지)', () => {
    // 같은 station + 같은 trainCode이지만 arrival 객체 ref만 새로 → effect 재실행돼도 무탭 hydrate 없음.
    const onAutoLock = jest.fn();
    const makeArrivalA = () =>
      makeArrival([
        makeArrivalInfo({ destination: '서울역', arrivalSeconds: 60, line: '4', trainCode: 'T-4-A' }),
      ]);
    const { result, rerender } = renderTransferDetect(baseInputs({ arrival: makeArrivalA(), onAutoLock }));
    expect(onAutoLock).not.toHaveBeenCalled();
    // 새 arrival 객체(ref만 다름, 데이터 동일) → effect 재실행돼도 여전히 무탭 hydrate 없음.
    rerender(baseInputs({ arrival: makeArrivalA(), onAutoLock }));
    expect(onAutoLock).not.toHaveBeenCalled();
    expect(result.current.modalVisible).toBe(true);
  });

  // pickImminentTrainCode가 best replace(later→earlier) 분기와 skip(earlier→later) 분기를
  // 둘 다 타도록 두 순서를 it.each로 압축.
  it.each<{ label: string; ups: ArrivalInfo[] }>([
    {
      label: 'LATE-first → best replace 분기',
      ups: [
        makeArrivalInfo({ destination: '서울역', arrivalSeconds: 120, line: '4', trainCode: 'T-4-LATE' }),
        makeArrivalInfo({ destination: '서울역', arrivalSeconds: 30, line: '4', trainCode: 'T-4-EARLY' }),
      ],
    },
    {
      label: 'EARLY-first → best 유지(skip) 분기',
      ups: [
        makeArrivalInfo({ destination: '서울역', arrivalSeconds: 30, line: '4', trainCode: 'T-4-EARLY' }),
        makeArrivalInfo({ destination: '서울역', arrivalSeconds: 120, line: '4', trainCode: 'T-4-LATE' }),
      ],
    },
  ])('selectLine — 같은 line 다중 train: $label 에서 EARLY 선택', ({ ups }) => {
    const onAutoLock = jest.fn();
    const arrival = makeArrival(ups, [line5Arrival()]);
    const { result } = renderHook(() =>
      useTransferAutoDetect(baseInputs({ arrival, onAutoLock })),
    );
    act(() => result.current.selectLine('4'));
    expect(onAutoLock).toHaveBeenCalledWith({ trainCode: 'T-4-EARLY', line: '4', subwayId: '1004' });
  });

  it('selectLine — arrival에 해당 line train이 없어도 안전 no-op (best=null 분기)', () => {
    // multi 후보 detect로 모달 open된 상태에서, 새 polling으로 arrival에서 한 line이 사라진 뒤
    // 사용자가 사라진 line을 선택한 케이스. pickImminentTrainCode가 best=null → trainCode null.
    const onAutoLock = jest.fn();
    const arrivalMulti = multiCandidateArrival();
    const arrivalOnly5 = makeArrival([line5Arrival()]);
    const { result, rerender } = renderTransferDetect(baseInputs({ arrival: arrivalMulti, onAutoLock }));
    rerender(baseInputs({ arrival: arrivalOnly5, onAutoLock }));
    // 사용자가 사라진 line 4 선택 — pickImminentTrainCode에서 매칭 없음 → no-op.
    onAutoLock.mockClear();
    act(() => result.current.selectLine('4'));
    expect(onAutoLock).not.toHaveBeenCalled();
  });

  it('detect → 단일 후보로 hydrate된 후 candidates가 비면(arrival 사라짐) 모달 닫힘', () => {
    const onAutoLock = jest.fn();
    const { result, rerender } = renderTransferDetect(baseInputs({ arrival: multiCandidateArrival(), onAutoLock }));
    expect(result.current.modalVisible).toBe(true);
    // 다음 polling — 도착 데이터가 비면 후보 0 → 모달 close.
    rerender(baseInputs({ arrival: null, onAutoLock }));
    expect(result.current.modalVisible).toBe(false);
  });

  /**
   * #971 (#955 follow-up) — trainType priority.
   *
   * destinationName이 일반정차역 only(예: '대방')이면 express(서울역 등만 정차)를 통과
   * 사고로 lock하지 않고 normal을 선택해야 한다. 급행 정차역(예: '용산')이면 더 임박한
   * type을 정상 선택. destination=null은 기존 동작(전체 imminent) 유지. preferred 비면
   * fallback으로 hydrate. Matrix는 it.each로 압축(Sonar dup 회피).
   */
  describe('#971 trainType priority', () => {
    const SEOUL_1: Station = { id: '0101', name: '서울역', line: '1', lineColor: '#0052A4', lat: 37.554, lng: 126.972 };
    const SEOUL_4: Station = { id: '0426', name: '서울역', line: '4', lineColor: '#00A0E2', lat: 37.554, lng: 126.972 };
    const transferNearest1_4: NearestStationsResult = {
      primary: SEOUL_4,
      variants: [SEOUL_4, SEOUL_1],
      distanceKm: 0.03,
      isTransfer: true,
    };
    /** 1호선만 후보로 잡히도록 boardingLine=4호선으로 고정한 baseInputs 변형. */
    function inputs1Line(arrival: StationArrival, destinationName: string | null, onAutoLock: jest.Mock) {
      return baseInputs({
        nearestStations: transferNearest1_4,
        arrival,
        destinationName,
        boardingLock: makeLock({ boardingLine: '4', boardingStationId: SEOUL_4.id }),
        onAutoLock,
      });
    }
    const NORMAL_30 = makeArrivalInfo({ destination: '인천', arrivalSeconds: 30, line: '1', trainCode: 'T-1-NORMAL', trainType: 'normal' });
    const NORMAL_180 = makeArrivalInfo({ destination: '인천', arrivalSeconds: 180, line: '1', trainCode: 'T-1-NORMAL', trainType: 'normal' });
    const EXPRESS_60 = makeArrivalInfo({ destination: '동인천', arrivalSeconds: 60, line: '1', trainCode: 'T-1-EXPRESS', trainType: 'express' });
    const EXPRESS_120 = makeArrivalInfo({ destination: '동인천', arrivalSeconds: 120, line: '1', trainCode: 'T-1-EXPRESS', trainType: 'express' });

    it.each<{
      label: string;
      ups: ArrivalInfo[];
      destinationName: string | null;
      expectedTrainCode: string;
    }>([
      // destination=대방(일반정차역 only): express 통과 → normal 선택.
      { label: '일반정차역 only(대방) + 혼합 → normal', ups: [NORMAL_30, EXPRESS_120], destinationName: '대방', expectedTrainCode: 'T-1-NORMAL' },
      // destination=용산(급행 정차): normal·express 모두 preferred → imminent normal(30s).
      { label: '급행 정차역(용산) + normal-faster → normal', ups: [NORMAL_30, EXPRESS_120], destinationName: '용산', expectedTrainCode: 'T-1-NORMAL' },
      // destination=용산 + express가 더 임박 → express 선택.
      { label: '급행 정차역(용산) + express-faster → express', ups: [NORMAL_180, EXPRESS_60], destinationName: '용산', expectedTrainCode: 'T-1-EXPRESS' },
      // destination=null(legacy): 모든 후보 동등 → imminent normal(30s).
      { label: 'destination=null → 기존 동작', ups: [NORMAL_30, EXPRESS_120], destinationName: null, expectedTrainCode: 'T-1-NORMAL' },
      // 일반정차역 only(대방) + express만 → preferred 비어 fallback으로 express(60s).
      { label: '일반정차역 only(대방) + express only → fallback', ups: [EXPRESS_60], destinationName: '대방', expectedTrainCode: 'T-1-EXPRESS' },
    ])('$label', ({ ups, destinationName, expectedTrainCode }) => {
      const onAutoLock = jest.fn();
      const { result } = renderHook(() =>
        useTransferAutoDetect(inputs1Line(makeArrival(ups), destinationName, onAutoLock)),
      );
      // #2342 — 단일 후보도 무탭 hydrate 없음. 모달 탭(selectLine)으로만 trainType 우선순위 적용.
      expect(onAutoLock).not.toHaveBeenCalled();
      act(() => result.current.selectLine('1'));
      expect(onAutoLock).toHaveBeenCalledWith({ trainCode: expectedTrainCode, line: '1', subwayId: '1001' });
    });

    it('selectLine 경로도 동일한 trainType 우선순위 적용 (다중 후보 모달에서 선택)', () => {
      // 1호선·5호선 다중 후보 — 사용자가 1호선 선택 시 destination(대방)에 맞춰 normal 선택.
      const onAutoLock = jest.fn();
      const DDP_1: Station = { id: '0145', name: '동대문', line: '1', lineColor: '#0052A4', lat: 37.571, lng: 127.009 };
      const DDP_2: Station = { id: '0205-2', name: '동대문', line: '2', lineColor: '#009D3E', lat: 37.571, lng: 127.009 };
      const DDP_5_X: Station = { id: '0505-X', name: '동대문', line: '5', lineColor: '#996CAC', lat: 37.571, lng: 127.009 };
      const nearest: NearestStationsResult = { primary: DDP_2, variants: [DDP_2, DDP_1, DDP_5_X], distanceKm: 0.03, isTransfer: true };
      const arrival = makeArrival([
        NORMAL_30,
        EXPRESS_60,
        makeArrivalInfo({ destination: '왕십리', arrivalSeconds: 90, line: '5', trainCode: 'T-5', trainType: 'normal' }),
      ]);
      const { result } = renderTransferDetect(
        baseInputs({
          nearestStations: nearest,
          arrival,
          destinationName: '대방',
          boardingLock: makeLock({ boardingLine: '2', boardingStationId: DDP_2.id }),
          onAutoLock,
        }),
      );
      expect(result.current.candidateLines).toEqual(['1', '5']);
      act(() => result.current.selectLine('1'));
      expect(onAutoLock).toHaveBeenCalledWith({ trainCode: 'T-1-NORMAL', line: '1', subwayId: '1001' });
    });
  });
});
