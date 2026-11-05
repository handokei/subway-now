/**
 * #3055 / #3300 옵션 D PR-4b — 진행 셀(waypoints 계열) 쪽 cron·HTTP 공용 클라이언트.
 *
 * `cronLockCell.ts`가 lock/LA 셀을 다루듯, 이 모듈은 **진행 셀 op**를 호출하고 결과를 메모리 trip에 반영한다. 같은 함수가
 *  - cron tick 안의 trip(`cronTickOf` — 예산 `CRON_DO_CALL_BUDGET`을 lock/LA op와 공유, 실패는 `skipped` fail-closed)과
 *  - HTTP 핸들러가 가진 trip(tick 없음 — flag를 직접 읽고, 실패는 `CellUnavailableError`로 던져 503)
 * 둘 다 처리한다. 단계(`progress@N` 미만: off / lock@N)에서는 항상 `legacy`를 돌려줘 호출자가 현행 직접 대입 경로를 그대로 탄다
 * (롤백 `lock@N`이면 progress KV 맞춤 경로가 그대로 살아난다).
 *
 * 진행 스탬프(`lastLaPush*`·`lastTrackedArrivalEpoch`·`legResolveStreak`·`legBoardingPromptState`)는 매 tick 여러 곳에서 생기므로
 * `stampProgressFields`(동기, 메모리 즉시 반영 + tick 버퍼)로 모아 `flushProgressStamps`가 trip당 한 번 op로 영속한다(DO 호출 예산 절약).
 */
import { cronTickOf, type StampChange } from './cronLockCell';
import { hashTripToken } from './sentry';
import { HEAD_SCOPED_STAMPS, progressHeadKey, type ProgressOp, type ProgressOpResult, type ProgressStampKey, type ProgressStamps } from './progressOps';
import { applyProgressResult, isProgressStage, readCellStage, runProgressOp } from './tripDoCells';
import { recordTripEvent } from './tripEventLog';
import type { Env, Trip } from './types';

export type ProgressCommit =
  | { mode: 'legacy' }
  | { mode: 'cell'; outcome: ProgressOpResult['outcome'] | 'skipped'; result?: ProgressOpResult };

/** 이 trip의 진행 변경이 셀 op로 가야 하는 cron 추적 trip인지(`progress@N` 이상 tick). */
export function isCronProgressTracked(trip: Trip): boolean {
  const tick = cronTickOf(trip);
  return tick !== undefined && isProgressStage(tick.flag);
}

/**
 * 진행 셀 op를 적용한다. `legacy`면 호출자가 현행 직접 대입을 한다. `cell`이면 `result`(applied/noop/conflict)가 셀의 최신 값이다.
 *  - cron 추적 trip: overlay가 셀 시야(`__progressRev`)를 못 얻었거나 DO 오류/예산 초과면 `skipped`(그 trip의 진행 변경 없음, fail-closed).
 *  - HTTP trip: DO 오류는 `CellUnavailableError`로 전파(핸들러가 503으로 매핑).
 * `apply:false`면 결과를 trip에 반영하지 않는다(호출자가 발사 등을 pre-change 스냅샷으로 끝낸 뒤 `applyProgressResult`로 직접 반영 — claim-then-fire).
 * lock 셀을 함께 건드린 op(`advanceHead.releaseLock`)는 해제/충돌을 D1 `lock-released`/`lock-op-conflict`로 남긴다(`commitCronLockOp`와 같은 행).
 */
export async function commitProgressOp(
  env: Env,
  trip: Trip,
  op: ProgressOp,
  now: number,
  options?: { apply?: boolean },
): Promise<ProgressCommit> {
  const tick = cronTickOf(trip);
  let target: Pick<Env, 'TRIPS' | 'TRIP_DO'> = env;
  if (tick) {
    if (!isProgressStage(tick.flag)) return { mode: 'legacy' };
    if (trip.__progressRev === undefined) return { mode: 'cell', outcome: 'skipped' };
    target = tick.env;
  } else if (!isProgressStage(await readCellStage(env))) {
    return { mode: 'legacy' };
  }
  let result: ProgressOpResult;
  try {
    result = await runProgressOp(target, trip.token, op, now);
  } catch (err) {
    if (tick) return { mode: 'cell', outcome: 'skipped' };
    throw err;
  }
  if (options?.apply !== false) Object.assign(trip, applyProgressResult(trip, result));
  const { lock } = result;
  if (op.type === 'advanceHead' && op.releaseLock !== undefined && lock !== undefined) {
    const tokenHash = hashTripToken(trip.token);
    if (lock.outcome === 'applied') {
      await recordTripEvent(env.DB, { tokenHash, kind: 'lock-released', meta: { reason: op.releaseLock.reason, source: op.source, rev: lock.cell.rev } }, now);
    } else if (lock.outcome === 'conflict' || lock.outcome === 'conflict-kept') {
      await recordTripEvent(env.DB, { tokenHash, kind: 'lock-op-conflict', meta: { op: 'releaseAuto', source: op.source } }, now);
    }
  }
  return { mode: 'cell', outcome: result.outcome, result };
}

