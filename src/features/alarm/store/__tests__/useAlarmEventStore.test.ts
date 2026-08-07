/* eslint-disable import/no-restricted-paths --
 * #2210 — useAlarmEventStore.ts와 동일한 orchestration 사유. 테스트가 게이트 조건(sleepMode,
 * destination)을 직접 세팅하려면 해당 sibling store를 import해야 한다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAlarmEventStore } from '../useAlarmEventStore';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import { useDestinationStore } from '../../../route/store/useDestinationStore';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('useAlarmEventStore', () => {
  beforeEach(() => {
    useAlarmEventStore.setState({ alarmEvent: null, dismissSilence: null });
    // #2210 — setAlarmEvent 게이트가 참조하는 cross-feature 상태를 매 테스트 기본값으로 리셋.
    useSettingsStore.setState({ sleepMode: false });
    useDestinationStore.setState({ destination: null });
    jest.clearAllMocks();
  });

  // ── alarmEvent ──

  it('초기 alarmEvent는 null이다', () => {
    expect(useAlarmEventStore.getState().alarmEvent).toBeNull();
  });

  it('setAlarmEvent: 활성 trip 중(destination 존재)이면 알람 이벤트를 설정한다', () => {
    useDestinationStore.setState({ destination: MOCK_STATIONS.gangnam });
    const { setAlarmEvent } = useAlarmEventStore.getState();
    setAlarmEvent({ phaseId: 'early', type: 'destination', stationName: '강남' });

    const { alarmEvent } = useAlarmEventStore.getState();
    expect(alarmEvent).toEqual({ phaseId: 'early', type: 'destination', stationName: '강남' });
  });

  it('setAlarmEvent: sleepMode=true면 trip 종료 상태여도 알람 이벤트를 설정한다', () => {
    useSettingsStore.setState({ sleepMode: true });
    const { setAlarmEvent } = useAlarmEventStore.getState();
    setAlarmEvent({ phaseId: 'early', type: 'destination', stationName: '강남' });

    const { alarmEvent } = useAlarmEventStore.getState();
    expect(alarmEvent).toEqual({ phaseId: 'early', type: 'destination', stationName: '강남' });
  });

  // #2210 (증상③) — 비취침 + trip 종료 상태의 stale 알람 replay 억제. red: 게이트 추가 전에는
  // sleepMode=false, destination=null 기본 상태에서도 alarmEvent가 그대로 설정돼 FG 복귀 시
  // overlay가 떴다.
  it('setAlarmEvent: 비취침 + trip 종료(destination=null) 상태면 알람 이벤트를 억제한다', () => {
    const { setAlarmEvent } = useAlarmEventStore.getState();
    setAlarmEvent({ phaseId: 'early', type: 'destination', stationName: '강남' });

    expect(useAlarmEventStore.getState().alarmEvent).toBeNull();
  });

  it('clearAlarmEvent: 알람 이벤트를 초기화하고 AsyncStorage도 정리한다', () => {
    useDestinationStore.setState({ destination: MOCK_STATIONS.gangnam });
    const { setAlarmEvent, clearAlarmEvent } = useAlarmEventStore.getState();
    setAlarmEvent({ phaseId: 'early', type: 'transfer', stationName: '역삼' });
    clearAlarmEvent();

    const { alarmEvent } = useAlarmEventStore.getState();
    expect(alarmEvent).toBeNull();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:alarm-event');
  });

  it('clearAlarmEvent: AsyncStorage 실패 시에도 에러를 던지지 않는다(noop swallow)', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('삭제 실패'));
    useAlarmEventStore.getState().clearAlarmEvent();
    // catch(noop)가 reject를 흡수 — microtask flush 후 에러 없이 통과
    await new Promise((r) => setTimeout(r, 0));
    expect(useAlarmEventStore.getState().alarmEvent).toBeNull();
  });

  it('loadAlarmEvent: 활성 trip 중이면 AsyncStorage에서 알람 이벤트를 복원하고 제거한다', async () => {
    useDestinationStore.setState({ destination: MOCK_STATIONS.gangnam });
    const event = { phaseId: 'early' as const, type: 'destination' as const, stationName: '강남' };
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(event));

    const { loadAlarmEvent } = useAlarmEventStore.getState();
    await loadAlarmEvent();

    const { alarmEvent } = useAlarmEventStore.getState();
    expect(alarmEvent).toEqual(event);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:alarm-event');
  });

  // #2210 — BG write(backgroundLocationTask)가 sleepMode 무관하게 남긴 stale ALARM_EVENT_KEY를
  // FG loadAlarmEvent가 replay하는 경로. 비취침 + trip 종료 상태면 in-memory alarmEvent는
  // 억제되지만, storage는 무조건 drain해 재차 replay되지 않는다.
  it('loadAlarmEvent: 비취침 + trip 종료 상태면 알람 이벤트는 억제하되 storage는 drain한다', async () => {
    const event = { phaseId: 'early' as const, type: 'destination' as const, stationName: '강남' };
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(event));

    const { loadAlarmEvent } = useAlarmEventStore.getState();
    await loadAlarmEvent();

    expect(useAlarmEventStore.getState().alarmEvent).toBeNull();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:alarm-event');
  });

  it('loadAlarmEvent: AsyncStorage가 비어있으면 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadAlarmEvent } = useAlarmEventStore.getState();
    await loadAlarmEvent();

    expect(useAlarmEventStore.getState().alarmEvent).toBeNull();
  });

  it('loadAlarmEvent: AsyncStorage 오류 시 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));

    const { loadAlarmEvent } = useAlarmEventStore.getState();
    await loadAlarmEvent();

    expect(useAlarmEventStore.getState().alarmEvent).toBeNull();
  });

  // ── #746 dismissSilence ──

  it('초기 dismissSilence는 null', () => {
    expect(useAlarmEventStore.getState().dismissSilence).toBeNull();
  });

  it('setDismissSilence: timestamp + 좌표 함께 메모리와 storage에 기록', async () => {
    await useAlarmEventStore.getState().setDismissSilence(1_700_000_000_000, { lat: 37.5, lng: 127 });
    expect(useAlarmEventStore.getState().dismissSilence).toEqual({
      sinceTs: 1_700_000_000_000,
      sinceLat: 37.5,
      sinceLng: 127,
    });
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:dismiss-silence',
      JSON.stringify({
        sinceTs: 1_700_000_000_000,
        sinceLat: 37.5,
        sinceLng: 127,
      }),
    );
  });

  it('setDismissSilence: 좌표 null이면 sinceLat/sinceLng 모두 null로 저장', async () => {
    await useAlarmEventStore.getState().setDismissSilence(42, null);
    expect(useAlarmEventStore.getState().dismissSilence).toEqual({
      sinceTs: 42,
      sinceLat: null,
      sinceLng: null,
    });
  });

  it('clearDismissSilence: 메모리와 storage 모두 비운다', async () => {
    await useAlarmEventStore.getState().setDismissSilence(42, { lat: 0, lng: 0 });
    await useAlarmEventStore.getState().clearDismissSilence();
    expect(useAlarmEventStore.getState().dismissSilence).toBeNull();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:dismiss-silence');
  });

  it('clearDismissSilence: 이미 null이어도 storage clear는 호출(재진입 안전)', async () => {
    await useAlarmEventStore.getState().clearDismissSilence();
    expect(useAlarmEventStore.getState().dismissSilence).toBeNull();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:dismiss-silence');
  });

  it('loadDismissSilence: storage에서 hydrate', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
      JSON.stringify({ sinceTs: 99, sinceLat: 1, sinceLng: 2 }),
    );
    await useAlarmEventStore.getState().loadDismissSilence();
    expect(useAlarmEventStore.getState().dismissSilence).toEqual({
      sinceTs: 99,
      sinceLat: 1,
      sinceLng: 2,
    });
  });
});
