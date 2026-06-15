/**
 * #1346 — setDestination caller trace를 위해 Error.stack에서 호출자 프레임을 추출한다.
 *
 * 용도: lockless trip 잔존 분석. 예: tripStartedAt이 9시간 동안 살아있으면 어느 컴포넌트/훅이
 * setDestination을 마지막으로 호출했는지 사후 재구성하기 위해 breadcrumb에 caller를 stamp한다.
 *
 * 입력은 `new Error()`로 만들어진 표준 Error 인스턴스. 첫 프레임은 helper 자기 자신,
 * 두 번째 프레임은 helper를 부른 setDestination, 세 번째 프레임이 사용자 코드(caller)다.
 * (call site로부터 fixed offset이라 호출부에서 `skip` 개수를 명시적으로 지정한다.)
 *
 * 성능: 호출부에서 EXPO_PUBLIC_DEBUG_MODAL 게이팅 후에만 호출되도록 운영 빌드에서는 무비용.
 *
 * 형식 안전성: stack은 엔진/번들러에 따라 모양이 다르다.
 *   - Hermes/V8: `at FuncName (file:line:col)` 또는 `at file:line:col`
 *   - WebKit:    `FuncName@file:line:col`
 * 어느 형식이든 콜론(`:`)으로 끝나는 `file:line:col` 토큰을 캡쳐하면 충분하다. 캡쳐 실패 시
 * undefined를 반환해 호출부가 graceful하게 fallback할 수 있게 한다.
 */
export function extractCallerFrame(error: Error, skip = 2): string | undefined {
  const { stack } = error;
  if (!stack) return undefined;

  const lines = stack.split('\n');
  // stack 첫 줄은 보통 에러 메시지 ("Error" 한 줄). 그 뒤가 프레임.
  // skip은 호출부에서 명시적으로 지정 — 본 함수는 "n번째 프레임"만 알면 된다.
  const frameLine = lines[skip + 1] ?? lines[skip];
  if (!frameLine) return undefined;

  // 양쪽 형식 모두 `file:line:col` 토큰을 캡쳐. 가장 마지막 토큰을 우선시(괄호 안에 위치).
  const match = /(?:\(|@| )([^()\s]+:\d+:\d+)\)?$/.exec(frameLine.trim());
  if (!match) return undefined;
  return match[1];
}
