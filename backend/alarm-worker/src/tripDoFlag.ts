/**
 * TripDO shadow write Feature Flag (Phase 1, ADR-031 / 이슈 #2264, Epic #2260).
 *
 * ADR-031은 글로벌 cron O(N) 스캔을 per-trip Durable Object + self-alarm 이벤트 구동으로
 * 재설계한다. Phase 1은 `TripDO` scaffold만 배포하고 cron은 여전히 authoritative — DO는
 * shadow(no-op 기본)로 병존한다.
 *
 * 본 모듈은 `archFlag.ts`(#1982 ADR-022 Phase 0)와 동일한 KV read/write 어댑터 패턴을
 * 재사용한다. flag가 'off'(default)인 동안 `POST /trips`의 DO dual-write 경로는 완전히
 * no-op — 기존 cron/KV 동작 100% 유지(Phase 1-3 dormant).
 *
 * Rollback 정책: 낮은 단계/`off` KV write 만으로 즉시 되돌린다(배포 없음).
 *
 * #3300 PR-2: 값 영역을 `off | lock@N | progress@N | full@N`(N=epoch)로 확장했다.
 * 기존 `on`(Phase 1 shadow)은 폐기 — `off`로 정규화된다. `@N`은 재활성화마다 올려 셀 재시드를 강제한다
 * (off 기간 동안 KV에서만 일어난 변화를 낡은 DO 셀이 덮어 부활시키는 것을 막는다).
 */

/** TripDO flag KV 키. 값은 `off` 또는 `<stage>@<epoch>`. */
export const TRIP_DO_FLAG_KV_KEY = 'arch:trip-do-shadow-v1';

export type TripDoStage = 'off' | 'lock' | 'progress' | 'full';

export interface TripDoFlag {
  stage: TripDoStage;
  /** 재활성화 세대. 셀 `seededEpoch`와 비교해 재시드를 강제한다. off는 0. */
  epoch: number;
}

/** Default 값 — 미설정 KV / 오타 / legacy `on` / 파싱 실패 모두 이 값으로 fallback. */
export const TRIP_DO_FLAG_DEFAULT: TripDoFlag = { stage: 'off', epoch: 0 };

const STAGED_PATTERN = /^(lock|progress|full)@(\d+)$/;

/** 문자열을 flag로 파싱. 유효하지 않은 값(legacy `on` 포함)은 default(off). */
export function parseTripDoFlag(raw: unknown): TripDoFlag {
  if (typeof raw !== 'string') return TRIP_DO_FLAG_DEFAULT;
  const match = STAGED_PATTERN.exec(raw);
  if (!match) return TRIP_DO_FLAG_DEFAULT;
  const [, stage, epoch] = match;
  return { stage: stage as TripDoStage, epoch: Number(epoch) };
}

/** flag → KV 저장 문자열. */
export function formatTripDoFlag({ stage, epoch }: TripDoFlag): string {
  return stage === 'off' ? 'off' : `${stage}@${epoch}`;
}

/** KV 조회. kv 미바인딩 / 미설정 / 오타 / legacy `on` 은 모두 off. */
export async function getTripDoFlag(kv: KVNamespace | undefined): Promise<TripDoFlag> {
  if (!kv) return TRIP_DO_FLAG_DEFAULT;
  return parseTripDoFlag(await kv.get(TRIP_DO_FLAG_KV_KEY));
}

/**
 * 요청/cron tick 하나당 KV GET을 1회로 묶는 reader (cron subrequest 예산, plan §9).
 * 동시 호출도 같은 promise를 공유한다. KV 실패는 off(fail-closed)이며 그 결과도 캐시된다.
 */
export function createTripDoFlagReader(kv: KVNamespace | undefined): () => Promise<TripDoFlag> {
  let cached: Promise<TripDoFlag> | undefined;
  return () => {
    cached ??= getTripDoFlag(kv).catch(() => TRIP_DO_FLAG_DEFAULT);
    return cached;
  };
}

/**
 * 관리자용 flag 설정. 유효하지 않은 값(legacy `on` 포함)은 write 없이 throw.
 * TTL 없음: rollback 시 즉시 반영되어야 하므로 영구 저장.
 */
export async function setTripDoFlag(kv: KVNamespace, value: string): Promise<void> {
  if (value !== 'off' && !STAGED_PATTERN.test(value)) {
    throw new Error(`tripDoFlag: invalid value ${String(value)}`);
  }
  await kv.put(TRIP_DO_FLAG_KV_KEY, value);
}
