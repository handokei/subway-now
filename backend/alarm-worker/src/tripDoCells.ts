/**
 * #3300 옵션 D PR-3a — Worker(HTTP) 쪽 TripDO 셀 클라이언트: flag 판정 / overlay / op 호출.
 *
 * flag(`arch:trip-do-shadow-v1`)가 `off`이거나 `env.TRIP_DO`가 없으면 **DO 호출 0**이다(현행 동작).
 * `lock@N` 이상이면 KV trip 위에 DO 셀(lock + LA)을 덮어 읽고, 쓰기는 op로만 한다.
 *
 * 실패 정책(plan §2):
 *  - overlay 읽기 실패 -> KV 값 그대로 + `__lockRev=undefined`. rev가 없으니 모든 auto op가 conflict -> lock 변경 0(fail-closed).
 *  - op 호출 실패 -> `CellUnavailableError` throw. HTTP 핸들러는 `app.onError`가 503 + Retry-After로 매핑한다.
 */
import { applyLaCell, type LaCell, type LaOp, type LaOpResult } from './laCellOps';
import { applyLockCell, type LockCell, type LockOp, type LockOpResult } from './lockOps';
import { getTripDoFlag, TRIP_DO_FLAG_DEFAULT, type TripDoFlag } from './tripDoFlag';
import type { Env, Trip } from './types';

/** flag 읽기 캐시 TTL — 요청마다 KV GET을 붙이지 않되 롤백(`off`)이 수 초 안에 반영되게 한다. */
const FLAG_CACHE_TTL_MS = 5_000;
const flagCache = new WeakMap<object, { at: number; flag: Promise<TripDoFlag> }>();

/** DO 셀 호출 실패(네트워크/eviction/비정상 응답). */
export class CellUnavailableError extends Error {
  constructor(
    readonly stage: string,
    readonly cause: unknown,
  ) {
    super(`TripDO cell unavailable at ${stage}`);
    this.name = 'CellUnavailableError';
  }
}

type CellEnv = Pick<Env, 'TRIPS' | 'TRIP_DO'>;

/**
 * 셀 권위가 켜져 있으면 그 flag를, 꺼져 있으면(off / TRIP_DO 미바인딩 / flag 읽기 실패) null.
 * `off`이면 이 함수 이후 DO 호출은 일절 없다.
 */
export async function readCellStage(env: CellEnv): Promise<TripDoFlag | null> {
  const { TRIP_DO: ns, TRIPS: kv } = env;
  if (!ns) return null;
  const now = Date.now();
  const cached = flagCache.get(kv);
  let entry = cached;
  if (!entry || now - entry.at >= FLAG_CACHE_TTL_MS) {
    entry = { at: now, flag: getTripDoFlag(kv).catch(() => TRIP_DO_FLAG_DEFAULT) };
    flagCache.set(kv, entry);
  }
  const flag = await entry.flag;
  return flag.stage === 'off' ? null : flag;
}

/** 테스트용 — flag 캐시를 비운다. */
export function resetCellStageCache(kv: object): void {
  flagCache.delete(kv);
}

function stubFor(env: CellEnv, token: string, stage: string): DurableObjectStub {
  const { TRIP_DO: ns } = env;
  if (!ns) throw new CellUnavailableError(stage, new Error('TRIP_DO not bound'));
  try {
    return ns.get(ns.idFromName(token));
  } catch (err) {
    throw new CellUnavailableError(stage, err);
  }
}

