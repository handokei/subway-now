/**
 * #3055 / #3300 옵션 D PR-3b — cron(`scheduled.ts`) 쪽 lock/LA 셀 클라이언트.
 *
 * cron은 tick 시작에 읽은 trip 스냅샷으로 lock을 바꾼다(vanish swap / 강등 / 환승 해제 / 부착 …). 그 사이 사용자가 부착한 lock을
 * 낡은 시야로 덮거나(해제) 그 lock이 있는 줄 모르고 질문을 발사하던 것이 11/03 lock 소실의 cron 쪽 경로다. 이 모듈은
 *  - tick 시작에 trip들을 DO 셀로 overlay하고(`overlayCronTrips`, `__lockRev` 설정, stale-line lock은 `releaseAuto`로 영속),
 *  - lock 변경을 op(`commitCronLockOp`)로 최신 셀에 적용하며 결과를 **같은 trip 객체에 in-place** 반영하고(scheduled.ts 계약),
 *  - 발사 직전 셀을 1회 다시 읽어(`freshLockActive`) tick 스냅샷 창을 닫는다.
 *
 * 실패 정책(plan §2·§9): DO 오류 / `__lockRev` 없음 / tick 호출 예산 초과는 모두 `skipped` — 그 trip의 lock은 이번 tick 변경하지
 * 않는다(fail-closed). flag off(`beginCronCellTick` null)이거나 tick이 추적하지 않는 trip(HTTP 사본 등)은 `legacy` — 호출자가
 * 현행 직접 대입 경로를 그대로 탄다.
 *
 * tick 안 DO 호출 수는 `CRON_DO_CALL_BUDGET`으로 센다: Worker -> DO fetch가 Free 플랜 subrequest 한도(호출당 50)에 포함되는지가
 * 미확인(plan §8-1)이라 포함된다고 가정하고, 고정 호출(~10+)을 뺀 값으로 제한한다. 예산은 DO 경계(namespace 래퍼)에서 일괄 강제해
 * overlay·op·fresh 확인·endSession이 같은 카운터를 쓴다.
 */
import { applyLaCell, type LaOpResult } from './laCellOps';
import type { ProgressBaseline } from './progress';
import type { StampProgressOp } from './progressOps';
import { applyLockCell, type LockOp, type LockOpOutcome } from './lockOps';
import {
  applyLockResult,
  fetchLockCell,
  overlayTripCells,
  readCellStage,
  runLaOp,
  runLockOp,
} from './tripDoCells';
import type { TripDoFlag } from './tripDoFlag';
import { hashTripToken } from './sentry';
import { recordTripEvent } from './tripEventLog';
import { isStaleBoardingLock } from './trips';
import type { Env, Trip } from './types';

/** tick 하나에서 허용하는 Worker -> DO 호출 수(overlay + op + fresh 확인 + endSession 합계). Free 한도 50 − 고정 호출분. */
export const CRON_DO_CALL_BUDGET = 24;

type CellEnv = Pick<Env, 'TRIPS' | 'TRIP_DO'>;

export interface CronCellTick {
  flag: TripDoFlag;
  /** 호출 수를 세는 DO namespace를 가진 env — 이 tick의 모든 셀 호출은 이것을 거친다. */
  env: CellEnv;
  db: D1Database | undefined;
  budget: number;
  /** 지금까지 DO로 나간 요청 수. */
  calls: number;
  /** 예산 초과/오류로 건너뛴 호출 수. */
  skipped: number;
  /** tick 안에서 쌓인 진행 스탬프(`stampProgressFields`) — tick 끝에 trip당 한 번 flush한다(`cronProgressCell.flushProgressStamps`). */
  stamps: Map<Trip, StampChange[]>;
}

/** 진행 스탬프 변경 1건 — `StampProgressOp`에서 식별자(type/source)를 뺀 것. */
export type StampChange = Omit<StampProgressOp, 'type' | 'source'>;

const trackedTrips = new WeakMap<Trip, CronCellTick>();

