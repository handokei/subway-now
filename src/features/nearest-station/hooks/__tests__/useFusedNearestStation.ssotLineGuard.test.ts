/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #2307 — backend-ssot mirror line guard.
 *
 * 2026-08-12 아침 검증 탑승 evidence: device position-train이 2호선(강남) 확정 중인데 backend
 * mirror가 7호선(용마산)으로 re-anchor → 기존 코드는 line 정합 검증 없이 mirror를 그대로 채택해
 * 헤더·리스트가 되감겼다. ADR-010 device self-contained 원칙 — device 라이브 확정 신호
 * (positionTrainResult, distance/arc/forward 게이트 통과)를 backend mirror가 되감을 수 없다.
 *
 * lockless(3-of-3 lock 합의 미충족)에서도 line-guard가 적용돼야 하므로, 본 파일은 lockless
 * 4-signal consensus(barometer/accelerometer/cellular)를 만족시켜 positionTrainResult를
 * non-null로 확보한 상태에서 검증한다 (`positionTrainConsensus.requiresPositionTrainConsensus`).
 */

jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../alarm/utils/backendSsotMirror', () => ({
  readBackendSsotMirror: jest.fn(),
}));
// lockless 4-signal consensus 충족 — positionTrainResult가 line-guard 검증을 위해 non-null이어야 함.
jest.mock('../useAccelerometerFingerprint', () => ({
  useAccelerometerFingerprint: () => 'automotive',
}));
jest.mock('../useCellularTech', () => ({
  useCellularTech: () => 'surface',
}));

import { renderHook, waitFor } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import {
  arrivalRet,
  positionRet,
  makeTrain as train,
  GPS_BASE_DEFAULTS,
} from '../../../../testUtils/positionApiFixtures';
import {
  BACKEND_SSOT_FIXTURE_T0 as T0,
  flushBackendSsotMirrorTick,
  makeBackendSsotMirrorEntry,
} from '../../../../testUtils/backendSsotMirrorFixtures';
import { readBackendSsotMirror } from '../../../alarm/utils/backendSsotMirror';
import { getFusionDebugEntries, clearFusionDebugEntries } from '../../utils/fusionDebugBuffer';
import { useLegAdvanceStore } from '../../../alarm/store/useLegAdvanceStore';

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;
const mockRead = readBackendSsotMirror as jest.Mock;

const yongmasan = findStationByNameAndLine('용마산', '7')!;
const chungdam = findStationByNameAndLine('청담', '7')!;
const gangnam2 = findStationByNameAndLine('강남', '2')!;

const TRAIN_CODE = 'T-2307';

function setupPositionTrainAt(station: typeof gangnam2, line: '2' | '7') {
  const live = { station, distanceKm: 0 };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [station],
    userLocation: { lat: station.lat, lng: station.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: 14,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station, distanceKm: 0 }]);
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(
    positionRet({ line, trains: [train(station.name, TRAIN_STATUS.ARRIVED, { trainNo: TRAIN_CODE })] }),
  );
}

