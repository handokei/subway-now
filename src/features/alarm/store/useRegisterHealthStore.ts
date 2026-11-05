import { create } from 'zustand';
import { REGISTER_KV_UNAVAILABLE_ERROR } from '../../../shared/constants/registerContract';

/**
 * #3006 PR-2 — POST /trips가 backend 일시 장애(503 `kv_unavailable`, KV 쓰기 쿼터 소진)로 막혀
 * 있는지. **메모리 전용**(영속화 없음) — 앱을 다시 켜면 다음 POST /trips 결과가 다시 정한다.
 *
 * 쓰기 지점은 `useApnsTripRegistration` 2곳뿐이다(POST 결과 처리 / 목적지 변경 정리) —
 * `registerHealthSingleWriter.test.ts`(C11)가 고정한다. 읽는 쪽(배너, PR-3)은 `degraded`만 본다.
 */
interface RegisterHealthState {
  degraded: boolean;
}

export const useRegisterHealthStore = create<RegisterHealthState>(() => ({ degraded: false }));

type RegisterOutcome = 'degraded' | 'recovered' | 'neutral';

/** `classifyRegisterOutcome`이 읽는 register 결과의 부분집합(`registerFromLatestInputs` 반환과 호환). */
interface RegisterOutcomeInput {
  ok: boolean;
  skipped?: boolean;
  status?: number;
  errorCode?: string;
  /** 억제 skip 사유 — 있으면 실제 POST가 아니므로 신호가 아니다. */
  suppressed?: string;
}

/**
 * 분류 규칙(spec §2-4): 억제 skip → neutral / 503 kv_unavailable → degraded /
 * 200이면서 dedup skip이 아님 → recovered / 그 외(엣지 HTML 503·500·4xx·429·네트워크 오류·dedup) → neutral.
 *
 * dedup skip(`ok && skipped`)은 네트워크를 타지 않았으므로 서버가 회복됐다는 증거가 아니다.
 */
export function classifyRegisterOutcome(result: RegisterOutcomeInput | null): RegisterOutcome {
  if (!result || result.suppressed) return 'neutral';
  if (result.status === 503 && result.errorCode === REGISTER_KV_UNAVAILABLE_ERROR) return 'degraded';
  if (result.ok && !result.skipped) return 'recovered';
  return 'neutral';
}

/** 분류 결과를 스토어에 반영한다. neutral은 값을 바꾸지 않는다. */
export function applyRegisterHealthOutcome(outcome: RegisterOutcome): void {
  if (outcome === 'neutral') return;
  useRegisterHealthStore.setState({ degraded: outcome === 'degraded' });
}

/** trip(목적지)이 끝나거나 바뀌면 이전 trip의 장애 신호를 버린다. */
export function resetRegisterHealth(): void {
  useRegisterHealthStore.setState({ degraded: false });
}