/** cron이 의미 있는 lock op — `expectedRev`는 trip의 `__lockRev`로 채운다. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type CronLockOpInput = DistributiveOmit<
  Extract<LockOp, { type: 'attachIfNone' | 'releaseAuto' | 'swapAuto' | 'setSegment' | 'setEtaMissing' }>,
  'expectedRev'
>;

export type CronLockCommit = { mode: 'legacy' } | { mode: 'cell'; outcome: LockOpOutcome | 'skipped' };

function budgetedEnv(env: CellEnv, tick: Pick<CronCellTick, 'budget' | 'calls' | 'skipped'>): CellEnv {
  const { TRIP_DO: ns } = env;
  const counted = {
    idFromName: (name: string) => (ns as DurableObjectNamespace).idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = (ns as DurableObjectNamespace).get(id);
      return {
        fetch: (request: Request): Promise<Response> => {
          if (tick.calls >= tick.budget) {
            tick.skipped += 1;
            return Promise.reject(new Error('cron DO call budget exhausted'));
          }
          tick.calls += 1;
          return stub.fetch(request);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { TRIPS: env.TRIPS, TRIP_DO: counted };
}

/**
 * tick 시작 — flag를 한 번 읽고(5초 캐시) 셀 권위가 켜져 있으면 tick 상태를 만든다. off / TRIP_DO 미바인딩 / flag 읽기 실패는 null(현행 경로).
 */
export async function beginCronCellTick(env: Env, options?: { budget?: number }): Promise<CronCellTick | null> {
  const flag = await readCellStage(env);
  if (!flag) return null;
  const tick: CronCellTick = {
    flag,
    env: env,
    db: env.DB,
    budget: options?.budget ?? CRON_DO_CALL_BUDGET,
    calls: 0,
    skipped: 0,
    stamps: new Map(),
  };
  tick.env = budgetedEnv(env, tick);
  return tick;
}

/** trip이 속한 cron tick(없으면 undefined — HTTP 사본 / flag off). 진행 셀 클라이언트(`cronProgressCell.ts`)가 같은 예산·flag를 공유한다. */
export const cronTickOf = (trip: Trip): CronCellTick | undefined => trackedTrips.get(trip);

/** trip이 이 tick에서 셀 모드로 추적되는지(= scheduled.ts가 직접 대입 대신 op를 써야 하는지). */
export const isCronCellTracked = (trip: Trip): boolean => trackedTrips.has(trip);

/**
 * trips를 셀로 overlay하고 tick에 등록한다. 반환 배열의 trip 객체가 cron 루프가 in-place로 바꾸는 객체다.
 * overlay 실패(DO 오류/예산 초과)한 trip은 `__lockRev`가 없어 이후 op가 전부 skipped가 된다(fail-closed).
 * 순차 처리 — 병렬이면 예산이 어느 trip에 쓰였는지 비결정적이다.
 */
export async function overlayCronTrips(tick: CronCellTick, trips: Trip[], now: number): Promise<Trip[]> {
  const overlaid: Trip[] = [];
  for (const trip of trips) {
    const seen = await overlayTripCells(tick.env, trip, tick.flag);
    trackedTrips.set(seen, tick);
    // 현재 head 노선과 다른 lock(환승 시점에 끊긴 옛 leg lock, #1364 Layer 4)은 셀에서 풀어 영속한다.
    if (seen.__lockRev !== undefined && isStaleBoardingLock(seen)) {
      await commitCronLockOp(seen, { type: 'releaseAuto', source: 'cron', reason: 'stale-line' }, now);
    }
    overlaid.push(seen);
  }
  return overlaid;
}

/**
 * progress 맞춤 baseline에서 lock 셀이 권위인 필드(`consecutiveEtaMissing`)를 뺀다(§3 #21). 나머지(LA·추적 기준값)는 PR-4(진행 셀) 전까지
 * progress KV가 권위다.
 */
export function withoutCellOwnedBaseline(baseline: ProgressBaseline): Omit<ProgressBaseline, 'consecutiveEtaMissing'> {
  const { consecutiveEtaMissing: cellOwned, ...rest } = baseline;
  void cellOwned;
  return rest;
}

const CONFLICT_OUTCOMES: ReadonlySet<LockOpOutcome> = new Set(['conflict', 'conflict-kept']);

