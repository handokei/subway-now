import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  incrementBgDiagnostic,
  getBgDiagnostics,
  clearBgDiagnostics,
} from '../bgDiagnostics';
import { BG_DIAGNOSTICS_KEY } from '../../constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

jest.mock('../logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('bgDiagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
  });

  describe('getBgDiagnostics', () => {
    it('저장된 값이 없으면 모두 0 인 기본 스냅샷을 돌려준다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      const result = await getBgDiagnostics();

      expect(result).toEqual({
        taskFired: 0,
        pipelineEnter: 0,
        pipelineExitNoDestination: 0,
        gateAge: 0,
        gateAccuracy: 0,
        alarmEnter: 0,
        alarmPermDenied: 0,
        stationPassedEnter: 0,
        lastTaskFiredTs: null,
      });
    });

    it('저장값이 있으면 그대로 돌려준다', async () => {
      const stored = {
        taskFired: 3,
        pipelineEnter: 2,
        pipelineExitNoDestination: 0,
        gateAge: 1,
        gateAccuracy: 0,
        alarmEnter: 0,
        alarmPermDenied: 0,
        stationPassedEnter: 0,
        lastTaskFiredTs: 1_700_000_000_000,
      };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(stored));

      const result = await getBgDiagnostics();

      expect(result).toEqual(stored);
    });

    it('JSON 파싱 실패 시 기본 스냅샷을 돌려준다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('!!!not-json');

      const result = await getBgDiagnostics();

      expect(result.taskFired).toBe(0);
      expect(result.lastTaskFiredTs).toBeNull();
    });
  });

  describe('incrementBgDiagnostic', () => {
    it('카운터를 1 증가시켜 저장한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      incrementBgDiagnostic('pipelineEnter');
      await flushPromises();

      const [, payload] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(payload).pipelineEnter).toBe(1);
    });

    it('stampTaskFired 옵션 시 lastTaskFiredTs를 갱신한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      const fixedNow = 1_700_000_001_234;
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      incrementBgDiagnostic('taskFired', { stampTaskFired: true });
      await flushPromises();

      const [key, payload] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(key).toBe(BG_DIAGNOSTICS_KEY);
      const parsed = JSON.parse(payload);
      expect(parsed.taskFired).toBe(1);
      expect(parsed.lastTaskFiredTs).toBe(fixedNow);
    });

    it('읽기 실패 시 swallow 한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      (AsyncStorage.setItem as jest.Mock).mockResolvedValueOnce(undefined);

      incrementBgDiagnostic('alarmEnter');
      await flushPromises();

      // getBgDiagnostics 내부 catch가 기본 스냅샷을 돌려주므로 setItem은 호출됨
      expect(AsyncStorage.setItem).toHaveBeenCalled();
    });

    it('setItem 실패도 swallow 한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));

      incrementBgDiagnostic('gateAge');
      await flushPromises();

      // 예외가 호출자에게 전파되지 않아야 함
      expect(AsyncStorage.setItem).toHaveBeenCalled();
    });
  });

  describe('직렬화 (race 방지)', () => {
    it('연속 호출이 직렬화되어 카운터가 누락되지 않는다', async () => {
      // 두 번 연속 호출. 첫 번째 getItem은 null, 두 번째 getItem은 첫 호출의 setItem 결과를 반환해야 함.
      let stored: string | null = null;
      (AsyncStorage.getItem as jest.Mock).mockImplementation(() => Promise.resolve(stored));
      (AsyncStorage.setItem as jest.Mock).mockImplementation((_key: string, value: string) => {
        stored = value;
        return Promise.resolve();
      });

      incrementBgDiagnostic('taskFired');
      incrementBgDiagnostic('taskFired');
      await flushPromises();
      await flushPromises();
      await flushPromises();

      const finalParsed = JSON.parse(stored ?? '{}');
      expect(finalParsed.taskFired).toBe(2);
    });
  });

  describe('clearBgDiagnostics', () => {
    it('AsyncStorage에서 키를 제거한다', async () => {
      await clearBgDiagnostics();

      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(BG_DIAGNOSTICS_KEY);
    });

    it('removeItem 실패도 swallow 한다', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('nope'));

      await expect(clearBgDiagnostics()).resolves.toBeUndefined();
    });
  });
});
