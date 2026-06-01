import { renderHook, act } from '@testing-library/react-native';
import { usePositionStability } from '../usePositionStability';

type Loc = { lat: number; lng: number } | null;
type RenderRef = ReturnType<typeof renderHookWithLoc>;

function renderHookWithLoc(initialLoc: Loc) {
  return renderHook(
    ({ loc }: { loc: Loc }) => usePositionStability(loc),
    { initialProps: { loc: initialLoc } },
  );
}

function pushAt(hook: RenderRef, ts: number, loc: Loc): void {
  act(() => {
    (Date.now as jest.Mock).mockReturnValue(ts);
    hook.rerender({ loc });
  });
}

describe('usePositionStability', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('초기에 userLocation 없으면 unknown', () => {
    const { result } = renderHook(() => usePositionStability(null));
    expect(result.current).toBe('unknown');
  });

  it('userLocation null이 유지되면 stability도 unknown 유지', () => {
    const hook = renderHookWithLoc(null);
    hook.rerender({ loc: null });
    expect(hook.result.current).toBe('unknown');
  });

  it('sample 1개만 들어오면 unknown (minSamples 미달)', () => {
    const hook = renderHookWithLoc(null);
    pushAt(hook, 1_000_000, { lat: 37.5756, lng: 127.087 });
    expect(hook.result.current).toBe('unknown');
  });

  it('60s 윈도우에 같은 좌표 3개 들어오면 static', () => {
    const hook = renderHookWithLoc(null);
    pushAt(hook, 1_000_000, { lat: 37.5756, lng: 127.087 });
    pushAt(hook, 1_030_000, { lat: 37.5756, lng: 127.0871 });
    pushAt(hook, 1_060_000, { lat: 37.5756, lng: 127.087 });
    expect(hook.result.current).toBe('static');
  });

  it('서로 떨어진 좌표 3개 들어오면 moving', () => {
    const hook = renderHookWithLoc(null);
    pushAt(hook, 1_000_000, { lat: 37.5756, lng: 127.087 });
    pushAt(hook, 1_030_000, { lat: 37.58, lng: 127.087 });
    pushAt(hook, 1_060_000, { lat: 37.59, lng: 127.087 });
    expect(hook.result.current).toBe('moving');
  });

  it('userLocation이 null 되면 sample 추가 안 되고 직전 stability 유지', () => {
    const hook = renderHookWithLoc(null);
    pushAt(hook, 1_000_000, { lat: 37.5756, lng: 127.087 });
    pushAt(hook, 1_030_000, { lat: 37.5756, lng: 127.0871 });
    pushAt(hook, 1_060_000, { lat: 37.5756, lng: 127.087 });
    expect(hook.result.current).toBe('static');

    pushAt(hook, 1_090_000, null);
    expect(hook.result.current).toBe('static');
  });

  it('오래된 sample(prune window 초과)은 자동 제거 — buffer 누적 안 됨', () => {
    const hook = renderHookWithLoc(null);
    for (let i = 0; i < 3; i++) {
      pushAt(hook, 1_000_000 + i * 30_000, { lat: 37.5756 + i * 0.0001, lng: 127.087 });
    }
    expect(hook.result.current).toBe('static');

    // 5분 후 큰 점프 — 오래된 sample은 prune되어야 하므로 새로운 burst만 본다.
    pushAt(hook, 1_400_000, { lat: 37.6, lng: 127.1 });
    expect(hook.result.current).toBe('unknown');
  });
});
