import { createDebugBuffer } from '../../../shared/utils/createDebugBuffer';
import type { LockReleaseReason } from '../store/useBoardingLockStore';

/**
 * #2152 — BoardingLock lifecycle breadcrumb 전용 ring buffer.
 *
 * 배경 (2026-08-05 trip RCA): lock의 생성 경로(source)/해제 사유(reason)/trainCode가 덤프에도
 * 백엔드에도 안 남아 오토락 범인 특정에 소거법이 필요했다. backend는 sync payload 미적재 + trip
 * KV DELETE로 소멸 → device 덤프가 유일한 1차 증거인데 lifecycle 기록이 없었다.
 *
 * `boardingLockDriftBuffer`(#1896, RC-8)와 동일 패턴 — fusionDebugBuffer(cap=500) 점령 자기 파괴
 * 회귀(lesson: 단일 ring buffer가 고빈도 진단 entry로 저빈도 evidence를 evict)를 차단하기 위해
 * 별 buffer로 분리한다.
 *
 * cap=50: lock create/release는 trip 1개당 수 건(환승 leg마다 1쌍) 수준의 저빈도 이벤트라
 * fusionDebugBuffer(500)보다 훨씬 작은 cap으로 충분 — 여러 trip에 걸친 lifecycle history를
 * 오래 보존하는 게 오히려 유용(오토락 삭제 이슈 검증의 "무탭 create 0건" 증명 등).
 */
export const BOARDING_LOCK_LIFECYCLE_BUFFER_CAPACITY = 50;

/** lock create 경로 — 소거법으로 오토락 범인 특정하기 위한 최소 분류. */
export type LockLifecycleCreateSource =
  | 'user-tap'
  | 'boarding-prompt-response'
  | 'other';

export interface LockLifecycleCreateEntry {
  kind: 'boarding-lock-lifecycle';
  event: 'create';
  ts: number;
  source: LockLifecycleCreateSource;
  trainCode: string;
  line: string;
  stationId: string;
}

export interface LockLifecycleReleaseEntry {
  kind: 'boarding-lock-lifecycle';
  event: 'release';
  ts: number;
  reason: LockReleaseReason;
  trainCode: string;
  line: string;
}

export type LockLifecycleEntry = LockLifecycleCreateEntry | LockLifecycleReleaseEntry;

const db = createDebugBuffer<LockLifecycleEntry>(BOARDING_LOCK_LIFECYCLE_BUFFER_CAPACITY);

export function pushLockLifecycleEntry(entry: LockLifecycleEntry): void {
  db.push(entry);
}

export function getLockLifecycleEntries(): readonly LockLifecycleEntry[] {
  return db.get();
}

export function clearLockLifecycleEntries(): void {
  db.clear();
}

export function subscribeLockLifecycle(listener: () => void): () => void {
  return db.subscribe(listener);
}
