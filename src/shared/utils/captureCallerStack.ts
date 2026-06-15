/**
 * #1348 — caller stack을 짧은 문자열 배열로 추출.
 *
 * 용도: setDestination 같은 cross-feature 액션의 진입점에서 "누가 호출했는가"를
 * domain breadcrumb data에 첨부해 evidence 수집. JS의 V8/Hermes 양쪽 stack 포맷
 * (`at fn (file:line)` / `at file:line`)을 그대로 둔다 — 원본을 보존해야 사후 재구성
 * 시 frame 정보가 손실되지 않는다.
 *
 * 보존 frame 수는 호출자가 명시. 기본 5 — 호출 깊이 5단계 정도면 사용자 액션 → 컴포넌트
 * → store action 경로가 잡힌다. caller stack 자체 frame과 `Error: caller-trace` 헤더는
 * skip 후 반환.
 */

const DEFAULT_FRAME_COUNT = 5;

/**
 * 현재 호출 지점의 caller stack 일부를 가져온다.
 *
 * - `Error.stack`이 undefined(테스트 환경 mock 등)면 null 반환 — breadcrumb에서 자연스러운
 *   "정보 없음" 분기로 처리 가능.
 * - 반환은 trim된 frame 문자열 배열. `Error: caller-trace` 메시지 라인과 본 함수 자체 frame은 제외.
 *
 * V8/Hermes는 환경에 따라 inline 최적화로 본 함수 frame을 누락하기도 한다. `captureCallerStack`
 * 문자열을 포함하는 frame을 모두 필터링해 self-skip을 robust하게 처리.
 *
 * @param maxFrames 보존할 frame 수 (default 5)
 */
export function captureCallerStack(maxFrames: number = DEFAULT_FRAME_COUNT): string[] | null {
  const stack = new Error('caller-trace').stack;
  if (!stack) return null;
  const lines = stack.split('\n').map((line) => line.trim());
  // line[0]은 `Error: caller-trace` 메시지(V8/Hermes 공통). 그 외 frame 라인만 추려서 self frame 필터.
  const frames = lines.slice(1).filter((line) => line.length > 0 && !line.includes('captureCallerStack'));
  return frames.slice(0, maxFrames);
}
