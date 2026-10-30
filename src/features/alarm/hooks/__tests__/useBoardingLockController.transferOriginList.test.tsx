// #2696 (우산) — 환승역 origin 목록 방향은 GPS/fused 현재역의 노선이 아니라 여정의 현재 leg 노선 기준.
// replay: 2026-10-28 17:18 건대입구(성수→건대입구→용마산 trip 180). fused 현재역이 2호선 엔트리(2-012)로
// 왕복(2↔7)하는 동안 7호선 목록(arrival은 approachLine=7 기준)이 공란("도착 예정 열차가 없습니다")이었다.
// tripDirection / stationLookup은 mock하지 않는다(실데이터) — 방향 판정 사슬 전체가 대상.
import { renderHook } from '@testing-library/react-native';
import { useBoardingLockController } from '../useBoardingLockController';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import { useLegAdvanceStore } from '../../store/useLegAdvanceStore';
import { findRoute, getStationById } from '../../../../shared/utils/stationRoute';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';
import type { Station } from '../../../../shared/types/station';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning', Error: 'Error' },
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/boardingLockStorage', () => ({
  getBoardingLock: jest.fn().mockResolvedValue(null),
  setBoardingLock: jest.fn().mockResolvedValue(undefined),
  clearBoardingLock: jest.fn().mockResolvedValue(undefined),
}));

function station(id: string): Station {
  const s = getStationById(id);
  if (!s) throw new Error(`station not found: ${id}`);
  return s;
}

function train(overrides: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: '장암',
    stopsAway: null,
    arrivalSeconds: 180,
    statusMessage: '',
    trainCode: 'T',
    line: '7',
    receivedAtMs: 0,
    arrivalCode: 99,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

// 17:18 서버 실측: 7호선 상행(장암 방면) 7250·7252 존재. 하행(부평구청 방면) 7261은 제외되어야 한다.
const up7250 = train({ trainCode: '7250', terminalStation: '장암', arrivalSeconds: 120 });
const up7252 = train({ trainCode: '7252', terminalStation: '장암', arrivalSeconds: 420 });
const down7261 = train({ trainCode: '7261', terminalStation: '부평구청', destination: '부평구청', arrivalSeconds: 90 });
const arrival7: StationArrival = { up: [up7250, up7252], down: [down7261] };

const DEST = station('7-015'); // 용마산
const route = findRoute('2-011', DEST.id); // 성수 → (건대입구) → 용마산

function run(currentStation: Station | null, approachLine?: '2' | '7' | null, arrival: StationArrival = arrival7) {
  return renderHook(() =>
    useBoardingLockController({
      destinationId: DEST.id,
      destinationName: DEST.name,
      route,
      arrival,
      currentStation,
      approachLine,
      expectedDurationMinutes: 20,
    }),
  );
}

describe('환승역 origin 목록 방향 — 여정 leg 노선 기준 (#2696 / #2590 형제 경로)', () => {
  beforeEach(() => {
    useBoardingLockStore.setState({ lock: null });
    useLegAdvanceStore.setState({ nextLine: null, stampedAt: null });
  });

  it('baseline: 현재역이 이미 7호선 엔트리(7-019)면 7250·7252만 (하행 제외)', () => {
    const { result } = run(station('7-019'));
    expect(result.current.boardingListArrivals.map((t) => t.trainCode)).toEqual(['7250', '7252']);
  });

  it('replay 17:18: fused 현재역이 2호선 엔트리(2-012)여도 approachLine=7이면 7250·7252 표시, 반대 방향(7261) 제외', () => {
    const { result } = run(station('2-012'), '7');
    expect(result.current.boardingListArrivals.map((t) => t.trainCode)).toEqual(['7250', '7252']);
  });

  it('approachLine이 현재역 노선과 같으면 기존 동작 그대로', () => {
    const { result } = run(station('7-019'), '7');
    expect(result.current.boardingListArrivals.map((t) => t.trainCode)).toEqual(['7250', '7252']);
  });

  it('거부: leg 방향 미해결(현재역=목적지 용마산 7호선) → 공란 유지(#3029 양방향 병합 금지)', () => {
    const { result } = run(station('7-015'), '7');
    expect(result.current.boardingListArrivals).toEqual([]);
  });

  it('거부: 현재역 없음(currentStation=null)이면 앵커를 만들지 않고 공란', () => {
    const { result } = run(null, '7');
    expect(result.current.boardingListArrivals).toEqual([]);
  });

  it('거부: approachLine 노선에 같은 이름 역이 없으면 앵커 보정 없이 currentStation 판정(여기선 목적지 위 -> 공란)', () => {
    // 용마산은 7호선 전용 — 2호선 앵커를 만들 수 없어 currentStation(7-015) 그대로 → currIdx===nextIdx → null.
    const { result } = run(station('7-015'), '2');
    expect(result.current.boardingListArrivals).toEqual([]);
  });
});
