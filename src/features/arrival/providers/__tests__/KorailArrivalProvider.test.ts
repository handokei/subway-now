import {
  KorailArrivalProvider,
  createKorailArrivalProvider,
} from '../KorailArrivalProvider';

describe('KorailArrivalProvider', () => {
  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isAvailable', () => {
    it('API 키가 undefined면 false', () => {
      const provider = new KorailArrivalProvider(undefined);
      expect(provider.isAvailable).toBe(false);
    });

    it('API 키가 빈 문자열이면 false', () => {
      const provider = new KorailArrivalProvider('');
      expect(provider.isAvailable).toBe(false);
    });

    it('API 키가 설정되면 true', () => {
      const provider = new KorailArrivalProvider('test-key');
      expect(provider.isAvailable).toBe(true);
    });
  });

  describe('getArrival', () => {
    it('API 키가 없으면 null 반환 (graceful)', async () => {
      const provider = new KorailArrivalProvider(undefined);
      const result = await provider.getArrival('왕십리');
      expect(result).toBeNull();
    });

    it('API 키가 있어도 현 PoC stub 상태에서는 null 반환', async () => {
      const provider = new KorailArrivalProvider('test-key');
      const result = await provider.getArrival('왕십리', { lineHint: 'bundang' });
      expect(result).toBeNull();
    });
  });

  describe('createKorailArrivalProvider', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('환경변수 EXPO_PUBLIC_KORAIL_API_KEY를 사용해 인스턴스 생성', () => {
      process.env.EXPO_PUBLIC_KORAIL_API_KEY = 'env-key';
      // babel-preset-expo가 EXPO_PUBLIC_* 를 모듈 import 시점에 inline하므로
      // jest.resetModules() 후 dynamic require로 env-aware하게 로드.
      const { createKorailArrivalProvider: factory } = require('../KorailArrivalProvider');
      const provider = factory();
      expect(provider.isAvailable).toBe(true);
    });

    it('환경변수 미설정 시 isAvailable=false', () => {
      delete process.env.EXPO_PUBLIC_KORAIL_API_KEY;
      const { createKorailArrivalProvider: factory } = require('../KorailArrivalProvider');
      const provider = factory();
      expect(provider.isAvailable).toBe(false);
    });
  });
});
