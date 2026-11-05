import { createFakeLocationAdapter } from '../FakeLocationAdapter';

describe('FakeLocationAdapter', () => {
  it('기본 fix는 서울시청 좌표', async () => {
    const fake = createFakeLocationAdapter();
    const fix = await fake.getCurrentPosition();
    expect(fix.latitude).toBeCloseTo(37.566, 3);
    expect(fix.longitude).toBeCloseTo(126.977, 3);
    expect(fix.accuracy).toBe(10);
    expect(fix.speed).toBe(0);
  });

  it('options.initial으로 초기 좌표 오버라이드', async () => {
    const fake = createFakeLocationAdapter({
      initial: { latitude: 35.1, longitude: 129.0, accuracy: 5 },
    });
    const fix = await fake.getCurrentPosition();
    expect(fix.latitude).toBe(35.1);
    expect(fix.longitude).toBe(129.0);
    expect(fix.accuracy).toBe(5);
  });

  it('setPosition으로 측정값 갈아끼우기', async () => {
    const fake = createFakeLocationAdapter();
    fake.setPosition({ latitude: 36.0, longitude: 128.0, speed: 8 });
    const fix = await fake.getCurrentPosition();
    expect(fix.latitude).toBe(36.0);
    expect(fix.longitude).toBe(128.0);
    expect(fix.speed).toBe(8);
  });

  it('options.permissions 기본값은 granted=true', async () => {
    const fake = createFakeLocationAdapter();
    const perm = await fake.requestForegroundPermissions();
    expect(perm).toEqual({ granted: true, background: false });
  });

  it('options.permissions로 권한 응답 오버라이드', async () => {
    const fake = createFakeLocationAdapter({
      permissions: { granted: false, background: false },
    });
    const perm = await fake.requestForegroundPermissions();
    expect(perm).toEqual({ granted: false, background: false });
  });
});
