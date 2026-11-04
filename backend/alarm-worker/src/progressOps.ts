/**
 * #3055 / #3300 옵션 D PR-4a — 진행 셀(waypoints 계열)의 "이름 붙은 상태 연산(ops)" 순수 함수.
 *
 * 배경(ADR-052 클래스): 낡은 시야(KV 60s 캐시 스냅샷)를 가진 writer가 통째 쓰기로 head를 되감아 cron이 같은 역을 다시 소비했다
 * (10/31 강남구청 4회 재소비 — D1 prepare-alarm 1915/1921/1926/1929, 11/04 군자 누락). ADR-052는 이를 cron 맞춤(`reconcileTripWithProgress`)이
 * **사후에 복구**하는 구조였고, 맞춤이 복구하기 전에 발사가 일어났다. 이 셀은 진행 위치의 권위를 DO 하나로 모은다:
 *  - 전진은 **head 키 선점(claim)**으로만 한다 — `advanceHead{expectedHeadKey}`는 그 head가 아직 셀의 head일 때만 적용되고, 이미 지나갔으면
 *    `noop`이다. 호출자는 `applied`일 때만 발사한다(claim-then-fire) -> 같은 역 재소비가 구조적으로 불가능하다.
 *  - 사용자 탭(`userTapAdvance`)은 **앞으로만** 간다 — 낡은 base로 되감지 못한다.
 *  - lock 셀과 함께 바뀌어야 하는 결합(환승 해제 / reanchor segment / sync 승격)은 한 op로 묶는다(DO가 두 셀을 한 번에 쓴다).
 *  - 나머지 필드(LA·추적 스탬프, leg 상태, transferObservedAt)는 `stampProgress` 허용 목록 op로만 바꾼다.
 *
 * 이 파일은 순수 함수만 둔다 — DO/KV/index.ts/scheduled.ts 연결은 `tripDO.ts`(라우트)·`tripDoCells.ts`(클라이언트)·호출자 몫.
 * 스펙: tasks/plan-2026-11-03-trip-do-field-cas.md §4 PR-4a/4b, §9(PR-4 누락 writer 행).
 */
import { applyLockOp, emptyLockCell, type LockCell, type LockOpResult } from './lockOps';
import { waypointSignatureKey } from './trips';
import type { Trip, Waypoint } from './types';

type LegAnchor = NonNullable<Trip['currentLegAnchor']>;

export interface ProgressCell {
  /** 세션 신원 — `seedProgressFromKv`/`registerProgress`가 KV trip의 createdAt으로 맞춘다. */
  session: { createdAt: number };
  /** 전진·재고정·세션 변경에만 +1(스탬프는 불변). 관측과 `__progressRev` 전달용. */
  rev: number;
  /** 남은 노선(head = `waypoints[0]`). 진행 위치의 권위. */
  waypoints: Waypoint[];
  /** 세션 노선 원본(재고정 입력). */
  routeWaypoints?: Waypoint[];
  currentLegAnchor?: LegAnchor;
  legBoardingEligibleAt?: number;
  legBoardingPromptState?: Trip['legBoardingPromptState'];
  legResolveStreak?: Trip['legResolveStreak'];
  promptDisplay?: Trip['promptDisplay'];
  transferObservedAt?: Trip['transferObservedAt'];
  lastTrackedArrivalEpoch?: number;
  lastLaPushEpoch?: number;
  lastLaPushAt?: number;
  /** seedProgressFromKv가 마지막으로 반영한 flag epoch. */
  seededEpoch: number;
  last: { op: ProgressOp['type'] | 'init'; source: string; at: number };
}

export type ProgressOpOutcome = 'applied' | 'noop' | 'conflict';

export interface ProgressOpResult {
  outcome: ProgressOpOutcome;
  cell: ProgressCell;
  /** lock 셀을 함께 건드린 op(advanceHead.releaseLock / reanchor / attachWithFastForward)의 lock 결과. */
  lock?: LockOpResult;
}

interface OpBase {
  /** 호출 경로 식별(cron / confirm / sync / register ...) — cell.last와 관측용. */
  source: string;
}

/** head 스코프 스탬프 — head가 바뀌면 무의미해지는 값(전진 시 리셋). `expectedHeadKey`가 일치할 때만 쓴다. */
export const HEAD_SCOPED_STAMPS = ['lastTrackedArrivalEpoch', 'lastLaPushEpoch', 'lastLaPushAt'] as const;
/** leg 스코프 스탬프 — head와 무관(leg anchor 재stamp 때 리셋). */
export const LEG_SCOPED_STAMPS = ['legResolveStreak', 'legBoardingPromptState'] as const;
export type ProgressStampKey = (typeof HEAD_SCOPED_STAMPS)[number] | (typeof LEG_SCOPED_STAMPS)[number] | 'transferObservedAt';
export type ProgressStamps = Pick<ProgressCell, ProgressStampKey>;

