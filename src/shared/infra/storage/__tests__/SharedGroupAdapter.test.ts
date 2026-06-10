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
    it('iOS에서 station 정보와 m 단위 거리, savedAt을 native 함수에 전달한다', async () => {
      await adapter.saveStation('강남', '#009933', 0.123, 1_700_000_000_000);
      expect(mockSave).toHaveBeenCalledWith('강남', '#009933', 123, 1_700_000_000_000);
    });

    it('savedAt 인자를 생략하면 Date.now()로 호출한다', async () => {
      const before = Date.now();
      await adapter.saveStation('강남', '#009933', 0.1);
      const after = Date.now();
      const args = mockSave.mock.calls[0];
      expect(args[3]).toBeGreaterThanOrEqual(before);
      expect(args[3]).toBeLessThanOrEqual(after);
    });

    it('음수 거리는 0으로 보정된다', async () => {
      await adapter.saveStation('강남', '#009933', -0.5, 1);
      expect(mockSave).toHaveBeenCalledWith('강남', '#009933', 0, 1);
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
