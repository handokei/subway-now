import {
  applyRegisterHealthOutcome,
  classifyRegisterOutcome,
  resetRegisterHealth,
  useRegisterHealthStore,
} from '../useRegisterHealthStore';

const degraded = (): boolean => useRegisterHealthStore.getState().degraded;

beforeEach(() => {
  useRegisterHealthStore.setState({ degraded: false });
});

describe('useRegisterHealthStore (#3006 PR-2) — 메모리 전용 {degraded}', () => {
  it('초기값은 degraded=false', () => {
    expect(degraded()).toBe(false);
  });

  it("apply('degraded') → true, apply('recovered') → false", () => {
    applyRegisterHealthOutcome('degraded');
    expect(degraded()).toBe(true);
    applyRegisterHealthOutcome('recovered');
    expect(degraded()).toBe(false);
  });

  it("apply('neutral')은 어느 방향이든 값을 바꾸지 않는다", () => {
    applyRegisterHealthOutcome('neutral');
    expect(degraded()).toBe(false);
    useRegisterHealthStore.setState({ degraded: true });
    applyRegisterHealthOutcome('neutral');
    expect(degraded()).toBe(true);
  });

  it('resetRegisterHealth는 degraded를 false로 되돌린다', () => {
    useRegisterHealthStore.setState({ degraded: true });
    resetRegisterHealth();
    expect(degraded()).toBe(false);
  });
});

describe('classifyRegisterOutcome (C12) — 분류 규칙 표', () => {
  const cases: ReadonlyArray<[string, Parameters<typeof classifyRegisterOutcome>[0], string]> = [
    ['억제 skip(backend-degraded)', { ok: false, suppressed: 'backend-degraded' }, 'neutral'],
    ['억제 skip(rate-limited)', { ok: false, suppressed: 'rate-limited' }, 'neutral'],
    [
      '억제 skip은 503 kv 필드가 같이 있어도 neutral(사유 우선)',
      { ok: false, status: 503, errorCode: 'kv_unavailable', suppressed: 'backend-degraded' },
      'neutral',
    ],
    ['503 kv_unavailable', { ok: false, status: 503, errorCode: 'kv_unavailable' }, 'degraded'],
    [
      '503 kv_unavailable + Retry-After',
      { ok: false, status: 503, errorCode: 'kv_unavailable', retryAfterSeconds: 60 },
      'degraded',
    ],
    ['503 엣지 HTML(errorCode 없음)', { ok: false, status: 503 }, 'neutral'],
    ['503 다른 errorCode', { ok: false, status: 503, errorCode: 'edge_error' }, 'neutral'],
    [
      '500 + kv_unavailable 코드(상태 불일치)',
      { ok: false, status: 500, errorCode: 'kv_unavailable' },
      'neutral',
    ],
    ['500', { ok: false, status: 500 }, 'neutral'],
    ['429', { ok: false, status: 429, retryAfterSeconds: 30 }, 'neutral'],
    ['네트워크 오류(status 없음)', { ok: false }, 'neutral'],
    ['graceful skip(ok:false, skipped:true)', { ok: false, skipped: true }, 'neutral'],
    ['200 신규 등록', { ok: true }, 'recovered'],
    ['200 dedup skip(네트워크 0)', { ok: true, skipped: true }, 'neutral'],
    ['결과 없음(null)', null, 'neutral'],
  ];

  it.each(cases)('%s → %s', (_name, input, expected) => {
    expect(classifyRegisterOutcome(input)).toBe(expected);
  });
});
