/**
 * #3006 D — KV 쓰기 장애를 "재시도 가능한 실패"로 분류하는 전용 에러.
 *
 * 직렬화 콜백(`withTripRegisterLock`) 안에서는 HTTP 응답을 반환할 수 없어, 쓰기 실패를 이
 * 타입으로 승격해 호출부가 503으로 매핑한다. `instanceof`로 좁히므로 **로직 버그는 그대로
 * 전파돼 500을 유지한다** — 모든 에러를 503으로 가리면 진짜 버그가 "일시 장애"로 숨는다.
 *
 * #3006 PR-0a — `index.ts` 내부 클래스였으나 `cooldownBypass.ts`도 던져야 해 분리했다
 * (index.ts를 import하면 순환).
 */
export class KvWriteUnavailableError extends Error {
  constructor(
    readonly stage: string,
    readonly cause: unknown,
  ) {
    super(`KV write unavailable at ${stage}`);
    this.name = 'KvWriteUnavailableError';
  }
}
