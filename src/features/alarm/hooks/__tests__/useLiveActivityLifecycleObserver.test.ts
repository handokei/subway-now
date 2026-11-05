import { renderHook } from '@testing-library/react-native';

const mockAddEndObservedListener = jest.fn();
const mockAddAdoptedListener = jest.fn();
const mockLogLifecycle = jest.fn();

jest.mock('../../../../../modules/live-activity', () => ({
  addActivityEndObservedListener: (...args: unknown[]) => mockAddEndObservedListener(...args),
  addActivityAdoptedListener: (...args: unknown[]) => mockAddAdoptedListener(...args),
}));

jest.mock('../../utils/alarmLog', () => ({
  logLiveActivityLifecycle: (...args: unknown[]) => mockLogLifecycle(...args),
}));

import { useLiveActivityLifecycleObserver } from '../useLiveActivityLifecycleObserver';

describe('useLiveActivityLifecycleObserver (#3107)', () => {
  let endObserved: ((e: unknown) => void) | null;
  let adopted: ((e: unknown) => void) | null;
  const endRemove = jest.fn();
  const adoptRemove = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    endObserved = null;
    adopted = null;
    mockAddEndObservedListener.mockImplementation((cb: (e: unknown) => void) => {
      endObserved = cb;
      return { remove: endRemove };
    });
    mockAddAdoptedListener.mockImplementation((cb: (e: unknown) => void) => {
      adopted = cb;
      return { remove: adoptRemove };
    });
  });

  it('end 관측 -> la-end-observed에 state/expected/id/observedAt을 싣는다', () => {
    renderHook(() => useLiveActivityLifecycleObserver());
    endObserved!({
      state: 'dismissed',
      expectingSystemEnd: false,
      activityId: 'ab12cd34',
      observedAt: 1792000000000,
    });
    expect(mockLogLifecycle).toHaveBeenCalledWith(
      'la-end-observed',
      'state=dismissed;expected=false;id=ab12cd34;at=1792000000000',
    );
  });

  it('expectingSystemEnd=true(.ended)도 구분되어 적재된다', () => {
    renderHook(() => useLiveActivityLifecycleObserver());
    endObserved!({
      state: 'ended',
      expectingSystemEnd: true,
      activityId: 'ff00ee11',
      observedAt: 5,
    });
    expect(mockLogLifecycle).toHaveBeenCalledWith(
      'la-end-observed',
      'state=ended;expected=true;id=ff00ee11;at=5',
    );
  });

  it.each([
    [true, 'hasPushToken=true'],
    [false, 'hasPushToken=false'],
  ])('adopt 관측(hasPushToken=%s) -> la-adopt-token-state', (hasPushToken, expectedPart) => {
    renderHook(() => useLiveActivityLifecycleObserver());
    adopted!({ activityId: 'ab12cd34', state: 'active', hasPushToken });
    expect(mockLogLifecycle).toHaveBeenCalledWith(
      'la-adopt-token-state',
      `id=ab12cd34;state=active;${expectedPart}`,
    );
  });

  it('unmount 시 두 구독 모두 remove', () => {
    const { unmount } = renderHook(() => useLiveActivityLifecycleObserver());
    unmount();
    expect(endRemove).toHaveBeenCalledTimes(1);
    expect(adoptRemove).toHaveBeenCalledTimes(1);
  });
});