export interface ProgressSnapshot extends Partial<ProgressStamps> {
  createdAt: number;
  waypoints?: Waypoint[];
  routeWaypoints?: Waypoint[];
  currentLegAnchor?: LegAnchor;
  legBoardingEligibleAt?: number;
  promptDisplay?: Trip['promptDisplay'];
}

export interface SeedProgressFromKvOp extends OpBase {
  type: 'seedProgressFromKv';
  snapshot: ProgressSnapshot;
  epoch: number;
}
export interface RegisterProgressOp extends OpBase {
  type: 'registerProgress';
  /** 새 세션(신규 trip / route reset / 다른 세션) — incoming으로 전면 재초기화. 같은 세션은 진행을 쓰지 않는다. */
  newSession: boolean;
  incoming: { createdAt: number; waypoints: Waypoint[]; routeWaypoints?: Waypoint[]; promptDisplay?: Trip['promptDisplay'] };
}
export interface AdvanceHeadOp extends OpBase {
  type: 'advanceHead';
  /** 호출자가 소비하려는 head의 키(`waypointSignatureKey`). */
  expectedHeadKey: string;
  count: number;
  /** 환승 전진이 lock을 함께 푸는 결합(§3 #18) — 전진이 applied일 때만 같은 storage 쓰기로 `releaseAuto`를 적용한다. */
  releaseLock?: { expectedRev: number; reason: string };
}
export interface UserTapAdvanceOp extends OpBase {
  type: 'userTapAdvance';
  toHeadKey: string;
  anchor: LegAnchor;
}
export interface SetLegAnchorOp extends OpBase {
  type: 'setLegAnchor';
  anchor: LegAnchor;
  eligibleAt: number;
}
export interface ReanchorOp extends OpBase {
  type: 'reanchor';
  expectedHeadKey: string;
  waypoints: Waypoint[];
  expectedLockRev: number;
  segmentStations: string[];
}
export interface AttachWithFastForwardOp extends OpBase {
  type: 'attachWithFastForward';
  lock: NonNullable<Trip['boardingLock']>;
  expectedLockRev: number;
  expectedHeadKey: string;
  skip: number;
}
export interface StampProgressOp extends OpBase {
  type: 'stampProgress';
  /** head 스코프 필드를 건드릴 때 필수 — 셀 head가 이 키와 같을 때만 적용한다. */
  expectedHeadKey?: string;
  set?: Partial<ProgressStamps>;
  clear?: ProgressStampKey[];
}

export type ProgressOp =
  | SeedProgressFromKvOp
  | RegisterProgressOp
  | AdvanceHeadOp
  | UserTapAdvanceOp
  | SetLegAnchorOp
  | ReanchorOp
  | AttachWithFastForwardOp
  | StampProgressOp;

export function emptyProgressCell(): ProgressCell {
  return {
    session: { createdAt: 0 },
    rev: 0,
    waypoints: [],
    seededEpoch: -1,
    last: { op: 'init', source: 'init', at: 0 },
  };
}

export function progressHeadKey(cell: Pick<ProgressCell, 'waypoints'>): string | undefined {
  const [head] = cell.waypoints;
  return head === undefined ? undefined : waypointSignatureKey(head);
}

const indexOfKey = (waypoints: Waypoint[], headKey: string): number =>
  waypoints.findIndex((w) => waypointSignatureKey(w) === headKey);

const noop = (cell: ProgressCell): ProgressOpResult => ({ outcome: 'noop', cell });
const conflict = (cell: ProgressCell): ProgressOpResult => ({ outcome: 'conflict', cell });

/** head가 바뀌면 의미를 잃는 스탬프를 한 번에 되돌린 패치(`completeWaypointAdvance`의 baseline reset과 같은 집합). */
const HEAD_STAMPS_CLEARED: Partial<ProgressCell> = {
  lastTrackedArrivalEpoch: undefined,
  lastLaPushEpoch: undefined,
  lastLaPushAt: undefined,
};

/** 새 leg anchor를 stamp할 때 함께 리셋되는 leg 상태(`stampCurrentLegAnchor`와 같은 집합). */
const LEG_STATE_CLEARED: Partial<ProgressCell> = {
  legBoardingPromptState: undefined,
  legResolveStreak: undefined,
};

function applied(
  cell: ProgressCell,
  op: ProgressOp,
  now: number,
  patch: Partial<ProgressCell>,
  identityChanged: boolean,
  lock?: LockOpResult,
): ProgressOpResult {
  const next: ProgressCell = {
    ...cell,
    ...patch,
    rev: identityChanged ? cell.rev + 1 : cell.rev,
    last: { op: op.type, source: op.source, at: now },
  };
  return lock === undefined ? { outcome: 'applied', cell: next } : { outcome: 'applied', cell: next, lock };
}

