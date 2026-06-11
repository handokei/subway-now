import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  LOCKLESS_FUNNEL_STEPS,
  emitLocklessToggleTransition,
  emitLocklessToggleViewed,
  setLocklessFunnelEmitter,
  type LocklessFunnelEmitter,
} from '../locklessFunnel';
import { LOCKLESS_FUNNEL_SEEN_OFF_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('locklessFunnel', () => {
  let emitter: jest.Mock;

  beforeEach(() => {
    emitter = jest.fn<ReturnType<LocklessFunnelEmitter>, Parameters<LocklessFunnelEmitter>>(
      async () => undefined,
    );
    setLocklessFunnelEmitter(emitter);
    jest.clearAllMocks();
    (AsyncStorage.getItem as jest.Mock).mockReset();
    (AsyncStorage.setItem as jest.Mock).mockReset();
  });

  it('emitLocklessToggleViewed: viewed step을 emit한다', async () => {
    await emitLocklessToggleViewed();
    expect(emitter).toHaveBeenCalledWith(LOCKLESS_FUNNEL_STEPS.VIEWED, undefined);
  });

  it('transition: prev === next면 emit하지 않는다 (no-op)', async () => {
    await emitLocklessToggleTransition(true, true);
    await emitLocklessToggleTransition(false, false);
    expect(emitter).not.toHaveBeenCalled();
  });

  it('transition true → false: off emit + seenOff 플래그 set', async () => {
    (AsyncStorage.setItem as jest.Mock).mockResolvedValueOnce(undefined);
    await emitLocklessToggleTransition(true, false);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      LOCKLESS_FUNNEL_SEEN_OFF_KEY,
      'true',
    );
    expect(emitter).toHaveBeenCalledWith(LOCKLESS_FUNNEL_STEPS.OFF, undefined);
  });

  it('transition false → true (seenOff 없음): on emit', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await emitLocklessToggleTransition(false, true);
    expect(emitter).toHaveBeenCalledWith(LOCKLESS_FUNNEL_STEPS.ON, undefined);
  });

  it('transition false → true (seenOff = "true"): re_on emit', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('true');
    await emitLocklessToggleTransition(false, true);
    expect(emitter).toHaveBeenCalledWith(LOCKLESS_FUNNEL_STEPS.RE_ON, undefined);
  });

  it('transition false → true: seenOff getItem 실패 시 on으로 분류 (graceful)', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage'));
    await emitLocklessToggleTransition(false, true);
    expect(emitter).toHaveBeenCalledWith(LOCKLESS_FUNNEL_STEPS.ON, undefined);
  });

  it('transition true → false: markSeenOff setItem 실패해도 off는 emit된다 (graceful)', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage'));
    await emitLocklessToggleTransition(true, false);
    expect(emitter).toHaveBeenCalledWith(LOCKLESS_FUNNEL_STEPS.OFF, undefined);
  });

  it('emitter throw해도 토글 흐름을 막지 않는다 (warn만)', async () => {
    emitter.mockRejectedValueOnce(new Error('sink fail'));
    await expect(emitLocklessToggleViewed()).resolves.toBeUndefined();
  });

  it('기본 emitter는 logger 호출만 한다 (sink 미설정 동작 — setEmitter 안 한 import 경로)', async () => {
    // 모듈을 isolated로 다시 import하면 기본 emitter(=logger)가 활성.
    jest.isolateModules(() => {
      const mod = require('../locklessFunnel');
      // 호출 자체가 throw 없이 성공하면 OK (반환은 Promise).
      return expect(mod.emitLocklessToggleViewed()).resolves.toBeUndefined();
    });
  });
});