describe('#2307 backend-ssot line guard — device 확정 노선과 mirror line 불일치 시 채택 거부', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    clearFusionDebugEntries();
    useLegAdvanceStore.setState({ nextLine: null, stampedAt: null });
  });

  afterEach(() => {
    jest.useRealTimers();
    useLegAdvanceStore.setState({ nextLine: null, stampedAt: null });
  });

  it('DebugModal Fusion log 채널로 ssot-line-guard-reject entry가 push된다 (dedup: 지속 mismatch는 1건만)', async () => {
    setupPositionTrainAt(gangnam2, '2');
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: yongmasan.name }));
    const hook = renderHook(() => useFusedNearestStation());
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).not.toBe('backend-ssot');
    });
    const entries = getFusionDebugEntries().filter((e) => e.kind === 'ssot-line-guard-reject');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'ssot-line-guard-reject',
      deviceStationName: gangnam2.name,
      deviceLine: '2',
      mirrorStationName: yongmasan.name,
      mirrorLine: '7',
    });

    // 다음 mirror read cycle에서도 동일 mismatch가 지속되면 재적재하지 않는다 (dedup).
    mockRead.mockResolvedValue(
      makeBackendSsotMirrorEntry({ currentStationId: yongmasan.name, receivedAt: T0 + 5_000 }),
    );
    await flushBackendSsotMirrorTick();
    const entriesAfter = getFusionDebugEntries().filter((e) => e.kind === 'ssot-line-guard-reject');
    expect(entriesAfter).toHaveLength(1);
  });

  it('device position-train이 2호선(강남) 확정 + mirror가 7호선(용마산) 주입 → line2 유지 (mirror 거부)', async () => {
    setupPositionTrainAt(gangnam2, '2');
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: yongmasan.name }));
    // lockless — boardingLock/lockedTrainCode 없음. 3-of-3 lock 합의(#1646) 경로가 아니라
    // 순수 line-guard만으로 거부되는지 검증.
    const hook = renderHook(() => useFusedNearestStation());
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).not.toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.line).toBe('2');
    expect(hook.result.current.result?.station.id).not.toBe(yongmasan.id);
    expect(hook.result.current.ssotLineGuardRejectCount).toBeGreaterThan(0);
  });

  it('device position-train과 mirror가 같은 line(7)이면 station 달라도 기존대로 mirror 채택 (회귀 방지)', async () => {
    // line-guard는 line 불일치만 거부한다. 같은 line 내 station 오버라이드(backend가 더 앞선
    // station을 안다고 판단하는 기존 동작)는 보존.
    setupPositionTrainAt(yongmasan, '7');
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: chungdam.name }));
    const hook = renderHook(() => useFusedNearestStation());
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.id).toBe(chungdam.id);
    expect(hook.result.current.ssotLineGuardRejectCount).toBe(0);
  });

  // #2387 — approachLine(legAdvance) 기반 추가 가드 3케이스. arrange(positionTrainResult=null
  // 강제 + legAdvance stamp + mirror 주입)와 act(renderHook+flush)가 동일 패턴이라 it.each로
  // 축약(SonarCloud dup 회피) — 거부/채택 두 분기(approach.confirmed true+mismatch / true+match /
  // false)는 파라미터로 그대로 보존해 커버리지 100% 유지.
  it.each([
    {
      name: 'legAdvanceLine=2(환승 하차 응답 확인) + mirror=7호선(용마산, stuck) → approachLine 가드로 거부',
      positionStation: gangnam2,
      positionLine: '2' as const,
      legAdvanceLine: '2' as const,
      mirrorStationId: yongmasan.name,
      mirrorAccepted: false,
      expectedStationId: undefined as string | undefined,
    },
    {
      name: 'legAdvanceLine=7(아직 환승 전) + mirror=7호선(청담) → line 일치, 기존대로 mirror 채택 (무오탐)',
      positionStation: yongmasan,
      positionLine: '7' as const,
      legAdvanceLine: '7' as const,
      mirrorStationId: chungdam.name,
      mirrorAccepted: true,
      expectedStationId: chungdam.id,
    },
    {
      name: 'route/legAdvance 둘 다 없음(approach.confirmed=false) → 기존대로 mirror 채택 (잔여 엣지, 정직 인정)',
      positionStation: gangnam2,
      positionLine: '2' as const,
      legAdvanceLine: null,
      mirrorStationId: yongmasan.name,
      mirrorAccepted: true,
      expectedStationId: yongmasan.id,
    },
  ])(
    '#2387 positionTrainResult 없음 + $name',
    async ({ positionStation, positionLine, legAdvanceLine, mirrorStationId, mirrorAccepted, expectedStationId }) => {
      setupPositionTrainAt(positionStation, positionLine);
      // train 없음 → candidateTrains 비어 positionTrainResult=null.
      mockPos.mockReturnValue(positionRet(null));
      useLegAdvanceStore.setState({ nextLine: legAdvanceLine, stampedAt: legAdvanceLine ? T0 : null });
      mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: mirrorStationId }));
      const hook = renderHook(() => useFusedNearestStation());
      await flushBackendSsotMirrorTick();

      if (mirrorAccepted) {
        await waitFor(() => {
          expect(hook.result.current.source).toBe('backend-ssot');
        });
        expect(hook.result.current.result?.station.id).toBe(expectedStationId);
        expect(hook.result.current.ssotLineGuardRejectCount).toBe(0);
      } else {
        await waitFor(() => {
          expect(hook.result.current.source).not.toBe('backend-ssot');
        });
        expect(hook.result.current.ssotLineGuardRejectCount).toBeGreaterThan(0);
      }
    },
  );
});
