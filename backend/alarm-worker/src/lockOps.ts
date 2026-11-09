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
import { appendLockCodeHistory } from './lockCodeHistory';
import { carryBoardingLock, evaluateSameSession, SESSION_DRIFT_WINDOW_MS } from './sessionIdentity';
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

const sameIdentity = (a: BoardingLockMeta | undefined, b: BoardingLockMeta | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.trainCode === b.trainCode && lockLegKey(a) === lockLegKey(b);

/** 활성 lock 판정 — scheduled.ts `isBoardingLockActive`와 같은 의미(만료 lock 객체는 "lock 없음"). */
const isLockActive = (lock: BoardingLockMeta | undefined, now: number): boolean =>
  lock !== undefined && lock.expiresAt > now;

const noop = (cell: LockCell): LockOpResult => ({ outcome: 'noop', cell });
const conflict = (cell: LockCell): LockOpResult => ({ outcome: 'conflict', cell });

/** lock과 결합 필드를 한 번에 되돌린 "lock 없음" 패치. */
const CLEARED: Partial<LockCell> = {
  lock: undefined,
  consecutiveEtaMissing: 0,
  lockCodeHistory: undefined,
  renumberSuccessor: undefined,
};

/** 부착 패치 — 카운터·history·표식을 새 lock 기준으로 초기화한다. */
const attachPatch = (lock: BoardingLockMeta | undefined): Partial<LockCell> => ({ ...CLEARED, lock });

function applied(
  cell: LockCell,
  op: LockOp,
  now: number,
  patch: Partial<LockCell>,
  identityChanged: boolean,
): LockOpResult {
  const next: LockCell = {
    ...cell,
    ...patch,
    rev: identityChanged ? cell.rev + 1 : cell.rev,
    last: { op: op.type, source: op.source, at: now },
  };
  // everAttached는 OR로만 커진다 — patch가 false를 실어도 되돌리지 않는다.
  next.everAttached = cell.everAttached || patch.everAttached === true || next.lock !== undefined;
  return { outcome: 'applied', cell: next };
}

type Handlers = {
  [K in LockOp['type']]: (cell: LockCell, op: Extract<LockOp, { type: K }>, now: number) => LockOpResult;
};

const HANDLERS: Handlers = {
  attachIfNone: (cell, op, now) => {
    if (isLockActive(cell.lock, now)) return noop(cell);
    if (op.authority === 'auto' && cell.rev !== op.expectedRev) return conflict(cell);
    return applied(cell, op, now, attachPatch(op.lock), true);
  },

  userBoarded: (cell, op, now) => {
    const revMatches = cell.rev === op.expectedRev;
    // 낡은 시야인데 셀에 이미 lock이 있으면 사용자 탭이라도 기존 lock을 지우지 않는다(응답은 셀 기준).
    if (!revMatches && isLockActive(cell.lock, now)) return { outcome: 'conflict-kept', cell };
    if (op.lock !== undefined) return applied(cell, op, now, attachPatch(op.lock), true);
    if (revMatches && op.releaseFirst && cell.lock !== undefined) return applied(cell, op, now, CLEARED, true);
    return noop(cell);
  },

  userDisembarked: (cell, op, now) => {
    if (cell.lock === undefined) return noop(cell);
    if (lockLegKey(cell.lock) !== op.expectedLegKey) return conflict(cell);
    return applied(cell, op, now, CLEARED, true);
  },

  releaseAuto: (cell, op, now) => {
    if (cell.rev !== op.expectedRev) return conflict(cell);
    if (cell.lock === undefined) return noop(cell);
    return applied(cell, op, now, CLEARED, true);
  },

  swapAuto: (cell, op, now) => {
    if (cell.rev !== op.expectedRev) return conflict(cell);
    const { lock } = cell;
    if (lock === undefined) return noop(cell);
    return applied(
      cell,
      op,
      now,
      {
        lock: { ...lock, trainCode: op.trainCode, expiresAt: Math.max(lock.expiresAt, op.expiresAt) },
        lockCodeHistory: op.appendHistory
          ? appendLockCodeHistory(cell.lockCodeHistory, lock.trainCode)
          : cell.lockCodeHistory,
        consecutiveEtaMissing: 0,
        renumberSuccessor: op.renumberSuccessor,
      },
      true,
    );
  },

  refreshExpiry: (cell, op, now) => {
    const { lock } = cell;
    if (cell.rev !== op.expectedRev || lock === undefined || op.until <= lock.expiresAt) return noop(cell);
    return applied(cell, op, now, { lock: { ...lock, expiresAt: op.until } }, false);
  },

  setSegment: (cell, op, now) => {
    if (cell.rev !== op.expectedRev) return conflict(cell);
    const { lock } = cell;
    if (lock === undefined) return noop(cell);
    return applied(cell, op, now, { lock: { ...lock, segmentStations: op.segmentStations } }, false);
  },

  setEtaMissing: (cell, op, now) => {
    if (cell.rev !== op.expectedRev) return conflict(cell);
    if (cell.consecutiveEtaMissing === op.value) return noop(cell);
    return applied(cell, op, now, { consecutiveEtaMissing: op.value }, false);
  },

  registerSession: (cell, op, now) => {
    const incomingLock = op.incomingLock ?? undefined;
    const { existing } = op;
    // 같은 세션 판정은 index.ts와 같은 함수(evaluateSameSession)를 **셀의 최신 lock**으로 평가한다.
    const sameSessionExisting =
      existing !== null &&
      !op.routeReset &&
      evaluateSameSession(
        { boardingLock: cell.lock, createdAt: existing.createdAt },
        { boardingLock: incomingLock, createdAt: op.incomingCreatedAt },
      )
        ? existing
        : null;
    if (sameSessionExisting === null) {
      return applied(
        cell,
        op,
        now,
        { ...attachPatch(incomingLock), session: { seq: cell.session.seq + 1, createdAt: op.incomingCreatedAt } },
        true,
      );
    }
    const lock = carryBoardingLock({
      incomingLock,
      isSameSession: true,
      existingLock: cell.lock,
      existingWaypoints: sameSessionExisting.waypointLines.map((line) => ({ line })),
    });
    if (lock === cell.lock) return noop(cell);
    // lock이 사라지면 결합 필드도 함께 소거(셀 불변식: 이력·표식은 lock과 같이 산다).
    return applied(cell, op, now, lock === undefined ? CLEARED : { lock }, !sameIdentity(cell.lock, lock));
  },

  // rev·seq 카운터는 유지(묘비) — 낡은 rev의 auto op가 거부되도록 rev는 반드시 오른다.
  endSession: (cell, op, now) =>
    applied(cell, op, now, { ...CLEARED, session: { ...cell.session, seq: cell.session.seq + 1 } }, true),

  seedFromKv: (cell, op, now) => {
    const { snapshot, epoch } = op;
    if (cell.session.createdAt === snapshot.createdAt && cell.seededEpoch === epoch) return noop(cell);
    return applied(
      cell,
      op,
      now,
      {
        session: { seq: cell.session.seq, createdAt: snapshot.createdAt },
        lock: snapshot.lock,
        everAttached: snapshot.everAttached === true,
        consecutiveEtaMissing: snapshot.consecutiveEtaMissing ?? 0,
        lockCodeHistory: snapshot.lockCodeHistory,
        renumberSuccessor: snapshot.renumberSuccessor,
        seededEpoch: epoch,
      },
      true,
    );
  },
};

export function applyLockOp(cell: LockCell, op: LockOp, now: number): LockOpResult {
  const handler = HANDLERS[op.type] as (c: LockCell, o: LockOp, n: number) => LockOpResult;
  return handler(cell, op, now);
}

/** 셀의 lock 관련 필드를 메모리 trip에 반영한다(함수형 — 입력 trip 불변). */
export function applyLockCell(trip: Trip, cell: LockCell): Trip {
  const { lock, consecutiveEtaMissing, lockCodeHistory, renumberSuccessor, everAttached } = cell;
  return {
    ...trip,
    boardingLock: lock,
    consecutiveEtaMissing,
    lockCodeHistory,
    renumberSuccessor,
    lockEverAttached: trip.lockEverAttached === true || everAttached ? true : trip.lockEverAttached,
  };
}

/**
 * #3055 — KV가 낡아 `existing===null`로 읽힌 register가 **같은 register burst의 셀 세션**을 만났는지.
 *
 * 셀이 현재 flag epoch로 시드돼 있고, 셀 세션이 incoming과 같은 세션(`evaluateSameSession`)이며 createdAt도 세션 창
 * (`SESSION_DRIFT_WINDOW_MS`) 안이면 그 셀 세션의 createdAt을 돌려준다. 이 경우 register는 신규 trip이 아니라 같은 세션의 재등록이다 —
 * 빈 스냅샷으로 재시드하면 같은 burst 안에 셀에 쓰인 LA 토큰·lock·진행이 지워진다. 아니면(셀 없음 / epoch 불일치 / 다른 세션) undefined.
 */
export function burstSessionCreatedAt(
  cell: LockCell | null,
  incoming: Pick<Trip, 'createdAt' | 'boardingLock'>,
  epoch: number,
): number | undefined {
  if (!cell || cell.seededEpoch !== epoch) return undefined;
  const { createdAt } = cell.session;
  const sameWindow = Math.abs(createdAt - incoming.createdAt) <= SESSION_DRIFT_WINDOW_MS;
  return sameWindow && evaluateSameSession({ boardingLock: cell.lock, createdAt }, incoming) ? createdAt : undefined;
}