async function callJson<T>(stub: DurableObjectStub, stage: string, path: string, body?: unknown): Promise<T> {
  try {
    const res = await stub.fetch(
      new Request(`https://trip-do${path}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }),
    );
    if (!res.ok) throw new Error(`TripDO ${path} -> ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    throw new CellUnavailableError(stage, err);
  }
}

export interface Cells {
  lock: LockCell | null;
  la: LaCell | null;
}

export async function fetchCells(env: CellEnv, token: string): Promise<Cells> {
  return callJson<Cells>(stubFor(env, token, 'cells'), 'cells', '/cells');
}

/** lock 셀 1개만 읽는다(`GET /lock`) — cron의 발사 직전 fresh 확인용. 셀이 아직 없으면 null. */
export async function fetchLockCell(env: CellEnv, token: string): Promise<LockCell | null> {
  const { cell } = await callJson<{ cell: LockCell | null }>(stubFor(env, token, 'lock'), 'lock', '/lock');
  return cell;
}

/** lock 셀 op. 실패는 `CellUnavailableError`. */
export async function runLockOp(env: CellEnv, token: string, op: LockOp, now: number): Promise<LockOpResult> {
  return callJson<LockOpResult>(stubFor(env, token, `lock:${op.type}`), `lock:${op.type}`, '/lock/op', { op, now });
}

/** LA 셀 op. 실패는 `CellUnavailableError`. */
export async function runLaOp(env: CellEnv, token: string, op: LaOp, now: number): Promise<LaOpResult> {
  return callJson<LaOpResult>(stubFor(env, token, `la:${op.type}`), `la:${op.type}`, '/la/op', { op, now });
}

/** op 결과를 메모리 trip에 반영하고 같은 요청의 다음 op를 위한 rev를 갱신한다. */
export function applyLockResult(trip: Trip, result: LockOpResult): Trip {
  return { ...applyLockCell(trip, result.cell), __lockRev: result.cell.rev };
}

/**
 * 셀을 시드할지 — 셀 없음 / flag epoch 불일치 / KV trip이 셀 세션보다 **새 세션**일 때만.
 * KV 시야가 셀보다 오래됐으면(createdAt이 더 작음 = 60s 캐시의 낡은 읽기) 셀을 덮지 않는다.
 */
function needsSeed(cellCreatedAt: number | undefined, cellEpoch: number | undefined, tripCreatedAt: number, epoch: number): boolean {
  if (cellCreatedAt === undefined || cellEpoch === undefined) return true;
  return cellEpoch !== epoch || tripCreatedAt > cellCreatedAt;
}

/** KV trip 스냅샷으로 두 셀을 필요한 만큼 시드하고 최신 셀을 돌려준다. */
export async function seedCells(
  env: CellEnv,
  snapshot: Pick<
    Trip,
    | 'token'
    | 'createdAt'
    | 'boardingLock'
    | 'lockEverAttached'
    | 'consecutiveEtaMissing'
    | 'lockCodeHistory'
    | 'renumberSuccessor'
    | 'activityPushToken'
    | 'activityState'
  >,
  flag: TripDoFlag,
  now: number,
): Promise<{ lock: LockCell; la: LaCell }> {
  const { token, createdAt } = snapshot;
  const cells = await fetchCells(env, token);
  let { lock, la } = cells;
  const seeds: Promise<void>[] = [];
  if (!lock || needsSeed(lock.session.createdAt, lock.seededEpoch, createdAt, flag.epoch)) {
    seeds.push(
      runLockOp(
        env,
        token,
        {
          type: 'seedFromKv',
          source: 'overlay',
          epoch: flag.epoch,
          snapshot: {
            createdAt,
            lock: snapshot.boardingLock,
            everAttached: snapshot.lockEverAttached,
            consecutiveEtaMissing: snapshot.consecutiveEtaMissing,
            lockCodeHistory: snapshot.lockCodeHistory,
            renumberSuccessor: snapshot.renumberSuccessor,
          },
        },
        now,
      ).then((r) => {
        lock = r.cell;
      }),
    );
  }
  if (!la || needsSeed(la.session.createdAt, la.seededEpoch, createdAt, flag.epoch)) {
    seeds.push(
      runLaOp(
        env,
        token,
        {
          type: 'seedLaFromKv',
          source: 'overlay',
          epoch: flag.epoch,
          snapshot: { createdAt, activityPushToken: snapshot.activityPushToken, activityState: snapshot.activityState },
        },
        now,
      ).then((r) => {
        la = r.cell;
      }),
    );
  }
  await Promise.all(seeds);
  if (!lock || !la) throw new CellUnavailableError('seed', new Error('cell missing after seed'));
  return { lock, la };
}

/**
 * KV에서 읽은 trip 위에 DO 셀(lock + LA)을 덮고 `__lockRev`를 설정한다.
 * 셀 읽기 실패는 KV 값 그대로 + `__lockRev=undefined`(fail-closed).
 */
export async function overlayTripCells(env: CellEnv, trip: Trip, flag: TripDoFlag): Promise<Trip> {
  try {
    const { lock, la } = await seedCells(env, trip, flag, Date.now());
    return { ...applyLaCell(applyLockCell(trip, lock), la), __lockRev: lock.rev };
  } catch {
    return { ...trip, __lockRev: undefined };
  }
}
