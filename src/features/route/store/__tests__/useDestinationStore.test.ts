/* eslint-disable import/no-restricted-paths --
 * Cross-feature test: useDestinationStore 본체가 setDestination switch 분기에서
 * useAlarmEventStore의 alarmEvent/dismissSilence 메모리 mirror를 함께 클리어한다
 * (file-level disable 사용). 본 테스트도 같은 cross-feature 동작을 검증하므로 같은 import 필요.
 * ADR Phase 5 (#890) orchestration 컨벤션.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDestinationStore } from '../useDestinationStore';
import { useAlarmEventStore } from '../../../alarm/store/useAlarmEventStore';
import { Station } from '../../../../shared/types/station';
import { setTripStartedAt } from '../../../alarm/utils/tripStartStorage';
import { triggerTripEndRecall } from '../../../alarm/utils/triggerTripEndRecall';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// #919 — recall trigger / tripStart setter는 wiring 본 자체가 단위 검증 대상이라
// store 테스트에서는 호출 여부만 확인하면 충분. 실제 동작은 각 파일의 전용 테스트에서.
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  setTripStartedAt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../alarm/utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: jest.fn().mockResolvedValue({ uploaded: false }),
}));

const mockAddDomainBreadcrumb = jest.fn();
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: (...args: unknown[]) => mockAddDomainBreadcrumb(...args),
}));

const mockStation: Station = {
  id: '2-022',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127276,
};

const mockStation2: Station = {
  id: '2-021',
  name: '역삼',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.5006,
  lng: 127365,
};

describe('useDestinationStore', () => {
  beforeEach(async () => {
    // #1321 — setDestination chain은 tripTransitionQueue에 직렬화된다. 직전 테스트의 잔여
    // chain이 현재 테스트의 (clear된) mock으로 늦게 발사돼 카운트를 오염시키지 않도록 먼저 drain.
    await flushMicrotasks();
    useDestinationStore.setState({
      destination: null,
      recentDestinations: [],
      customOrigin: null,
      tripOrigin: null,
      routePreference: 'optimal',
    });
    useAlarmEventStore.setState({ alarmEvent: null, dismissSilence: null });
    jest.clearAllMocks();
    // jest.clearAllMocks가 mock implementations도 리셋 — #919 trigger/setTripStartedAt이
    // Promise를 반환하지 않으면 setDestination의 .then chain이 깨진다. 기본 impl 복구.
    (triggerTripEndRecall as jest.Mock).mockResolvedValue({ uploaded: false });
    (setTripStartedAt as jest.Mock).mockResolvedValue(undefined);
  });

  // ── destination ──

  it('초기 목적지는 null이다', () => {
    const { destination } = useDestinationStore.getState();
    expect(destination).toBeNull();
  });

  it('setDestination: 목적지를 설정하면 상태가 업데이트된다', () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);

    const { destination } = useDestinationStore.getState();
    expect(destination?.id).toBe('2-022');
  });

  it('setDestination: null을 설정하면 목적지가 초기화된다', () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    setDestination(null);

    const { destination } = useDestinationStore.getState();
    expect(destination).toBeNull();
  });

  // #1324 — 목적지 == customOrigin(store가 권위적으로 아는 출발역)이면 degenerate trip을
  // 만들지 않고 거부한다 (방향 null/빈 탑승목록 회귀 차단). breadcrumb로 관측 가능.
  it('setDestination(#1324): customOrigin과 같은 역을 목적지로 지정하면 거부하고 상태 불변', () => {
    const { setDestination, setCustomOrigin } = useDestinationStore.getState();
    setCustomOrigin(mockStation);
    jest.clearAllMocks();

    setDestination(mockStation);

    expect(useDestinationStore.getState().destination).toBeNull();
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
      'subway-now:destination',
      expect.anything(),
    );
    expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('trip', 'degenerate-destination-blocked', {
      station: '강남',
    });
  });

  it('setDestination(#1324): customOrigin과 다른 역은 정상 설정된다', () => {
    const { setDestination, setCustomOrigin } = useDestinationStore.getState();
    setCustomOrigin(mockStation);

    setDestination(mockStation2);

    expect(useDestinationStore.getState().destination?.id).toBe('2-021');
  });

  it('setDestination: 역 설정 시 AsyncStorage에 저장하고 null 시 삭제한다', async () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:destination',
      JSON.stringify(mockStation),
    );

    jest.clearAllMocks();
    (triggerTripEndRecall as jest.Mock).mockResolvedValue({ uploaded: false });
    (setTripStartedAt as jest.Mock).mockResolvedValue(undefined);
    setDestination(null);
    // #919 — trigger → cleanup이 then-chain이라 microtask flush 후 검증.
    await flushMicrotasks();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:destination');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:fired-alarms');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:route');
    // #700 — trip 종료 시 tripOrigin도 atomic하게 클리어
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:trip-origin');
  });

  it('setDestination(#702): 목적지 switch 시 부수 storage(customOrigin/lock/scheduled/active-trip) 자동 클리어', async () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    jest.clearAllMocks();
    (triggerTripEndRecall as jest.Mock).mockResolvedValue({ uploaded: false });
    (setTripStartedAt as jest.Mock).mockResolvedValue(undefined);

    // 다른 역으로 switch
    setDestination(mockStation2);
    // #919 — trigger → cleanup이 then-chain이라 microtask flush 후 검증.
    await flushMicrotasks();

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:custom-origin');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:boarding-lock');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:scheduled-notifications');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:active-trip');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:fired-alarms');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:route');
  });

  it('setDestination(#702): null로 클리어 시에도 부수 storage 자동 클리어', async () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    jest.clearAllMocks();
    (triggerTripEndRecall as jest.Mock).mockResolvedValue({ uploaded: false });
    (setTripStartedAt as jest.Mock).mockResolvedValue(undefined);

    setDestination(null);
    // #919 — trigger → cleanup이 then-chain이라 microtask flush 후 검증.
    await flushMicrotasks();

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:custom-origin');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:boarding-lock');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:scheduled-notifications');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:active-trip');
  });

  // clearFiredPushIds는 firedPushIds 모듈의 write queue를 통과 — microtask flush 후 검증.
  async function flushMicrotasks(): Promise<void> {
    // #919 — setDestination이 triggerTripEndRecall → runTripBoundCleanups → setTripStartedAt
    // 세 단계 then-chain을 돌리는데 cleanup 안에서 Promise.allSettled가 추가 microtask를 만든다.
    // #773 — purgeBoardingLockSchedulerQueue가 getScheduledNotificationIds + clearScheduledNotificationIds
    // (각각 AsyncStorage await 2회 포함)를 추가하므로 microtask depth가 더 깊다. 넉넉하게 flush.
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
  }

  // #799: switch와 null 두 경로가 동일한 trip-bound cleanup을 트리거하므로 it.each로 통합.
  it.each<[string, 'switch' | 'null']>([
    ['switch', 'switch'],
    ['null clear', 'null'],
  ])('setDestination(#799): %s 시 silent push/알람 trip-bound state 정리', async (_, transition) => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    jest.clearAllMocks();

    setDestination(transition === 'switch' ? mockStation2 : null);
    await flushMicrotasks();

    for (const key of [
      'subway-now:last-notified-station',
      'subway-now:last-fired-alarm-station-name',
      'subway-now:fired-push-ids',
      'subway-now:trip-train-code',
      'subway-now:alarm-event',
    ]) {
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(key);
    }
  });

  it('setDestination(#799): switch 시 alarmEvent 메모리 state도 null로 동기화', () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    useAlarmEventStore.getState().setAlarmEvent({ phaseId: 'early', type: 'destination', stationName: '시청' });
    expect(useAlarmEventStore.getState().alarmEvent).not.toBeNull();

    setDestination(mockStation2);

    expect(useAlarmEventStore.getState().alarmEvent).toBeNull();
  });

  it('setDestination(#702/#799): 같은 목적지 재설정 시에는 trip-bound storage 전부 유지', () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    jest.clearAllMocks();

    // 동일 station id 재설정 — switch 아님 → 모든 trip-bound cleanup 건너뜀.
    setDestination(mockStation);

    for (const key of [
      // #702 부수 storage
      'subway-now:custom-origin',
      'subway-now:boarding-lock',
      'subway-now:scheduled-notifications',
      'subway-now:active-trip',
      'subway-now:fired-alarms',
      'subway-now:route',
      // #799 silent push/알람 state
      'subway-now:last-notified-station',
      'subway-now:last-fired-alarm-station-name',
      'subway-now:fired-push-ids',
      'subway-now:trip-train-code',
      'subway-now:alarm-event',
    ]) {
      expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith(key);
    }
  });

  // #926 — destination 재설정 시 LA dismiss sentinel도 함께 reset되어 다음 silent push에서
  // LA가 다시 살아나야 한다. switch와 null 두 경로 모두 동일 cleanup을 트리거.
  it.each<[string, 'switch' | 'null']>([
    ['switch', 'switch'],
    ['null clear', 'null'],
  ])('setDestination(#926): %s 시 LA dismiss sentinel도 함께 클리어', async (_, transition) => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    jest.clearAllMocks();
    (triggerTripEndRecall as jest.Mock).mockResolvedValue({ uploaded: false });
    (setTripStartedAt as jest.Mock).mockResolvedValue(undefined);

    setDestination(transition === 'switch' ? mockStation2 : null);
    await flushMicrotasks();

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:la-dismissed-at');
  });

  it('setDestination(#926): 같은 목적지 재설정에서는 sentinel을 건드리지 않는다 — dismiss 의도 보존', () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    jest.clearAllMocks();

    // 같은 station 재설정 — switch 아님 → sentinel 보존(사용자 dismiss 의도가 더 강함).
    setDestination(mockStation);

    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith('subway-now:la-dismissed-at');
  });

  it('setDestination(#702): switch 시 customOrigin 메모리 state도 null로 동기화', () => {
    const { setDestination, setCustomOrigin } = useDestinationStore.getState();
    setDestination(mockStation);
    setCustomOrigin(mockStation2);
    expect(useDestinationStore.getState().customOrigin?.id).toBe('2-021');

    // #1324 — 새 목적지는 customOrigin(역삼)과 달라야 한다(같으면 degenerate로 거부됨).
    // switch 시 customOrigin이 클리어되는지 검증하려는 본 테스트 의도 유지.
    const mockStation3: Station = {
      id: '2-020',
      name: '선릉',
      line: '2',
      lineColor: '#009D3E',
      lat: 37.5045,
      lng: 127.0492,
    };
    setDestination(mockStation3);

    expect(useDestinationStore.getState().customOrigin).toBeNull();
  });

  it('setDestination(#702): loadDestination(hydration)은 부수 storage를 클리어하지 않는다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockStation));
    jest.clearAllMocks();

    const { loadDestination } = useDestinationStore.getState();
    await loadDestination();

    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(useDestinationStore.getState().destination?.id).toBe('2-022');
  });

  it('setDestination: AsyncStorage 실패 시에도 에러를 던지지 않는다', async () => {
    const setItemImpl = (AsyncStorage.setItem as jest.Mock).getMockImplementation();
    const removeItemImpl = (AsyncStorage.removeItem as jest.Mock).getMockImplementation();
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('저장 실패'));
    // setDestination(null) switch: DESTINATION + fired + route + customOrigin + lock + scheduled + active-trip + TRIP_ORIGIN = 8 removeItem
    for (let i = 0; i < 8; i++) {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('삭제 실패'));
    }

    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    // catch(noop)로 에러가 무시되므로 에러가 던져지지 않아야 한다
    await new Promise((r) => setTimeout(r, 0));

    setDestination(null);
    await new Promise((r) => setTimeout(r, 0));
    // 에러 없이 완료 — implementation 복원 (다른 테스트 영향 방지)
    (AsyncStorage.setItem as jest.Mock).mockImplementation(setItemImpl);
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(removeItemImpl);
  });

  it('setDestination(null): tripOrigin도 함께 클리어된다 (#700)', () => {
    // tripOrigin이 trip 도중 캡처된 상태에서 trip 종료 시 stale origin이 남으면
    // 다음 trip 시작 시 잘못된 route가 잠깐 노출된다.
    const { setDestination, setTripOrigin } = useDestinationStore.getState();
    setDestination(mockStation);
    setTripOrigin(mockStation2);
    expect(useDestinationStore.getState().tripOrigin?.id).toBe('2-021');
    setDestination(null);
    expect(useDestinationStore.getState().tripOrigin).toBeNull();
  });

  it('loadDestination: AsyncStorage에 저장된 목적지를 상태로 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockStation));

    const { loadDestination } = useDestinationStore.getState();
    await loadDestination();

    expect(AsyncStorage.getItem).toHaveBeenCalledWith('subway-now:destination');
    expect(useDestinationStore.getState().destination?.id).toBe('2-022');
  });

  it('loadDestination: 저장된 값이 없으면 destination이 null로 유지된다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadDestination } = useDestinationStore.getState();
    await loadDestination();

    expect(useDestinationStore.getState().destination).toBeNull();
  });

  it('loadDestination: AsyncStorage 실패 시 destination이 null로 유지된다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('읽기 실패'));

    const { loadDestination } = useDestinationStore.getState();
    await loadDestination();

    expect(useDestinationStore.getState().destination).toBeNull();
  });

  // ── recentDestinations (#1032) ──

  it('초기 recentDestinations는 빈 배열이다', () => {
    const { recentDestinations } = useDestinationStore.getState();
    expect(recentDestinations).toEqual([]);
  });

  it('addRecentDestination: 최근 선택이 맨 앞으로 추가된다', () => {
    const { addRecentDestination } = useDestinationStore.getState();
    addRecentDestination(mockStation);
    addRecentDestination(mockStation2);

    const { recentDestinations } = useDestinationStore.getState();
    expect(recentDestinations.map((s) => s.id)).toEqual(['2-021', '2-022']);
  });

  it('addRecentDestination: 동일 station id는 dedup되고 최신이 맨 앞으로 이동', () => {
    const { addRecentDestination } = useDestinationStore.getState();
    addRecentDestination(mockStation);
    addRecentDestination(mockStation2);
    addRecentDestination(mockStation); // 재선택

    const { recentDestinations } = useDestinationStore.getState();
    expect(recentDestinations.map((s) => s.id)).toEqual(['2-022', '2-021']);
  });

  it('addRecentDestination: 최대 3개로 제한된다 (LRU 잘림)', () => {
    const { addRecentDestination } = useDestinationStore.getState();
    const s3: Station = { ...mockStation, id: '2-020', name: '선릉' };
    const s4: Station = { ...mockStation, id: '2-019', name: '삼성' };
    addRecentDestination(mockStation);
    addRecentDestination(mockStation2);
    addRecentDestination(s3);
    addRecentDestination(s4);

    const { recentDestinations } = useDestinationStore.getState();
    expect(recentDestinations.map((s) => s.id)).toEqual(['2-019', '2-020', '2-021']);
  });

  it('addRecentDestination: AsyncStorage에 영속화한다', () => {
    const { addRecentDestination } = useDestinationStore.getState();
    addRecentDestination(mockStation);

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:recent-destinations',
      JSON.stringify([mockStation]),
    );
  });

  it('removeRecentDestination: 지정 id만 제거한다', () => {
    const { addRecentDestination, removeRecentDestination } = useDestinationStore.getState();
    addRecentDestination(mockStation);
    addRecentDestination(mockStation2);
    removeRecentDestination('2-022');

    const { recentDestinations } = useDestinationStore.getState();
    expect(recentDestinations.map((s) => s.id)).toEqual(['2-021']);
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
      'subway-now:recent-destinations',
      JSON.stringify([mockStation2]),
    );
  });

  it('removeRecentDestination: 마지막 항목 제거 시 AsyncStorage 키도 삭제', () => {
    const { addRecentDestination, removeRecentDestination } = useDestinationStore.getState();
    addRecentDestination(mockStation);
    removeRecentDestination('2-022');

    const { recentDestinations } = useDestinationStore.getState();
    expect(recentDestinations).toEqual([]);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:recent-destinations');
  });

  it('loadRecentDestinations: storage에서 hydrate되며 최대 3개로 자른다', async () => {
    const s3: Station = { ...mockStation, id: '2-020' };
    const s4: Station = { ...mockStation, id: '2-019' };
    await AsyncStorage.setItem(
      'subway-now:recent-destinations',
      JSON.stringify([mockStation, mockStation2, s3, s4]),
    );

    const { loadRecentDestinations } = useDestinationStore.getState();
    await loadRecentDestinations();

    const { recentDestinations } = useDestinationStore.getState();
    expect(recentDestinations.map((s) => s.id)).toEqual(['2-022', '2-021', '2-020']);
  });

  it('loadRecentDestinations: 키 부재 시 빈 배열을 유지한다', async () => {
    await AsyncStorage.removeItem('subway-now:recent-destinations');
    const { loadRecentDestinations } = useDestinationStore.getState();
    await loadRecentDestinations();

    expect(useDestinationStore.getState().recentDestinations).toEqual([]);
  });

  it('loadRecentDestinations: 비배열 JSON은 무시한다', async () => {
    await AsyncStorage.setItem('subway-now:recent-destinations', JSON.stringify({ bogus: true }));
    const { loadRecentDestinations } = useDestinationStore.getState();
    await loadRecentDestinations();

    expect(useDestinationStore.getState().recentDestinations).toEqual([]);
  });

  it('loadRecentDestinations: 손상된 JSON에서 graceful하게 빈 배열 유지', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('{not-json');
    const { loadRecentDestinations } = useDestinationStore.getState();
    await loadRecentDestinations();

    expect(useDestinationStore.getState().recentDestinations).toEqual([]);
  });

  // ── customOrigin ──

  it('초기 customOrigin은 null이다', () => {
    const { customOrigin } = useDestinationStore.getState();
    expect(customOrigin).toBeNull();
  });

  it('setCustomOrigin: 출발역을 설정하면 상태가 업데이트된다', () => {
    const { setCustomOrigin } = useDestinationStore.getState();
    setCustomOrigin(mockStation);

    const { customOrigin } = useDestinationStore.getState();
    expect(customOrigin?.id).toBe('2-022');
  });

  it('setCustomOrigin: null을 설정하면 출발역이 초기화된다', () => {
    const { setCustomOrigin } = useDestinationStore.getState();
    setCustomOrigin(mockStation);
    setCustomOrigin(null);

    const { customOrigin } = useDestinationStore.getState();
    expect(customOrigin).toBeNull();
  });

  it('setCustomOrigin: 역 설정 시 AsyncStorage에 저장하고 null 시 삭제한다', () => {
    const { setCustomOrigin } = useDestinationStore.getState();
    setCustomOrigin(mockStation);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:custom-origin',
      JSON.stringify(mockStation),
    );

    jest.clearAllMocks();
    setCustomOrigin(null);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:custom-origin');
  });

  it('setCustomOrigin: AsyncStorage 실패 시에도 에러를 던지지 않는다', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('저장 실패'));
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('삭제 실패'));

    const { setCustomOrigin } = useDestinationStore.getState();
    setCustomOrigin(mockStation);
    await new Promise((r) => setTimeout(r, 0));

    setCustomOrigin(null);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('loadCustomOrigin: AsyncStorage에서 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockStation));

    const { loadCustomOrigin } = useDestinationStore.getState();
    await loadCustomOrigin();

    const { customOrigin } = useDestinationStore.getState();
    expect(customOrigin?.id).toBe('2-022');
  });

  it('loadCustomOrigin: AsyncStorage가 비어있으면 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadCustomOrigin } = useDestinationStore.getState();
    await loadCustomOrigin();

    const { customOrigin } = useDestinationStore.getState();
    expect(customOrigin).toBeNull();
  });

  it('loadCustomOrigin: AsyncStorage 오류 시 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));

    const { loadCustomOrigin } = useDestinationStore.getState();
    await loadCustomOrigin();

    const { customOrigin } = useDestinationStore.getState();
    expect(customOrigin).toBeNull();
  });

  // ── #700 tripOrigin 영속화 ──

  it('초기 tripOrigin은 null이다', () => {
    const { tripOrigin } = useDestinationStore.getState();
    expect(tripOrigin).toBeNull();
  });

  it('setTripOrigin: 역을 설정하면 상태가 업데이트된다', () => {
    const { setTripOrigin } = useDestinationStore.getState();
    setTripOrigin(mockStation);

    const { tripOrigin } = useDestinationStore.getState();
    expect(tripOrigin?.id).toBe('2-022');
  });

  it('setTripOrigin: 역 설정 시 AsyncStorage에 저장하고 null 시 삭제한다', () => {
    const { setTripOrigin } = useDestinationStore.getState();
    setTripOrigin(mockStation);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:trip-origin',
      JSON.stringify(mockStation),
    );

    jest.clearAllMocks();
    setTripOrigin(null);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:trip-origin');
  });

  it('setTripOrigin: AsyncStorage 실패 시에도 에러를 던지지 않는다', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('저장 실패'));
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('삭제 실패'));

    const { setTripOrigin } = useDestinationStore.getState();
    setTripOrigin(mockStation);
    await new Promise((r) => setTimeout(r, 0));

    setTripOrigin(null);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('loadTripOrigin: AsyncStorage에서 영속화된 origin을 복원한다 (cold restart 회복)', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockStation));

    const { loadTripOrigin } = useDestinationStore.getState();
    await loadTripOrigin();

    expect(AsyncStorage.getItem).toHaveBeenCalledWith('subway-now:trip-origin');
    expect(useDestinationStore.getState().tripOrigin?.id).toBe('2-022');
  });

  it('loadTripOrigin: AsyncStorage가 비어있으면 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadTripOrigin } = useDestinationStore.getState();
    await loadTripOrigin();

    expect(useDestinationStore.getState().tripOrigin).toBeNull();
  });

  it('loadTripOrigin: AsyncStorage 오류 시 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));

    const { loadTripOrigin } = useDestinationStore.getState();
    await loadTripOrigin();

    expect(useDestinationStore.getState().tripOrigin).toBeNull();
  });

  // ── routePreference ──

  it('초기 routePreference는 optimal이다', () => {
    const { routePreference } = useDestinationStore.getState();
    expect(routePreference).toBe('optimal');
  });

  it('setRoutePreference: 상태를 업데이트한다', async () => {
    const { setRoutePreference } = useDestinationStore.getState();
    await setRoutePreference('minTransfer');
    expect(useDestinationStore.getState().routePreference).toBe('minTransfer');
  });

  it('setRoutePreference: AsyncStorage에 저장한다', async () => {
    const { setRoutePreference } = useDestinationStore.getState();
    await setRoutePreference('minTransfer');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:route-preference',
      JSON.stringify('minTransfer'),
    );
  });

  it('loadRoutePreference: AsyncStorage에서 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('minTransfer'));
    await useDestinationStore.getState().loadRoutePreference();
    expect(useDestinationStore.getState().routePreference).toBe('minTransfer');
  });

  it('loadRoutePreference: 유효하지 않은 값이면 optimal을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('invalid'));
    await useDestinationStore.getState().loadRoutePreference();
    expect(useDestinationStore.getState().routePreference).toBe('optimal');
  });

  it('loadRoutePreference: AsyncStorage가 비어있으면 optimal을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await useDestinationStore.getState().loadRoutePreference();
    expect(useDestinationStore.getState().routePreference).toBe('optimal');
  });

  it('loadRoutePreference: AsyncStorage 오류 시 optimal을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));
    await useDestinationStore.getState().loadRoutePreference();
    expect(useDestinationStore.getState().routePreference).toBe('optimal');
  });

  // ── setDestination cross-feature cleanup (alarmEvent + dismissSilence) ──

  it('setDestination 으로 새 destination 설정 시 dismissSilence는 즉시 클리어', async () => {
    await useAlarmEventStore.getState().setDismissSilence(1, { lat: 0, lng: 0 });
    expect(useAlarmEventStore.getState().dismissSilence).not.toBeNull();
    // 새 destination 진입 (switch).
    useDestinationStore.getState().setDestination(mockStation);
    expect(useAlarmEventStore.getState().dismissSilence).toBeNull();
  });

  it('setDestination: 같은 destination 재설정(isSwitch=false)이면 dismissSilence 유지', async () => {
    useDestinationStore.setState({ destination: mockStation });
    await useAlarmEventStore.getState().setDismissSilence(1, { lat: 0, lng: 0 });
    // 같은 destination 재설정 — storage clear 분기는 미실행.
    useDestinationStore.getState().setDestination(mockStation);
    expect(useAlarmEventStore.getState().dismissSilence).toEqual({
      sinceTs: 1,
      sinceLat: 0,
      sinceLng: 0,
    });
  });

  // ── #919 trip-end recall wiring ──

  it('setDestination(#919): switch 시 triggerTripEndRecall이 cleanup *이전*에 호출된다', async () => {
    // 호출 순서를 추적 — trigger가 cleanup *이전*이어야 ROUTE_KEY 등을 읽을 수 있다.
    const callOrder: string[] = [];
    (triggerTripEndRecall as jest.Mock).mockImplementation(async () => {
      callOrder.push('trigger');
      return { uploaded: false };
    });
    (setTripStartedAt as jest.Mock).mockImplementation(async () => {
      callOrder.push('setTripStartedAt');
    });
    // runTripBoundCleanups 자체를 spy 못 하므로 그 안에서 호출되는 removeItem 첫 트리거를 마커로 사용.
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
      if (!callOrder.includes('cleanup')) callOrder.push('cleanup');
      return undefined;
    });

    // 첫 destination — switch (prev=null → next=mockStation).
    useDestinationStore.getState().setDestination(mockStation);
    await flushMicrotasks();

    expect(callOrder).toEqual(['trigger', 'cleanup', 'setTripStartedAt']);
  });

  it('setDestination(#919): null로 종료 시 triggerTripEndRecall 호출, 단 새 tripStart 기록 안 함', async () => {
    useDestinationStore.setState({ destination: mockStation });
    const triggerMock = triggerTripEndRecall as jest.Mock;
    const setTripStartedAtMock = setTripStartedAt as jest.Mock;
    triggerMock.mockClear();
    setTripStartedAtMock.mockClear();

    useDestinationStore.getState().setDestination(null);
    await flushMicrotasks();

    expect(triggerMock).toHaveBeenCalledTimes(1);
    expect(setTripStartedAtMock).not.toHaveBeenCalled(); // trip 종료 — 새 tripStart 기록 없음
  });

  it('setDestination(#919): 같은 destination 재설정(isSwitch=false)이면 trigger/set 둘 다 호출 안 됨', async () => {
    useDestinationStore.setState({ destination: mockStation });
    const triggerMock = triggerTripEndRecall as jest.Mock;
    const setTripStartedAtMock = setTripStartedAt as jest.Mock;
    triggerMock.mockClear();
    setTripStartedAtMock.mockClear();

    useDestinationStore.getState().setDestination(mockStation);
    await flushMicrotasks();

    expect(triggerMock).not.toHaveBeenCalled();
    expect(setTripStartedAtMock).not.toHaveBeenCalled();
  });

  it('setDestination(#919): trigger가 reject해도 setDestination 흐름은 영향 없음 (graceful)', async () => {
    const triggerMock = triggerTripEndRecall as jest.Mock;
    triggerMock.mockRejectedValueOnce(new Error('trigger fail'));

    // throw가 노출되면 unhandled rejection으로 잡힐 것 — 노출 안 되어야 함.
    useDestinationStore.getState().setDestination(mockStation);
    await flushMicrotasks();
    expect(useDestinationStore.getState().destination?.id).toBe('2-022');
  });

  // ── #1321 delete→recreate race: cleanup 직렬화 ──

  it('setDestination(#1321): delete 직후 recreate 시 옛 cleanup이 끝난 뒤에야 새 tripStart 기록', async () => {
    // 시나리오: setDestination(null)(delete)로 옛 route cleanup이 in-flight인 동안
    // setDestination(mockStation2)(recreate)가 곧바로 들어온다. 직렬화가 없으면 recreate의
    // setTripStartedAt이 delete cleanup 도중에 실행돼 hook이 옛 알람과 interleave한 채 새
    // route를 preschedule → revalidate-route-sig-mismatch 폭주. 직렬화가 있으면 delete의
    // cleanup이 완전히 settle한 뒤에만 recreate cleanup + setTripStartedAt이 시작된다.
    useDestinationStore.setState({ destination: mockStation });

    const order: string[] = [];
    let triggerCount = 0;
    (triggerTripEndRecall as jest.Mock).mockImplementation(async () => {
      order.push(`trigger#${++triggerCount}`);
      return { uploaded: false };
    });
    (setTripStartedAt as jest.Mock).mockImplementation(async () => {
      order.push('setTripStartedAt');
    });
    // delete leg cleanup(첫 removeItem 진입)을 deferred로 묶어 interleave 창을 강제한다.
    let releaseDeleteCleanup: () => void = () => undefined;
    const deleteCleanupGate = new Promise<void>((resolve) => {
      releaseDeleteCleanup = resolve;
    });
    let removeItemCalls = 0;
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async () => {
      removeItemCalls += 1;
      // 첫 cleanup leg(delete)의 첫 removeItem만 gate에 묶고 마커 기록.
      if (removeItemCalls === 1) {
        order.push('delete-cleanup-start');
        await deleteCleanupGate;
        order.push('delete-cleanup-end');
      }
      return undefined;
    });

    // delete → recreate를 동기적으로 연달아 호출 (사용자가 빠르게 삭제+재생성).
    useDestinationStore.getState().setDestination(null);
    useDestinationStore.getState().setDestination(mockStation2);

    // delete cleanup이 gate에서 멈춘 상태로 microtask를 일부 흘려보낸다 — 직렬화가 없으면
    // 이 시점에 recreate의 setTripStartedAt이 이미 기록됐을 것.
    await flushMicrotasks();
    expect(order).not.toContain('setTripStartedAt');

    // delete cleanup 완료 → 큐가 recreate chain을 진행.
    releaseDeleteCleanup();
    await flushMicrotasks();

    // 직렬화 보장: delete cleanup이 끝난 뒤에야 recreate의 setTripStartedAt이 실행된다.
    const deleteEndIdx = order.indexOf('delete-cleanup-end');
    const setTripIdx = order.indexOf('setTripStartedAt');
    expect(deleteEndIdx).toBeGreaterThanOrEqual(0);
    expect(setTripIdx).toBeGreaterThan(deleteEndIdx);
    // recreate(2번째 transition)에서만 tripStart를 기록 (delete는 null이라 미기록).
    expect(order.filter((o) => o === 'setTripStartedAt')).toHaveLength(1);
  });

  describe('trip breadcrumb', () => {
    beforeEach(() => {
      mockAddDomainBreadcrumb.mockClear();
      useDestinationStore.setState({ destination: null });
    });

    it('새 destination 지정 시 trip/start breadcrumb', () => {
      useDestinationStore.getState().setDestination(mockStation);
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('trip', 'start', {
        destination: mockStation.name,
      });
    });

    it('destination=null 해제 시 trip/end breadcrumb', () => {
      useDestinationStore.setState({ destination: mockStation });
      useDestinationStore.getState().setDestination(null);
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('trip', 'end', {
        reason: 'user-clear',
      });
    });

    it('같은 destination 재설정은 noise 방지를 위해 breadcrumb 없음', () => {
      useDestinationStore.setState({ destination: mockStation });
      useDestinationStore.getState().setDestination(mockStation);
      expect(mockAddDomainBreadcrumb).not.toHaveBeenCalled();
    });
  });
});
