/**
 * #3221 PR-3b — LA 버튼 `laCandidate`("LA에 보이는 열차") 검증.
 * 계획: tasks/plan-2026-11-02-la-button-train-refresh.md §3.2 v5/v6, 사용자 결정(2026-11-02) "보이는 열차 우선".
 *
 * 후보는 `prompt_fires`(cron 전용 append-only D1)로 검증한다 — trip 레코드 stamp는 재등록·KV 되돌림으로 소실돼 신뢰 불가(§2.2).
 * 판정 순서: 만료 -> 최신 발사 일치 -> 도착확정 -> 현재 leg anchor 정합 -> 진행도 가드 -> 3분 창.
 * 어느 단계든 실패하면 `rejected`(호출부는 현행 live 경로) — 읽기 실패도 fail-closed(잘못된 lock 금지).
 */
import { loadTrainPosition } from './anchorDeparturesQuery';
import {
  isArrivalConfirmedDecision,
  PROMPT_TRAIN_TRUST_WINDOW_MS,
  type BoardingFireDecision,
} from './boardingPrompt';
import { readLatestPromptFire } from './promptFires';
import type { BoardingLockMeta } from './types';

/** 후보 열차가 anchor에서 이 역수 이상 진행했으면 거부(10/21 F4 진행 가드 복원). */
export const LA_CANDIDATE_MAX_PROGRESS_STATIONS = 2;

export interface LaCandidate {
  trainCode: string;
  issuedAtMs: number;
}

/** body `laCandidate` 파싱. 형식 불량은 400이 아니라 무시(undefined) -> 현행 경로. */
export function parseLaCandidate(value: unknown): LaCandidate | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { trainCode, issuedAtMs } = value as Record<string, unknown>;
  if (typeof trainCode !== 'string' || trainCode.length === 0) return undefined;
  if (typeof issuedAtMs !== 'number' || !Number.isFinite(issuedAtMs)) return undefined;
  return { trainCode, issuedAtMs };
}

export type LaCandidateRejectReason =
  | 'expired'
  | 'no-fire-record'
  | 'stale-newer-prompt'
  | 'not-arrival-confirmed'
  | 'leg-mismatch'
  | 'progressed-past-anchor';

/** D1 `boarding-confirm-result` meta `laCandidateDecision` 값 집합. */
export type LaCandidateDecision =
  | LaCandidateRejectReason
  | 'accepted-trusted'
  | 'window-expired-live'
  | 'window-expired-candidate'
  | 'existing-lock';

export type LaCandidateVerdict =
  /** 3분 창 내 — live 없이 이 lock으로 확정. */
  | { kind: 'trusted'; lock: BoardingLockMeta }
  /** 3분 초과~TTL — live 먼저, live가 lock을 못 만들면 이 lock으로 fallback. */
  | { kind: 'fallback'; lock: BoardingLockMeta }
  | { kind: 'rejected'; reason: LaCandidateRejectReason };

export interface VerifyLaCandidateInput {
  candidate: LaCandidate;
  tokenHash: string;
  /** 탭 anchor 역/노선 코드. */
  station: string;
  line: string;
  now: number;
  /** 창 밖 fallback 한도(= RECENT_PROMPT_CANDIDATES_TTL_MS, index.ts 소유라 주입). */
  fallbackTtlMs: number;
  db: D1Database | undefined;
  kv: KVNamespace;
  /** 현재 leg anchor 정합 검증 + 합성 lock. 부적합이면 null. */
  buildLock: (trainCode: string) => BoardingLockMeta | null;
}

const reject = (reason: LaCandidateRejectReason): LaCandidateVerdict => ({ kind: 'rejected', reason });

/** 후보 열차가 anchor보다 `LA_CANDIDATE_MAX_PROGRESS_STATIONS`역 이상 앞서 있다는 증거가 스냅샷에 있는가. 스냅샷 없음 = false(수용). */
async function hasProgressedPastAnchor(
  input: VerifyLaCandidateInput,
  lock: BoardingLockMeta,
): Promise<boolean> {
  const { candidate, line, now, kv } = input;
  const { segmentStations } = lock;
  const { position, passedAnchor } = await loadTrainPosition(
    kv,
    candidate.trainCode,
    line,
    segmentStations,
    now,
  );
  if (!position) return false;
  const stationIdx = segmentStations.indexOf(position.stationName);
  // 구간 밖이면 앵커 출발 기록이 있을 때만 "지나갔다"의 증거다.
  if (stationIdx < 0) return passedAnchor;
  return stationIdx >= LA_CANDIDATE_MAX_PROGRESS_STATIONS;
}

export async function verifyLaCandidate(input: VerifyLaCandidateInput): Promise<LaCandidateVerdict> {
  const { candidate, tokenHash, station, line, now, fallbackTtlMs, db, buildLock } = input;
  const ageMs = now - candidate.issuedAtMs;
  if (ageMs > fallbackTtlMs) return reject('expired');

  const latest = await readLatestPromptFire(db, tokenHash, station, line);
  if (latest === null) return reject('no-fire-record');
  const isLatest = latest.trainCode === candidate.trainCode && latest.issuedAt === candidate.issuedAtMs;
  if (!isLatest) {
    // 사용자가 보던 LA가 갱신되기 전 탭 — 더 새 발사(다른 열차)가 이미 질문됐다. 후보가 기록에 없는 경우는 검증 불가.
    return reject(latest.issuedAt > candidate.issuedAtMs ? 'stale-newer-prompt' : 'no-fire-record');
  }
  if (!isArrivalConfirmedDecision(latest.decision as BoardingFireDecision['decision'])) {
    return reject('not-arrival-confirmed');
  }

  const lock = buildLock(candidate.trainCode);
  if (lock === null) return reject('leg-mismatch');
  if (await hasProgressedPastAnchor(input, lock)) return reject('progressed-past-anchor');

  return ageMs <= PROMPT_TRAIN_TRUST_WINDOW_MS ? { kind: 'trusted', lock } : { kind: 'fallback', lock };
}
