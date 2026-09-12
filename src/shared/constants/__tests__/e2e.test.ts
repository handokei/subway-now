describe('constants/e2e', () => {
  const originalEnv = process.env.EXPO_PUBLIC_E2E_MOCK;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EXPO_PUBLIC_E2E_MOCK;
    } else {
      process.env.EXPO_PUBLIC_E2E_MOCK = originalEnv;
    }
    jest.resetModules();
  });

  it('EXPO_PUBLIC_E2E_MOCK이 "true"가 아닐 때 IS_E2E_MOCK은 false', () => {
    delete process.env.EXPO_PUBLIC_E2E_MOCK;
    jest.isolateModules(() => {
      const { IS_E2E_MOCK } = require('../e2e');
      expect(IS_E2E_MOCK).toBe(false);
    });
  });

  it('EXPO_PUBLIC_E2E_MOCK="true" 일 때 IS_E2E_MOCK은 true', () => {
    process.env.EXPO_PUBLIC_E2E_MOCK = 'true';
    jest.isolateModules(() => {
      const { IS_E2E_MOCK } = require('../e2e');
      expect(IS_E2E_MOCK).toBe(true);
    });
  });

  it('E2E_MOCK_LOCATION이 강남역 좌표', () => {
    jest.isolateModules(() => {
      const { E2E_MOCK_LOCATION } = require('../e2e');
      expect(E2E_MOCK_LOCATION).toEqual({
        latitude: 37.49799,
        longitude: 127.027912,
        accuracyMeters: 10,
        speedMps: 0,
      });
    });
  });

  it('mock 비활성 시 E2E_MOCK_SENTINEL은 비활성 문자열', () => {
    delete process.env.EXPO_PUBLIC_E2E_MOCK;
    jest.isolateModules(() => {
      const { E2E_MOCK_SENTINEL } = require('../e2e');
      expect(E2E_MOCK_SENTINEL).toBe('__E2E_MOCK_INACTIVE__');
    });
  });

  it('mock 활성 시 E2E_MOCK_SENTINEL은 활성 문자열', () => {
    process.env.EXPO_PUBLIC_E2E_MOCK = 'true';
    jest.isolateModules(() => {
      const { E2E_MOCK_SENTINEL } = require('../e2e');
      expect(E2E_MOCK_SENTINEL).toBe('__E2E_MOCK_ACTIVE_v1__');
    });
  });
});
