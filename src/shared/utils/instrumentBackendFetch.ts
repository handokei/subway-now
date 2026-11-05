/**
 * Backend HTTP 호출 instrumentation wrapper (#1518).
 *
 * 모든 alarm-worker 호출 chokepoint(`fetchWithTimeout`, `fetchWithTelemetryTimeout`,
 * alarmBackend 내부 헬퍼, tripStatus 내부 헬퍼)가 본 함수를 통과한다. 호출 직전 call
 * entry를 push, fetch resolve 시 response entry, throw/timeout 시 error entry를 push.
 *
 * 본 wrapper는 timeout/abort 자체를 추가하지 않는다 — 각 chokepoint는 기존 자체
 * AbortController 정책을 유지하고, 본 함수에는 init에 controller.signal이 이미 박힌
 * fetch만 그대로 통과시킨다. instrumentation 자체의 추가 latency는 ring buffer
 * push + Date.now()만 — 측정상 5ms 이내(acceptance).
 */
import {
  createCallId,
  getCurrentCorrId,
  pushBackendCallEntry,
} from './backendCallBuffer';

/** init에서 method 추출 — 없으면 'GET'. */
function resolveMethod(init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  return 'GET';
}

/**
 * fetch를 wrapping해 call/response/error entry를 backendCallBuffer에 push한다.
 *
 * @param url   호출 URL.
 * @param init  RequestInit (fetch 그대로 전달).
 * @param fetchImpl  주입 가능한 fetch 구현. 테스트에서 mock 주입.
 *
 * @returns wrapped fetch가 반환하는 Response 그대로.
 * @throws fetch가 throw하면 그대로 re-throw — 호출자 catch 경로 보존.
 */
export async function instrumentBackendFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const callId = createCallId();
  const corrId = getCurrentCorrId();
  const method = resolveMethod(init);
  const sentAt = Date.now();
  pushBackendCallEntry({
    kind: 'call',
    ts: sentAt,
    callId,
    corrId,
    url,
    method,
  });

  try {
    const res = await fetchImpl(url, init);
    pushBackendCallEntry({
      kind: 'response',
      ts: Date.now(),
      callId,
      corrId,
      url,
      method,
      status: res.status,
      latencyMs: Date.now() - sentAt,
    });
    return res;
  } catch (e) {
    pushBackendCallEntry({
      kind: 'error',
      ts: Date.now(),
      callId,
      corrId,
      url,
      method,
      latencyMs: Date.now() - sentAt,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}