const sameAnchor = (a: LegAnchor | undefined, b: LegAnchor): boolean =>
  a !== undefined && a.boardingStation === b.boardingStation && a.line === b.line;

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

type Handlers = {
  [K in ProgressOp['type']]: (
    cell: ProgressCell,
    lock: LockCell,
    op: Extract<ProgressOp, { type: K }>,
    now: number,
  ) => ProgressOpResult;
};

const HANDLERS: Handlers = {
  seedProgressFromKv: (cell, _lock, op, now) => {
    const { snapshot, epoch } = op;
    if (cell.session.createdAt === snapshot.createdAt && cell.seededEpoch === epoch) return noop(cell);
    return applied(
      cell,
      op,
      now,
      {
        session: { createdAt: snapshot.createdAt },
        waypoints: snapshot.waypoints ?? [],
        routeWaypoints: snapshot.routeWaypoints,
        currentLegAnchor: snapshot.currentLegAnchor,
        legBoardingEligibleAt: snapshot.legBoardingEligibleAt,
        legBoardingPromptState: snapshot.legBoardingPromptState,
        legResolveStreak: snapshot.legResolveStreak,
        promptDisplay: snapshot.promptDisplay,
        transferObservedAt: snapshot.transferObservedAt,
        lastTrackedArrivalEpoch: snapshot.lastTrackedArrivalEpoch,
        lastLaPushEpoch: snapshot.lastLaPushEpoch,
        lastLaPushAt: snapshot.lastLaPushAt,
        seededEpoch: epoch,
      },
      true,
    );
  },

  // register는 진행의 작성자가 아니다(ADR-052 "register는 진행을 쓰지 않는다" 유지): 새 세션만 incoming으로 초기화한다.
  registerProgress: (cell, _lock, op, now) => {
    const { incoming } = op;
    if (op.newSession) {
      return applied(
        cell,
        op,
        now,
        {
          session: { createdAt: incoming.createdAt },
          waypoints: incoming.waypoints,
          routeWaypoints: incoming.routeWaypoints ?? incoming.waypoints,
          currentLegAnchor: undefined,
          legBoardingEligibleAt: undefined,
          legBoardingPromptState: undefined,
          legResolveStreak: undefined,
          promptDisplay: incoming.promptDisplay,
          transferObservedAt: undefined,
          ...HEAD_STAMPS_CLEARED,
        },
        true,
      );
    }
    const promptDisplay = incoming.promptDisplay ?? cell.promptDisplay;
    if (sameValue(promptDisplay, cell.promptDisplay)) return noop(cell);
    return applied(cell, op, now, { promptDisplay }, false);
  },

  advanceHead: (cell, lock, op, now) => {
    const index = indexOfKey(cell.waypoints, op.expectedHeadKey);
    if (index < 0) return noop(cell); // 이미 지나간 head — 호출자는 발사하지 않는다.
    if (index > 0) return conflict(cell); // 호출자 시야가 셀보다 앞섬 — 셀을 건너뛰어 쓰지 않는다.
    const patch: Partial<ProgressCell> = { waypoints: cell.waypoints.slice(Math.max(1, op.count)), ...HEAD_STAMPS_CLEARED };
    const lockResult =
      op.releaseLock === undefined
        ? undefined
        : applyLockOp(
            lock,
            { type: 'releaseAuto', source: op.source, expectedRev: op.releaseLock.expectedRev, reason: op.releaseLock.reason },
            now,
          );
    return applied(cell, op, now, patch, true, lockResult);
  },

  // 사용자 탭 전진은 앞으로만 — 셀이 이미 앞서 있으면(탭 시야가 낡음) 유지한다.
  userTapAdvance: (cell, _lock, op, now) => {
    const index = indexOfKey(cell.waypoints, op.toHeadKey);
    if (index < 0) return noop(cell);
    const anchorPatch: Partial<ProgressCell> = {
      currentLegAnchor: op.anchor,
      legBoardingEligibleAt: now,
      ...LEG_STATE_CLEARED,
    };
    if (index === 0) {
      return sameAnchor(cell.currentLegAnchor, op.anchor) ? noop(cell) : applied(cell, op, now, anchorPatch, false);
    }
    return applied(cell, op, now, { waypoints: cell.waypoints.slice(index), ...anchorPatch }, true);
  },

  setLegAnchor: (cell, _lock, op, now) => {
    if (sameAnchor(cell.currentLegAnchor, op.anchor) && cell.legBoardingEligibleAt === op.eligibleAt) return noop(cell);
    return applied(
      cell,
      op,
      now,
      {
        currentLegAnchor: op.anchor,
        legBoardingEligibleAt: op.eligibleAt,
        ...LEG_STATE_CLEARED,
        // #2708 — leg-1 origin anchor(promptDisplay)가 새 leg에서 되살아나지 않게 같은 자리에서 지운다.
        promptDisplay: undefined,
      },
      false,
    );
  },

  // waypoints만 되감지 않는다 — head와 lock rev가 모두 맞을 때만 waypoints + segment를 한 번에 바꾼다.
  reanchor: (cell, lock, op, now) => {
    if (progressHeadKey(cell) !== op.expectedHeadKey) return conflict(cell);
    const lockResult = applyLockOp(
      lock,
      { type: 'setSegment', source: op.source, expectedRev: op.expectedLockRev, segmentStations: op.segmentStations },
      now,
    );
    if (lockResult.outcome !== 'applied') return conflict(cell);
    return applied(cell, op, now, { waypoints: op.waypoints }, true, lockResult);
  },

  // sync 수동 목록 탭 승격(§3 #7): lock 부착이 applied일 때만 건너뛴 구간을 전진한다(셀이 이미 가진 lock이 이긴다).
  attachWithFastForward: (cell, lock, op, now) => {
    const lockResult = applyLockOp(
      lock,
      { type: 'attachIfNone', source: op.source, lock: op.lock, authority: 'user', expectedRev: op.expectedLockRev },
      now,
    );
    if (lockResult.outcome !== 'applied') return { outcome: lockResult.outcome === 'noop' ? 'noop' : 'conflict', cell, lock: lockResult };
    const index = progressHeadKey(cell) === op.expectedHeadKey ? Math.min(op.skip, Math.max(0, cell.waypoints.length - 1)) : 0;
    const patch: Partial<ProgressCell> = {
      waypoints: index > 0 ? cell.waypoints.slice(index) : cell.waypoints,
      ...HEAD_STAMPS_CLEARED,
    };
    return applied(cell, op, now, patch, index > 0, lockResult);
  },

  stampProgress: (cell, _lock, op, now) => {
    const set = op.set ?? {};
    const clear = op.clear ?? [];
    const touched = new Set<string>([...Object.keys(set), ...clear]);
    if (HEAD_SCOPED_STAMPS.some((key) => touched.has(key)) && progressHeadKey(cell) !== op.expectedHeadKey) return noop(cell);
    const patch: Partial<ProgressCell> = {};
    for (const key of clear) patch[key] = undefined;
    for (const [key, value] of Object.entries(set) as [ProgressStampKey, unknown][]) {
      if (key === 'transferObservedAt') {
        const incoming = value as ProgressStamps['transferObservedAt'];
        const current = cell.transferObservedAt;
        // forward-only: 더 오래된 관측으로 덮지 않는다.
        if (incoming !== undefined && current !== undefined && incoming.atMs < current.atMs) continue;
      }
      (patch as Record<string, unknown>)[key] = value;
    }
    const changed = Object.entries(patch).some(([key, value]) => !sameValue(cell[key as keyof ProgressCell], value));
    return changed ? applied(cell, op, now, patch, false) : noop(cell);
  },
};

