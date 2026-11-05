import { TtlCache } from '../ttlCache';

describe('TtlCache', () => {
  let now: number;

  beforeEach(() => {
    now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('TTL 이내 get → 값 반환', () => {
    const cache = new TtlCache<string, number>(100);
    cache.set('a', 42);

    now = 1050; // 50ms 경과 (TTL 100ms 이내)
    expect(cache.get('a')).toBe(42);
  });

  it('TTL 초과 get → undefined 반환 및 엔트리 삭제', () => {
    const cache = new TtlCache<string, number>(100);
    cache.set('a', 42);

    now = 1100; // 100ms 경과 (TTL 도달)
    expect(cache.get('a')).toBeUndefined();

    // 삭제 확인: TTL 되돌려도 없음
    now = 1000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('존재하지 않는 키 get → undefined', () => {
    const cache = new TtlCache<string, number>(100);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('같은 키 set → 타임스탬프 갱신', () => {
    const cache = new TtlCache<string, number>(100);
    cache.set('a', 1);

    now = 1080; // 80ms 경과
    cache.set('a', 2); // 타임스탬프 갱신

    now = 1160; // 첫 set 기준 160ms, 두번째 set 기준 80ms
    expect(cache.get('a')).toBe(2);
  });

  it('clear → 전체 삭제', () => {
    const cache = new TtlCache<string, number>(100);
    cache.set('a', 1);
    cache.set('b', 2);

    cache.clear();

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('서로 다른 키는 독립적으로 만료', () => {
    const cache = new TtlCache<string, number>(100);
    cache.set('a', 1);

    now = 1050;
    cache.set('b', 2);

    now = 1100; // a는 100ms 경과(만료), b는 50ms 경과(유효)
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
  });
});
