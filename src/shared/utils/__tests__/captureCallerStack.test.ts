import { captureCallerStack } from '../captureCallerStack';

describe('captureCallerStack (#1348)', () => {
  it('caller frame 배열을 반환한다 — 기본 5 frame', () => {
    const stack = captureCallerStack();
    expect(stack).not.toBeNull();
    // V8/Hermes 모두 caller stack은 최소 1 frame 이상.
    expect(Array.isArray(stack)).toBe(true);
    expect((stack as string[]).length).toBeGreaterThan(0);
    // 본 함수 자체 frame은 제외돼야 한다 — captureCallerStack 문자열이 첫 frame에
    // 포함되면 self skip 실패.
    expect((stack as string[])[0]).not.toMatch(/captureCallerStack/);
  });

  it('maxFrames로 보존 수를 제한할 수 있다', () => {
    const stack = captureCallerStack(2);
    expect(stack).not.toBeNull();
    expect((stack as string[]).length).toBeLessThanOrEqual(2);
  });

  it('Error.stack이 undefined인 환경에서는 null 반환', () => {
    // V8/Hermes는 new Error() 인스턴스에 직접 stack을 설정 — prototype 우회는 안 통한다.
    // Error 생성자 자체를 spy해 stack이 undefined인 Error를 반환하도록 한다 (Hermes RN 환경 시뮬레이션).
    const original = global.Error;
    class NoStackError extends original {
      constructor(message?: string) {
        super(message);
        this.stack = undefined;
      }
    }
    (global as { Error: typeof Error }).Error = NoStackError as unknown as typeof Error;
    try {
      expect(captureCallerStack()).toBeNull();
    } finally {
      (global as { Error: typeof Error }).Error = original;
    }
  });

  it('호출자가 깊을수록 frame이 늘어난다 — 단순 unit (서로 다른 depth에서 길이만 비교)', () => {
    function inner(): string[] | null {
      return captureCallerStack(10);
    }
    function outer(): string[] | null {
      return inner();
    }
    const shallow = inner();
    const deep = outer();
    expect(shallow).not.toBeNull();
    expect(deep).not.toBeNull();
    // 더 깊이 호출하면 frame이 최소 같거나 많다.
    expect((deep as string[]).length).toBeGreaterThanOrEqual((shallow as string[]).length);
  });
});
