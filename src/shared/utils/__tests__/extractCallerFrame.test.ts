import { extractCallerFrame } from '../extractCallerFrame';

describe('extractCallerFrame', () => {
  it('정상 stack(V8/Hermes 스타일)에서 caller frame을 추출한다', () => {
    const err = new Error('test');
    err.stack = [
      'Error: test',
      '    at helper (/path/to/extractCallerFrame.ts:10:20)',
      '    at setDestination (/path/to/useDestinationStore.ts:100:30)',
      '    at caller (/path/to/SomeScreen.tsx:42:7)',
    ].join('\n');
    // skip=2 → 인덱스 3(첫 줄=에러 메시지) 프레임 = caller.
    expect(extractCallerFrame(err)).toBe('/path/to/SomeScreen.tsx:42:7');
  });

  it('WebKit 스타일 stack(`@`)에서도 추출 가능', () => {
    const err = new Error('test');
    err.stack = [
      'helper@/path/to/extractCallerFrame.ts:10:20',
      'setDestination@/path/to/useDestinationStore.ts:100:30',
      'caller@/path/to/SomeScreen.tsx:42:7',
    ].join('\n');
    // WebKit은 에러 메시지 첫 줄이 없는 케이스가 있어 skip=2면 인덱스 2(caller).
    // 본 테스트는 skip 기본값을 그대로 쓰되 frameLine fallback 분기까지 통과 확인.
    const frame = extractCallerFrame(err);
    // V8 fallback에서는 lines[3] missing → lines[2] fallback. 그게 caller@... 라인.
    expect(frame).toBe('/path/to/SomeScreen.tsx:42:7');
  });

  it('stack이 undefined면 undefined 반환', () => {
    const err = new Error('test');
    err.stack = undefined;
    expect(extractCallerFrame(err)).toBeUndefined();
  });

  it('frame line이 부족하면 마지막 라인으로 fallback', () => {
    const err = new Error('test');
    err.stack = [
      'Error: test',
      '    at helper (/path/to/extractCallerFrame.ts:10:20)',
      '    at setDestination (/path/to/useDestinationStore.ts:100:30)',
    ].join('\n');
    // skip=2 → 인덱스 3 missing → 인덱스 2 fallback = setDestination 라인.
    expect(extractCallerFrame(err)).toBe('/path/to/useDestinationStore.ts:100:30');
  });

  it('parse 불가능한 frame이면 undefined 반환', () => {
    const err = new Error('test');
    err.stack = ['Error: test', '    at <anonymous>'].join('\n');
    expect(extractCallerFrame(err)).toBeUndefined();
  });

  it('frame line은 있지만 file:line:col 토큰이 없으면 undefined 반환', () => {
    const err = new Error('test');
    // skip=2 → lines[3] = `    at unknown` (file token 없음). regex 매치 실패.
    err.stack = [
      'Error: test',
      '    at frame0 (/p/a:1:1)',
      '    at frame1 (/p/b:2:2)',
      '    at unknown',
    ].join('\n');
    expect(extractCallerFrame(err)).toBeUndefined();
  });

  it('비ASCII 경로(한글 디렉토리)도 추출 가능', () => {
    const err = new Error('test');
    err.stack = [
      'Error: test',
      '    at helper (/path/한글/extractCallerFrame.ts:10:20)',
      '    at setDestination (/path/한글/useDestinationStore.ts:100:30)',
      '    at caller (/path/한글/Screen.tsx:42:7)',
    ].join('\n');
    expect(extractCallerFrame(err)).toBe('/path/한글/Screen.tsx:42:7');
  });

  it('skip 인자를 명시하면 해당 깊이의 프레임을 반환', () => {
    const err = new Error('test');
    err.stack = [
      'Error: test',
      '    at frame0 (/p/a:1:1)',
      '    at frame1 (/p/b:2:2)',
      '    at frame2 (/p/c:3:3)',
    ].join('\n');
    expect(extractCallerFrame(err, 0)).toBe('/p/a:1:1');
    expect(extractCallerFrame(err, 1)).toBe('/p/b:2:2');
  });

  it('빈 stack(빈 문자열)이면 fallback도 비어 undefined 반환', () => {
    const err = new Error('test');
    err.stack = '';
    expect(extractCallerFrame(err)).toBeUndefined();
  });
});
