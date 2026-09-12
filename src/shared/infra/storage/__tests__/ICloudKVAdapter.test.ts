import { ICloudKVAdapter } from '../ICloudKVAdapter';

// icloud-kv 모듈 mock — PoC 단계에서 native 모듈 미구현이므로 fully mocked.
jest.mock('icloud-kv', () => ({
  isICloudAvailable: jest.fn(),
  getCloudItem: jest.fn(),
  setCloudItem: jest.fn(),
  removeCloudItem: jest.fn(),
}));

import {
  isICloudAvailable,
  getCloudItem,
  setCloudItem,
  removeCloudItem,
} from 'icloud-kv';

describe('ICloudKVAdapter', () => {
  let adapter: ICloudKVAdapter;

  beforeEach(() => {
    adapter = new ICloudKVAdapter();
    (isICloudAvailable as jest.Mock).mockReset();
    (getCloudItem as jest.Mock).mockReset();
    (setCloudItem as jest.Mock).mockReset();
    (removeCloudItem as jest.Mock).mockReset();
  });

  describe('iCloud 가용 시 (isICloudAvailable = true)', () => {
    beforeEach(() => {
      (isICloudAvailable as jest.Mock).mockReturnValue(true);
    });

    it('getItem은 getCloudItem 결과를 반환한다', async () => {
      (getCloudItem as jest.Mock).mockResolvedValue('stored-value');
      const result = await adapter.getItem('favorites-key');
      expect(getCloudItem).toHaveBeenCalledWith('favorites-key');
      expect(result).toBe('stored-value');
    });

    it('getItem은 키가 없으면 null을 반환한다', async () => {
      (getCloudItem as jest.Mock).mockResolvedValue(null);
      const result = await adapter.getItem('missing-key');
      expect(result).toBeNull();
    });

    it('setItem은 setCloudItem에 key/value를 전달한다', async () => {
      (setCloudItem as jest.Mock).mockResolvedValue(undefined);
      await adapter.setItem('favorites-key', '[]');
      expect(setCloudItem).toHaveBeenCalledWith('favorites-key', '[]');
    });

    it('removeItem은 removeCloudItem을 호출한다', async () => {
      (removeCloudItem as jest.Mock).mockResolvedValue(undefined);
      await adapter.removeItem('favorites-key');
      expect(removeCloudItem).toHaveBeenCalledWith('favorites-key');
    });
  });

  describe('iCloud 미가용 시 (isICloudAvailable = false)', () => {
    beforeEach(() => {
      (isICloudAvailable as jest.Mock).mockReturnValue(false);
    });

    it('getItem은 null을 반환하고 getCloudItem을 호출하지 않는다', async () => {
      const result = await adapter.getItem('any-key');
      expect(result).toBeNull();
      expect(getCloudItem).not.toHaveBeenCalled();
    });

    it('setItem은 no-op이고 setCloudItem을 호출하지 않는다', async () => {
      await adapter.setItem('any-key', 'any-value');
      expect(setCloudItem).not.toHaveBeenCalled();
    });

    it('removeItem은 no-op이고 removeCloudItem을 호출하지 않는다', async () => {
      await adapter.removeItem('any-key');
      expect(removeCloudItem).not.toHaveBeenCalled();
    });
  });
});
