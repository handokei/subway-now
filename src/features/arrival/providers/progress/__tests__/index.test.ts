import { createBffProgressProvider, SeoulBffProgressProvider, MockBffProgressProvider } from '..';

describe('createBffProgressProvider', () => {
  const ORIGINAL_USE_BFF = process.env.EXPO_PUBLIC_USE_BFF;
  const ORIGINAL_BFF_URL = process.env.EXPO_PUBLIC_BFF_URL;

  afterEach(() => {
    if (ORIGINAL_USE_BFF === undefined) {
      delete process.env.EXPO_PUBLIC_USE_BFF;
    } else {
      process.env.EXPO_PUBLIC_USE_BFF = ORIGINAL_USE_BFF;
    }
    if (ORIGINAL_BFF_URL === undefined) {
      delete process.env.EXPO_PUBLIC_BFF_URL;
    } else {
      process.env.EXPO_PUBLIC_BFF_URL = ORIGINAL_BFF_URL;
    }
  });

  it('EXPO_PUBLIC_USE_BFF=true이고 BFF_URL이 있으면 SeoulBffProgressProvider를 반환한다', () => {
    process.env.EXPO_PUBLIC_USE_BFF = 'true';
    process.env.EXPO_PUBLIC_BFF_URL = 'https://bff.example.com';

    expect(createBffProgressProvider()).toBeInstanceOf(SeoulBffProgressProvider);
  });

  it('EXPO_PUBLIC_USE_BFF=false면 MockBffProgressProvider를 반환한다', () => {
    process.env.EXPO_PUBLIC_USE_BFF = 'false';
    process.env.EXPO_PUBLIC_BFF_URL = 'https://bff.example.com';

    expect(createBffProgressProvider()).toBeInstanceOf(MockBffProgressProvider);
  });

  it('BFF_URL이 없으면 MockBffProgressProvider를 반환한다', () => {
    process.env.EXPO_PUBLIC_USE_BFF = 'true';
    delete process.env.EXPO_PUBLIC_BFF_URL;

    expect(createBffProgressProvider()).toBeInstanceOf(MockBffProgressProvider);
  });
});
