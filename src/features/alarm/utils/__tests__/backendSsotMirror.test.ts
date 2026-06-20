/**
 * #1573 (T10) — clearBackendSsotMirror unit test.
 *
 * persist/read는 silentPushTask.test.ts에서 검증. 본 파일은 T10 신규 helper인
 * clearBackendSsotMirror만 다루어 회귀 좌표를 좁힌다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearBackendSsotMirror } from '../backendSsotMirror';
import { BACKEND_SSOT_MIRROR_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    removeItem: jest.fn(),
  },
}));

const mockRemoveItem = AsyncStorage.removeItem as jest.Mock;

describe('clearBackendSsotMirror (#1573 T10)', () => {
  beforeEach(() => {
    mockRemoveItem.mockReset();
  });

  it('BACKEND_SSOT_MIRROR_KEY를 제거한다', async () => {
    mockRemoveItem.mockResolvedValue(undefined);
    await clearBackendSsotMirror();
    expect(mockRemoveItem).toHaveBeenCalledWith(BACKEND_SSOT_MIRROR_KEY);
  });

  it('AsyncStorage 실패 시 graceful (throw 안 함)', async () => {
    mockRemoveItem.mockRejectedValue(new Error('io'));
    await expect(clearBackendSsotMirror()).resolves.toBeUndefined();
  });
});
