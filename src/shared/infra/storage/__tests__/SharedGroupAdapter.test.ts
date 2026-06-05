import { Platform } from 'react-native';
import { SharedGroupAdapter } from '../SharedGroupAdapter';

const mockSave = jest.fn().mockResolvedValue(undefined);
const mockClear = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../../../modules/live-activity', () => ({
  saveWidgetStation: (...args: unknown[]) => mockSave(...args),
  clearWidgetStation: () => mockClear(),
}));

describe('SharedGroupAdapter', () => {
  let adapter: SharedGroupAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(Platform, 'OS', 'ios');
    adapter = new SharedGroupAdapter();
  });

  describe('saveStation', () => {
    it('iOS에서 station 정보와 m 단위 거리로 native 함수를 호출한다', async () => {
      await adapter.saveStation('강남', '#009933', 0.123);
      expect(mockSave).toHaveBeenCalledWith('강남', '#009933', 123);
    });

    it('음수 거리는 0으로 보정된다', async () => {
      await adapter.saveStation('강남', '#009933', -0.5);
      expect(mockSave).toHaveBeenCalledWith('강남', '#009933', 0);
    });

    it('iOS가 아니면 native 호출 없이 종료된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await adapter.saveStation('강남', '#009933', 0.1);
      expect(mockSave).not.toHaveBeenCalled();
    });
  });

  describe('clearStation', () => {
    it('iOS에서 native clear를 호출한다', async () => {
      await adapter.clearStation();
      expect(mockClear).toHaveBeenCalled();
    });

    it('iOS가 아니면 native 호출 없이 종료된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await adapter.clearStation();
      expect(mockClear).not.toHaveBeenCalled();
    });
  });
});
