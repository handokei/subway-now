/**
 * #3300 옵션 D PR-1 — lock 셀의 "이름 붙은 상태 연산(ops)" 순수 함수.
 *
 * 배경: 낡은 시야(KV 60s 캐시 스냅샷)를 가진 writer가 통째 쓰기로 최신 lock을 덮어 lock이 소실됐다
 * (11/03 3334 / 10/19 leg-2). 필드 단위 CAS 대신, 함께 바뀌어야 하는 필드를 한 op로 묶고
 * 전제조건을 **식별 rev**(부착·swap·해제·세션 변경에만 +1, TTL 갱신은 불변)로 좁힌다.
 *
 * 이 파일은 순수 함수만 둔다 — DO/KV/index.ts/scheduled.ts 연결 없음(동작 변화 0).
 * 호출자 연결은 PR-2(TripDO `/lock`) ~ PR-3a/3b. 스펙: tasks/plan-2026-11-03-trip-do-field-cas.md §2.
 */
import type { BoardingLockMeta, Trip } from './types';

export interface LockCell {
  /** 세션 신원. ADR-025상 1 token이 연속 세션을 공유하므로 seq로 구분한다. */
  session: { seq: number; createdAt: number };
  /** 식별 rev — 부착·swap·해제·세션 변경에만 증가(TTL 갱신/segment/카운터는 불변). */
  rev: number;
  lock?: BoardingLockMeta;
  /** OR로만 커진다(해제·세션 변경에도 되돌아가지 않음). trips.ts lockEverAttached 의미 유지. */
  everAttached: boolean;
  /** lock과 항상 함께 재설정되는 결합 필드(반증 7). */
  consecutiveEtaMissing: number;
  lockCodeHistory?: string[];
  renumberSuccessor?: Trip['renumberSuccessor'];
  /** seedFromKv가 마지막으로 반영한 flag epoch. */
  seededEpoch: number;
  last: { op: LockOp['type'] | 'init'; source: string; at: number };
}

export type LockOpOutcome = 'applied' | 'noop' | 'conflict' | 'conflict-kept';

export interface LockOpResult {
  outcome: LockOpOutcome;
  cell: LockCell;
}

interface OpBase {
  /** 호출 경로 식별(confirm / sync / register / cron-leg1 ...) — cell.last와 관측용. */
  source: string;
}

export interface AttachIfNoneOp extends OpBase {
  type: 'attachIfNone';
  lock: BoardingLockMeta;
  /** auto는 rev 일치까지 요구, user(sync 수동 탭)는 lock 부재만 요구한다(ADR-043). */
  authority: 'auto' | 'user';
  expectedRev: number;
}
export interface UserBoardedOp extends OpBase {
  type: 'userBoarded';
  expectedRev: number;
  /** boarded 탭의 leg 전환 해제(index.ts:2700). */
  releaseFirst: boolean;
  lock?: BoardingLockMeta;
}
export interface UserDisembarkedOp extends OpBase {
  type: 'userDisembarked';
  expectedLegKey: string;
}
export interface ReleaseAutoOp extends OpBase {
  type: 'releaseAuto';
  expectedRev: number;
  reason: string;
}
export interface SwapAutoOp extends OpBase {
  type: 'swapAuto';
  expectedRev: number;
  trainCode: string;
  expiresAt: number;
  appendHistory: boolean;
  renumberSuccessor?: Trip['renumberSuccessor'];
}
export interface RefreshExpiryOp extends OpBase {
  type: 'refreshExpiry';
  expectedRev: number;
  until: number;
}
export interface SetSegmentOp extends OpBase {
  type: 'setSegment';
  expectedRev: number;
  segmentStations: string[];
}
export interface SetEtaMissingOp extends OpBase {
  type: 'setEtaMissing';
  expectedRev: number;
  value: number;
}
export interface RegisterSessionOp extends OpBase {
  type: 'registerSession';
  incomingLock: BoardingLockMeta | null;
  /** 저장돼 있던 trip의 신원. null이면 신규 trip. */
  existing: { createdAt: number; waypointLines: string[] } | null;
  incomingCreatedAt: number;
  /** route in-place reset(ADR-025) — index.ts에서 existing=null로 취급되는 경우와 같다. */
  routeReset: boolean;
}
export interface EndSessionOp extends OpBase {
  type: 'endSession';
}
export interface SeedFromKvOp extends OpBase {
  type: 'seedFromKv';
  snapshot: {
    createdAt: number;
    lock?: BoardingLockMeta;
    everAttached?: boolean;
    consecutiveEtaMissing?: number;
    lockCodeHistory?: string[];
    renumberSuccessor?: Trip['renumberSuccessor'];
  };
  epoch: number;
}

export type LockOp =
  | AttachIfNoneOp
  | UserBoardedOp
  | UserDisembarkedOp
  | ReleaseAutoOp
  | SwapAutoOp
  | RefreshExpiryOp
  | SetSegmentOp
  | SetEtaMissingOp
  | RegisterSessionOp
  | EndSessionOp
  | SeedFromKvOp;

export function emptyLockCell(): LockCell {
  return {
    session: { seq: 0, createdAt: 0 },
    rev: 0,
    everAttached: false,
    consecutiveEtaMissing: 0,
    seededEpoch: -1,
    last: { op: 'init', source: 'init', at: 0 },
  };
}

/** userDisembarked의 전제 — 같은 leg 안의 swap은 legKey를 바꾸지 않는다. */
export function lockLegKey(lock: BoardingLockMeta): string {
  const [origin] = lock.segmentStations;
  return `${origin}|${lock.line}`;
}

// red 단계 stub — 시그니처만 있고 동작은 없다(모든 op가 noop). 구현은 다음 커밋.
export function applyLockOp(cell: LockCell, _op: LockOp, _now: number): LockOpResult {
  return { outcome: 'noop', cell };
}

export function applyLockCell(trip: Trip, _cell: LockCell): Trip {
  return trip;
}