/** 직접 쓰기를 막는 가드(`progressWriteGuard`)가 소유하는 메모리 반영 — trip 필드에 스탬프 변경을 그대로 적용한다. */
function applyStampInMemory(trip: Trip, { set, clear }: StampChange): void {
  const target = trip as unknown as Record<string, unknown>;
  // lock epoch 표식은 trip의 비영속 필드(`__progressLockEpoch`)로 보인다.
  const field = (key: string): string => (key === 'lockEpochKey' ? '__progressLockEpoch' : key);
  for (const key of clear ?? []) target[field(key)] = undefined;
  for (const [key, value] of Object.entries(set ?? {})) target[field(key)] = value;
}

const touchesHeadScope = ({ set, clear }: StampChange): boolean =>
  [...Object.keys(set ?? {}), ...(clear ?? [])].some((key) => (HEAD_SCOPED_STAMPS as readonly string[]).includes(key));

/**
 * 진행 스탬프를 trip에 즉시(메모리) 반영하고, 셀 단계의 cron 추적 trip이면 tick 버퍼에 쌓는다(`flushProgressStamps`가 tick 끝에 영속).
 * 동기 함수 — 기존 `trip.lastLaPushAt = now` 같은 대입 자리를 그대로 대체한다. head 스코프 필드는 이 시점의 head 키를 함께 기록해,
 * 그 사이 head가 전진했으면(= 이 스탬프가 무의미해졌으면) 셀이 noop으로 버린다.
 */
export function stampProgressFields(trip: Trip, change: Omit<StampChange, 'expectedHeadKey'>): void {
  const entry: StampChange = { ...change, ...(touchesHeadScope(change) ? { expectedHeadKey: progressHeadKey(trip) } : {}) };
  applyStampInMemory(trip, entry);
  const tick = cronTickOf(trip);
  if (!tick || !isProgressStage(tick.flag)) return;
  const entries = tick.stamps.get(trip) ?? [];
  entries.push(entry);
  tick.stamps.set(trip, entries);
}

/** 같은 head 키로 이어진 변경을 하나로 합친다(뒤의 값이 앞의 값을 덮는다). */
function mergeStampChanges(entries: StampChange[]): StampChange[] {
  const merged: StampChange[] = [];
  for (const entry of entries) {
    const last = merged.at(-1);
    if (last === undefined || last.expectedHeadKey !== entry.expectedHeadKey) {
      merged.push({ ...entry, set: { ...entry.set }, clear: [...(entry.clear ?? [])] });
      continue;
    }
    const set = { ...last.set } as Record<string, unknown>;
    let clear = [...(last.clear ?? [])] as ProgressStampKey[];
    for (const key of entry.clear ?? []) {
      delete set[key];
      if (!clear.includes(key)) clear.push(key);
    }
    for (const [key, value] of Object.entries(entry.set ?? {})) {
      set[key] = value;
      clear = clear.filter((c) => c !== key);
    }
    last.set = set as Partial<ProgressStamps>;
    last.clear = clear;
  }
  return merged;
}

/**
 * tick 끝: 쌓인 스탬프를 trip당 `stampProgress` op로 영속한다. 셀 시야(`__progressRev`)가 없거나(overlay 실패) 이번 tick에 종료된 trip은 건너뛴다.
 * DO 오류/예산 초과는 삼킨다 — 스탬프는 최적화 기준값(LA 중복 억제·추적 기준)이라 잃어도 다음 tick이 복구한다(예산은 `tick.skipped`로 계측된다).
 */
export async function flushProgressStamps(trips: Trip[], endedTokens: ReadonlySet<string> | undefined, now: number): Promise<void> {
  for (const trip of trips) {
    const tick = cronTickOf(trip);
    const entries = tick?.stamps.get(trip);
    if (!tick || !entries || entries.length === 0) continue;
    tick.stamps.delete(trip);
    if (trip.__progressRev === undefined || endedTokens?.has(trip.token) === true) continue;
    for (const change of mergeStampChanges(entries)) {
      try {
        await runProgressOp(tick.env, trip.token, { type: 'stampProgress', source: 'cron', ...change }, now);
      } catch {
        // 예산 초과/DO 오류 — 스탬프 유실은 fail-open(다음 tick 복구).
      }
    }
  }
}

/**
 * HTTP 핸들러용 — 진행 스탬프 변경을 **지금** op 한 번으로 영속하고 최신 셀 값을 반영한 trip을 돌려준다. `progress@N` 미만(off / lock@N)이면 trip을
 * 그대로 돌려준다(호출자가 이미 구성한 현행 메모리 값이 그대로 쓰인다). DO 오류는 `CellUnavailableError`로 전파(핸들러가 503).
 * head 스코프 필드를 건드리면 trip의 현재 head 키를 전제로 건다(그 사이 전진했으면 셀이 noop으로 버린다).
 */
export async function persistProgressStamps(
  env: Env,
  trip: Trip,
  source: string,
  change: Omit<StampChange, 'expectedHeadKey'>,
  now: number,
): Promise<Trip> {
  if (!isProgressStage(await readCellStage(env))) return trip;
  const op: ProgressOp = {
    type: 'stampProgress',
    source,
    ...change,
    ...(touchesHeadScope(change) ? { expectedHeadKey: progressHeadKey(trip) } : {}),
  };
  return applyProgressResult(trip, await runProgressOp(env, trip.token, op, now));
}