/**
 * lock 변경 op를 셀에 적용한다. 반환 `legacy`면 호출자가 현행 직접 대입을 수행하고, `cell`이면 trip에는 이미 셀의 결과가 반영돼 있다
 * (`outcome`이 `applied`일 때만 부수효과 — deleteProgress / 재확인 push / infoMode / 이벤트 — 를 실행해야 한다).
 */
export async function commitCronLockOp(trip: Trip, op: CronLockOpInput, now: number): Promise<CronLockCommit> {
  const tick = trackedTrips.get(trip);
  if (!tick) return { mode: 'legacy' };
  const { __lockRev: rev } = trip;
  if (rev === undefined) return { mode: 'cell', outcome: 'skipped' };
  let result;
  try {
    result = await runLockOp(tick.env, trip.token, { ...op, expectedRev: rev } as LockOp, now);
  } catch {
    return { mode: 'cell', outcome: 'skipped' };
  }
  // 셀이 권위 — applied가 아니어도(conflict/noop) 최신 셀 값을 trip에 반영해 이후 판정이 같은 시야를 보게 한다.
  Object.assign(trip, applyLockResult(trip, result));
  const { outcome, cell } = result;
  const { type: opType, source } = op;
  const tokenHash = hashTripToken(trip.token);
  if (outcome === 'applied' && op.type === 'releaseAuto') {
    await recordTripEvent(tick.db, { tokenHash, kind: 'lock-released', meta: { reason: op.reason, source, rev: cell.rev } }, now);
  } else if (CONFLICT_OUTCOMES.has(outcome)) {
    await recordTripEvent(tick.db, { tokenHash, kind: 'lock-op-conflict', meta: { op: opType, source } }, now);
  }
  return { mode: 'cell', outcome };
}

/**
 * 발사 직전 fresh 확인 — 셀(`GET /lock` 1회)에 활성 lock이 있으면 true(= 발사 보류). tick 스냅샷 이후 사용자가 붙인 lock을 본다.
 * 본 셀 값은 trip에도 반영한다. 추적 안 되는 trip(flag off)은 false. DO 오류/예산 초과는 fail-closed로 true.
 */
export async function freshLockActive(trip: Trip, now: number): Promise<boolean> {
  const tick = trackedTrips.get(trip);
  if (!tick) return false;
  let cell;
  try {
    cell = await fetchLockCell(tick.env, trip.token);
  } catch {
    return true;
  }
  if (cell === null) return false;
  Object.assign(trip, { ...applyLockCell(trip, cell), __lockRev: cell.rev });
  return cell.lock !== undefined && cell.lock.expiresAt > now;
}

/**
 * trip 종료 시 lock 셀 세션을 닫는다(`endSession`) — 같은 token의 다음 trip이 이전 세션의 lock/rev를 이어받지 않게 한다.
 * 추적 중이면 tick 예산을 쓰고, 아니면(HTTP 종료 등) flag를 직접 본다. best-effort: 오류는 삼킨다(정리 흐름을 막지 않는다).
 */
export async function endLockSession(env: Env, trip: Trip, source: string, now: number): Promise<void> {
  const tick = trackedTrips.get(trip);
  const flag = tick ? tick.flag : await readCellStage(env);
  if (!flag) return;
  try {
    await runLockOp(tick ? tick.env : env, trip.token, { type: 'endSession', source }, now);
  } catch {
    // 정리 흐름 우선 — 다음 세션의 seedFromKv(createdAt 불일치)가 셀을 다시 맞춘다.
  }
}

/**
 * cron이 APNs token-invalid로 trip의 LA 토큰을 메모리에서 비운 뒤 LA 셀에도 반영한다(§10). `expectedToken`으로 그 사이 새로 등록된
 * 토큰을 보호하고, 보호된 경우 trip에 셀의 현재 값을 되돌린다. 추적 안 되는 trip은 no-op(legacy).
 */
export async function clearLaTokenViaCell(trip: Trip, expectedToken: string, reason: string, now: number): Promise<void> {
  const tick = trackedTrips.get(trip);
  if (!tick) return;
  let result: LaOpResult;
  try {
    result = await runLaOp(
      tick.env,
      trip.token,
      { type: 'clearLaToken', source: 'cron-token-invalid', reason, expectedToken },
      now,
    );
  } catch {
    return;
  }
  Object.assign(trip, applyLaCell(trip, result.cell));
}
