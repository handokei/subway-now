/**
 * #3055 PR-3b — replay 하네스 env에 TripDO fake namespace + flag를 심는 공용 helper.
 * flag `off`는 현행(DO 호출 0), `lock@N`은 셀 권위(cron 포함).
 */
import { resetCellStageCache } from '../../tripDoCells';
import { setTripDoFlag } from '../../tripDoFlag';
import type { Env } from '../../types';
import { makeFakeTripDoNamespace } from './fakeTripDoNamespace';

export type LockCellFlag = 'off' | `lock@${number}`;

export interface LockCellReplayEnv {
  doNs: ReturnType<typeof makeFakeTripDoNamespace>;
  /** beforeTick 첫 tick에서 한 번 호출한다(KV에 flag를 쓰고 env에 DO를 바인딩). `ns`로 감싼 namespace를 대신 바인딩할 수 있다. */
  install: (env: Env, kv: KVNamespace, ns?: DurableObjectNamespace) => Promise<void>;
}

export interface DoRequestInfo {
  method: string;
  path: string;
  /** POST body(JSON) — `/lock/op`의 `{ op, now }` 등. */
  body?: { op?: { type: string }; now?: number };
}

/**
 * TripDO namespace를 감싸 요청 전/후에 끼어들 수 있게 한다(읽기-쓰기 사이 "사용자 행위" 주입).
 * 훅 안의 DO 호출은 **감싸지 않은** 원본 namespace로 해야 재귀하지 않는다.
 */
export function interceptTripDo(
  ns: DurableObjectNamespace,
  hooks: { before?: (info: DoRequestInfo) => Promise<void>; after?: (info: DoRequestInfo) => Promise<void> },
): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ns.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = ns.get(id);
      return {
        fetch: async (request: Request): Promise<Response> => {
          const info: DoRequestInfo = {
            method: request.method,
            path: new URL(request.url).pathname,
            body: request.method === 'POST' ? ((await request.clone().json()) as DoRequestInfo['body']) : undefined,
          };
          await hooks.before?.(info);
          const response = await stub.fetch(request);
          await hooks.after?.(info);
          return response;
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

export function makeLockCellReplayEnv(flag: LockCellFlag): LockCellReplayEnv {
  const doNs = makeFakeTripDoNamespace();
  return {
    doNs,
    install: async (env, kv, ns = doNs.ns) => {
      await setTripDoFlag(kv, flag);
      resetCellStageCache(kv);
      (env as unknown as { TRIP_DO: DurableObjectNamespace }).TRIP_DO = ns;
    },
  };
}
