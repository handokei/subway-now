import {
  SIMPLE_ARRIVAL_ARCH_ENV_KEY,
  isSimpleArchEnabled,
  isSimpleArchEnvEnabled,
} from '../archFlag';

const ORIGINAL_ENV = process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
  } else {
    process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = ORIGINAL_ENV;
  }
});

describe('isSimpleArchEnvEnabled (#1982)', () => {
  it('true when env is exactly the string "true"', () => {
    process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
    expect(isSimpleArchEnvEnabled()).toBe(true);
  });

  it('false when env is undefined', () => {
    delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
    expect(isSimpleArchEnvEnabled()).toBe(false);
  });

  it.each(['false', 'True', 'TRUE', '1', ''])(
    'false for env value %j (오타 방어)',
    (value) => {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = value;
      expect(isSimpleArchEnvEnabled()).toBe(false);
    },
  );
});

describe('isSimpleArchEnabled (env OR remote, #1982)', () => {
  beforeEach(() => {
    delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
  });

  it('true when env=true and remote undefined (dogfood build)', () => {
    process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
    expect(isSimpleArchEnabled(undefined)).toBe(true);
  });

  it('true when env=false and remote=on (rollout stage)', () => {
    expect(isSimpleArchEnabled('on')).toBe(true);
  });

  it('true when both env=true and remote=on', () => {
    process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
    expect(isSimpleArchEnabled('on')).toBe(true);
  });

  it('false when both env=false and remote=off (dormant default)', () => {
    expect(isSimpleArchEnabled('off')).toBe(false);
  });

  it('false when both env=false and remote undefined', () => {
    expect(isSimpleArchEnabled(undefined)).toBe(false);
  });

  it('false without arg (remote 미조회) and env=false', () => {
    // caller 가 remote 를 조회하지 않는 코드 경로.
    expect(isSimpleArchEnabled()).toBe(false);
  });
});
