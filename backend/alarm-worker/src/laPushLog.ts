/**
 * #2747 PR-2 — 여정 LA push 관측: D1 `trip_events` kind `la-push`.
 *
 * 질문: "backend가 LA를 언제, 어떤 내용으로 밀었는가" (device `la-write` D2/D3와 대조 — #2795 감시 쿼리는
 * `docs/agents/la-push-watch.md`). 모든 여정 LA push는 `fireLiveActivityUpdate`/`fireLiveActivityDismissal`
 * 한 곳을 지나므로 기록 지점도 거기 한 곳이다(호출 경로는 `LaPushPath`로 구분).
 *
 * 중복 억제: 같은 token_hash의 직전 `la-push` 행을 SELECT해 digest `(path, stationName, stopsRemaining,
 * etaMinutes 유무)`가 다를 때만 INSERT한다. 재등록으로 trip 필드가 사라져도(digest 불변) 행이 늘지 않는다.
 * KV write 0 — D1만 쓴다. D1 미바인딩/실패는 graceful(push 흐름을 막지 않는다).
 *
 * 탑승 LA start(`la-boarding-start`)는 별도 kind라 여기서 기록하지 않는다(중복 금지).
 */

import type { LiveActivityContentState } from './apns';
import { hashTripToken } from './sentry';
import { recordTripEvent } from './tripEventLog';

/** 여정 LA push 호출 경로(데이터 주도 — 신규 경로는 여기에만 추가). */
export type LaPushPath =
  /** `maybeFireLiveActivityUpdate` — ΔETA/heartbeat/즉시 trigger. */
  | 'update'
  /** `completeWaypointAdvance` — waypoint 통과 직후 새 hop 즉시 발사. */
  | 'advance'
  /** `trySendStationPassedAsLaUpdate` — split trip 매역 무음 update. */
  | 'station-passed'
  /** `firePromptLaAlert`의 non-split 폴백 — 질문 alert를 여정 LA update로 전달. */
  | 'prompt-alert'
  /** `fireLiveActivityDismissal` — event=end. */
  | 'end';

/** 직전 행과 비교하는 digest. `hasEta`는 etaMinutes 값이 아니라 유무(값은 매 push 변동). */
export interface LaPushDigest {
  path: LaPushPath;
  stationName: string | null;
  stopsRemaining: number | null;
  hasEta: boolean;
}

export function buildLaPushDigest(path: LaPushPath, contentState: Partial<LiveActivityContentState>): LaPushDigest {
  const { stationName, stopsRemaining, etaMinutes } = contentState;
  return {
    path,
    stationName: typeof stationName === 'string' ? stationName : null,
    stopsRemaining: typeof stopsRemaining === 'number' ? stopsRemaining : null,
    hasEta: etaMinutes !== undefined,
  };
}

function sameDigest(a: LaPushDigest, b: LaPushDigest): boolean {
  return (
    a.path === b.path &&
    a.stationName === b.stationName &&
    a.stopsRemaining === b.stopsRemaining &&
    a.hasEta === b.hasEta
  );
}

async function readPreviousDigest(db: D1Database, tokenHash: string): Promise<LaPushDigest | null> {
  const row = await db
    .prepare("SELECT meta FROM trip_events WHERE token_hash = ? AND kind = 'la-push' ORDER BY ts DESC, id DESC LIMIT 1")
    .bind(tokenHash)
    .first<{ meta: string | null }>();
  if (!row?.meta) return null;
  return JSON.parse(row.meta) as LaPushDigest;
}

export async function recordLaPushIfChanged(
  db: D1Database | undefined,
  input: { token: string; path: LaPushPath; contentState: Partial<LiveActivityContentState> },
  now: number,
): Promise<void> {
  if (!db) return;
  const { token, path, contentState } = input;
  const tokenHash = hashTripToken(token);
  const digest = buildLaPushDigest(path, contentState);
  try {
    const previous = await readPreviousDigest(db, tokenHash);
    if (previous && sameDigest(previous, digest)) return;
  } catch (e) {
    // SELECT 실패 시 중복 가능성을 감수하고 기록한다(관측 누락보다 낫다).
    console.warn(JSON.stringify({ msg: 'laPushLog read failed', err: String(e) }));
  }
  const { etaMinutes, lineName } = contentState;
  await recordTripEvent(
    db,
    {
      tokenHash,
      kind: 'la-push',
      station: digest.stationName ?? undefined,
      line: typeof lineName === 'string' ? lineName : undefined,
      meta: { ...digest, activity: 'journey', ...(etaMinutes === undefined ? {} : { etaMinutes }) },
    },
    now,
  );
}
