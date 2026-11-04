/**
 * #3300 옵션 D PR-3a (plan §10) — Live Activity 셀(`activityPushToken`·`activityState`)의 상태 연산.
 *
 * 11/04 실측: 17:24:56 `la-token-register`(저장) -> 17:25:13 `trip-register`(60s 캐시의 낡은 existing로 merge,
 * index.ts `activityPushToken: existing.activityPushToken`) -> 17:25:37 `la-token-register hadToken:false`.
 * 재등록의 통째 쓰기가 토큰을 지워 여정 LA push가 0건이었다. lock 셀(`lockOps.ts`)과 같은 방식으로 이 두 필드를
 * DO 셀로 옮기고, 변경은 이름 붙은 op로만 한다 — 낡은 시야의 통째 쓰기는 셀 값을 덮지 못한다.
 *
 * 순수 함수만 둔다(DO/KV 연결 없음). 스펙: tasks/plan-2026-11-03-trip-do-field-cas.md §10.
 * (cron의 token-invalid clear 연결은 PR-3b — `clearLaToken`은 그때 `expectedToken`으로 새 토큰을 보호한다.)
 */
import type { Trip } from './types';

export interface LaCell {
  /** 세션 신원 — `seedLaFromKv`가 KV trip의 createdAt으로 맞춘다. */
  session: { createdAt: number };
  /** 토큰/상태가 바뀔 때마다 +1(관측용). */
  rev: number;
  activityPushToken?: string;
  activityState?: Trip['activityState'];
  /** seedLaFromKv가 마지막으로 반영한 flag epoch. */
  seededEpoch: number;
  last: { op: LaOp['type'] | 'init'; source: string; at: number };
}

export type LaOpOutcome = 'applied' | 'noop';

export interface LaOpResult {
  outcome: LaOpOutcome;
  cell: LaCell;
}

interface LaOpBase {
  /** 호출 경로 식별(la-register / la-delete / cron-token-invalid ...) — cell.last와 관측용. */
  source: string;
}

export interface RegisterLaTokenOp extends LaOpBase {
  type: 'registerLaToken';
  token: string;
}
export interface ClearLaTokenOp extends LaOpBase {
  type: 'clearLaToken';
  reason: string;
  /** 지정되면 셀의 토큰이 이 값과 같을 때만 지운다(그 사이 새 토큰이 등록됐으면 보호). */
  expectedToken?: string;
}
export interface SetLaStateOp extends LaOpBase {
  type: 'setLaState';
  state: NonNullable<Trip['activityState']>;
}
export interface SeedLaFromKvOp extends LaOpBase {
  type: 'seedLaFromKv';
  snapshot: { createdAt: number; activityPushToken?: string; activityState?: Trip['activityState'] };
  epoch: number;
}

export type LaOp = RegisterLaTokenOp | ClearLaTokenOp | SetLaStateOp | SeedLaFromKvOp;

export function emptyLaCell(): LaCell {
  return {
    session: { createdAt: 0 },
    rev: 0,
    seededEpoch: -1,
    last: { op: 'init', source: 'init', at: 0 },
  };
}

const noop = (cell: LaCell): LaOpResult => ({ outcome: 'noop', cell });

function applied(cell: LaCell, op: LaOp, now: number, patch: Partial<LaCell>): LaOpResult {
  return {
    outcome: 'applied',
    cell: { ...cell, ...patch, rev: cell.rev + 1, last: { op: op.type, source: op.source, at: now } },
  };
}

type Handlers = {
  [K in LaOp['type']]: (cell: LaCell, op: Extract<LaOp, { type: K }>, now: number) => LaOpResult;
};

const HANDLERS: Handlers = {
  registerLaToken: (cell, op, now) =>
    cell.activityPushToken === op.token && cell.activityState === 'live'
      ? noop(cell)
      : applied(cell, op, now, { activityPushToken: op.token, activityState: 'live' }),

  // `DELETE /live-activity`·cron token-invalid 모두 token을 비우고 state='ended'를 남긴다(dismissal dedup 키).
  clearLaToken: (cell, op, now) => {
    if (op.expectedToken !== undefined && cell.activityPushToken !== op.expectedToken) return noop(cell);
    if (cell.activityPushToken === undefined && cell.activityState === 'ended') return noop(cell);
    return applied(cell, op, now, { activityPushToken: undefined, activityState: 'ended' });
  },

  setLaState: (cell, op, now) =>
    cell.activityState === op.state ? noop(cell) : applied(cell, op, now, { activityState: op.state }),

  seedLaFromKv: (cell, op, now) => {
    const { snapshot, epoch } = op;
    if (cell.session.createdAt === snapshot.createdAt && cell.seededEpoch === epoch) return noop(cell);
    return applied(cell, op, now, {
      session: { createdAt: snapshot.createdAt },
      activityPushToken: snapshot.activityPushToken,
      activityState: snapshot.activityState,
      seededEpoch: epoch,
    });
  },
};

export function applyLaOp(cell: LaCell, op: LaOp, now: number): LaOpResult {
  const handler = HANDLERS[op.type] as (c: LaCell, o: LaOp, n: number) => LaOpResult;
  return handler(cell, op, now);
}

/** 셀의 LA 필드를 메모리 trip에 반영한다(함수형 — 입력 trip 불변). */
export function applyLaCell(trip: Trip, cell: LaCell): Trip {
  return { ...trip, activityPushToken: cell.activityPushToken, activityState: cell.activityState };
}