/**
 * 진행 셀 op 적용. `lock`은 같은 DO의 lock 셀(결합 op용) — 없으면 빈 셀로 취급해 결합 op가 conflict/noop으로 떨어진다.
 */
export function applyProgressOp(cell: ProgressCell, lock: LockCell | null, op: ProgressOp, now: number): ProgressOpResult {
  const handler = HANDLERS[op.type] as (c: ProgressCell, l: LockCell, o: ProgressOp, n: number) => ProgressOpResult;
  return handler(cell, lock ?? emptyLockCell(), op, now);
}

/** 셀의 진행 필드를 메모리 trip에 반영한다(함수형 — 입력 trip 불변). */
export function applyProgressCell(trip: Trip, cell: ProgressCell): Trip {
  const {
    waypoints,
    routeWaypoints,
    currentLegAnchor,
    legBoardingEligibleAt,
    legBoardingPromptState,
    legResolveStreak,
    promptDisplay,
    transferObservedAt,
    lastTrackedArrivalEpoch,
    lastLaPushEpoch,
    lastLaPushAt,
  } = cell;
  return {
    ...trip,
    waypoints,
    routeWaypoints,
    currentLegAnchor,
    legBoardingEligibleAt,
    legBoardingPromptState,
    legResolveStreak,
    promptDisplay,
    transferObservedAt,
    lastTrackedArrivalEpoch,
    lastLaPushEpoch,
    lastLaPushAt,
  };
}
