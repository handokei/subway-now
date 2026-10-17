// factory.test.ts
// jest.mock은 호이스팅되므로 top-level에서 선언한 mock 변수를 통해 호출 여부를 추적한다.

const mockBffConstructor = jest.fn();
const mockSeoulConstructor = jest.fn();
const mockCompositeConstructor = jest.fn();
const mockCreateKorail = jest.fn();

jest.mock('../BffArrivalProvider', () => ({
  BffArrivalProvider: mockBffConstructor,
}));

jest.mock('../SeoulOpenApiProvider', () => ({
  SeoulOpenApiProvider: mockSeoulConstructor,
}));

jest.mock('../CompositeArrivalProvider', () => ({
  CompositeArrivalProvider: mockCompositeConstructor,
}));

jest.mock('../KorailArrivalProvider', () => ({
  createKorailArrivalProvider: mockCreateKorail,
  KorailArrivalProvider: jest.fn(),
}));

// factory는 각 테스트마다 환경변수를 바꾼 뒤 동적으로 require해야 하므로
// 미리 import하지 않는다.

describe('createArrivalProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    mockBffConstructor.mockClear();
    mockSeoulConstructor.mockClear();
    mockCompositeConstructor.mockClear();
    mockCreateKorail.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should instantiate BffArrivalProvider when EXPO_PUBLIC_USE_BFF=true and EXPO_PUBLIC_BFF_URL is set', () => {
    process.env.EXPO_PUBLIC_USE_BFF = 'true';
    process.env.EXPO_PUBLIC_BFF_URL = 'https://bff.example.com';

    const { createArrivalProvider } = require('../factory');
    createArrivalProvider();

    expect(mockBffConstructor).toHaveBeenCalledWith('https://bff.example.com');
    expect(mockSeoulConstructor).not.toHaveBeenCalled();
  });

  it('should instantiate SeoulOpenApiProvider when EXPO_PUBLIC_USE_BFF is "false"', () => {
    process.env.EXPO_PUBLIC_USE_BFF = 'false';
    process.env.EXPO_PUBLIC_BFF_URL = 'https://bff.example.com';

    const { createArrivalProvider } = require('../factory');
    createArrivalProvider();

    expect(mockSeoulConstructor).toHaveBeenCalled();
    expect(mockBffConstructor).not.toHaveBeenCalled();
  });

  it('should instantiate SeoulOpenApiProvider when EXPO_PUBLIC_BFF_URL is not set', () => {
    process.env.EXPO_PUBLIC_USE_BFF = 'true';
    delete process.env.EXPO_PUBLIC_BFF_URL;

    const { createArrivalProvider } = require('../factory');
    createArrivalProvider();

    expect(mockSeoulConstructor).toHaveBeenCalled();
    expect(mockBffConstructor).not.toHaveBeenCalled();
  });

  it('should instantiate SeoulOpenApiProvider when both env vars are not set', () => {
    delete process.env.EXPO_PUBLIC_USE_BFF;
    delete process.env.EXPO_PUBLIC_BFF_URL;

    const { createArrivalProvider } = require('../factory');
    createArrivalProvider();

    expect(mockSeoulConstructor).toHaveBeenCalled();
    expect(mockBffConstructor).not.toHaveBeenCalled();
  });

  it('should instantiate SeoulOpenApiProvider when EXPO_PUBLIC_USE_BFF is "1" (not exactly "true")', () => {
    process.env.EXPO_PUBLIC_USE_BFF = '1';
    process.env.EXPO_PUBLIC_BFF_URL = 'https://bff.example.com';

    const { createArrivalProvider } = require('../factory');
    createArrivalProvider();

    expect(mockSeoulConstructor).toHaveBeenCalled();
    expect(mockBffConstructor).not.toHaveBeenCalled();
  });

  it('EXPO_PUBLIC_USE_KORAIL_FALLBACK=true 시 Composite로 wrap (#1096)', () => {
    process.env.EXPO_PUBLIC_USE_KORAIL_FALLBACK = 'true';
    delete process.env.EXPO_PUBLIC_USE_BFF;
    const fakeKorail = { isAvailable: false };
    mockCreateKorail.mockReturnValue(fakeKorail);

    const { createArrivalProvider } = require('../factory');
    createArrivalProvider();

    expect(mockCreateKorail).toHaveBeenCalled();
    expect(mockCompositeConstructor).toHaveBeenCalledTimes(1);
    expect(mockSeoulConstructor).toHaveBeenCalled();
  });

  it('EXPO_PUBLIC_USE_KORAIL_FALLBACK=true + BFF 활성 시 BFF를 fallback으로 wrap', () => {
    process.env.EXPO_PUBLIC_USE_KORAIL_FALLBACK = 'true';
    process.env.EXPO_PUBLIC_USE_BFF = 'true';
    process.env.EXPO_PUBLIC_BFF_URL = 'https://bff.example.com';
    mockCreateKorail.mockReturnValue({ isAvailable: false });

    const { createArrivalProvider } = require('../factory');
    createArrivalProvider();

    expect(mockBffConstructor).toHaveBeenCalledWith('https://bff.example.com');
    expect(mockCompositeConstructor).toHaveBeenCalledTimes(1);
    expect(mockSeoulConstructor).not.toHaveBeenCalled();
  });

  it('EXPO_PUBLIC_USE_KORAIL_FALLBACK 미설정 시 Composite 미사용', () => {
    delete process.env.EXPO_PUBLIC_USE_KORAIL_FALLBACK;

    const { createArrivalProvider } = require('../factory');
    createArrivalProvider();

    expect(mockCompositeConstructor).not.toHaveBeenCalled();
    expect(mockCreateKorail).not.toHaveBeenCalled();
  });
});

describe('features/arrival/providers/index re-exports', () => {
  it('should export SeoulOpenApiProvider, BffArrivalProvider, MockArrivalProvider, KorailArrivalProvider, CompositeArrivalProvider', () => {
    const arrivalIndex = require('../index');
    expect(arrivalIndex.SeoulOpenApiProvider).toBeDefined();
    expect(arrivalIndex.BffArrivalProvider).toBeDefined();
    expect(arrivalIndex.MockArrivalProvider).toBeDefined();
    expect(arrivalIndex.KorailArrivalProvider).toBeDefined();
    expect(arrivalIndex.createKorailArrivalProvider).toBeDefined();
    expect(arrivalIndex.CompositeArrivalProvider).toBeDefined();
  });
});
