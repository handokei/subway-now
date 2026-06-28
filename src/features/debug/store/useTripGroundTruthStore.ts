/**
 * Trip ground truth (사용자 정답지) store — #1502 (M2, ADR-015 §10 P5).
 *
 * trip 종료 직후 사용자에게 자동으로 "이번 trip 알람 정확했어요? Yes/No" prompt를 노출하고
 * 응답을 누적한다. 응답은 backend로 forward되어 P0-3 telemetry payload(`user-feedback` 필드)에
 * 합류, M1 raw signal과 corrId 단위로 join되어 학습 라벨이 된다.
 *
 * 정책:
 *  - 매 trip 종료마다 자동 prompt (one-time opt-out X, manual toggle X — issue 본문)
 *  - 사용자 dismiss/skip은 'unanswered' 상태로 기록, 다음 trip 종료 시 또 노출
 *  - 응답 ring buffer 최대 RESPONSE_BUFFER_CAPACITY건 (오래된 응답부터 drop)
 *  - AsyncStorage 영속화 — 앱 강제종료/cold launch에도 pendingPrompt 살아남는다
 *
 * 본 store는 zustand 메모리 + AsyncStorage 양방향. hydrate는 app boot 시 1회.
 * 모든 storage 작업 graceful — 실패는 측정에만 영향, trip 흐름 무관.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { TRIP_GROUND_TRUTH_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
// #1957 (#1503 잔여 1/3) — M2 정답지 응답을 alarmLog로 stamp해 P0-3 forward → R2 archive →
// backend alarmLogStats.groundTruthCounts 누적 → observabilityMetrics.algorithmAccuracyRatio.
// debug 슬라이스의 정답지 응답 1건이 backend 정확도 metric의 원천 신호. cross-feature wire이지만
// OperationDashboardSection.tsx 패턴과 동일하게 alarm/utils import 사용.
import { logGroundTruthResult } from '../../alarm/utils/alarmLog';

const logger = createLogger('tripGroundTruth');

/**
 * 응답 outcome.
 * - 'accurate' : 사용자 "이번 trip 알람 정확했어요" 응답 (option A "좋았어요")
 * - 'inaccurate' : 사용자 "틀린 알람이 있었어요" 응답 (false positive 또는 miss)
 * - 'unanswered' : prompt dismiss 또는 다음 trip 시작으로 자동 만료
 */
export type TripGroundTruthOutcome = 'accurate' | 'inaccurate' | 'unanswered';

export interface TripGroundTruthResponse {
  corrId: string;
  endedAt: number;
  respondedAt: number;
  outcome: TripGroundTruthOutcome;
}

export interface TripGroundTruthPendingPrompt {
  corrId: string;
  endedAt: number;
}

export interface TripGroundTruthState {
  hydrated: boolean;
  pendingPrompt: TripGroundTruthPendingPrompt | null;
  responses: TripGroundTruthResponse[];
  /**
   * trip 종료 시 호출 — pending prompt 등록. 이미 pending이 있으면 (이전 trip 미응답)
   * 'unanswered'로 응답에 합류하고 새 prompt로 교체.
   */
  enqueuePrompt: (prompt: TripGroundTruthPendingPrompt) => Promise<void>;
  /**
   * 사용자 응답 — pending prompt를 responses에 합류하고 pending=null.
   * pendingPrompt 부재 시 graceful no-op (race 안전).
   */
  respond: (outcome: TripGroundTruthOutcome) => Promise<void>;
  /** AsyncStorage → memory hydrate. boot 1회. */
  hydrate: () => Promise<void>;
}

/**
 * 응답 ring buffer 최대 크기. P0-3 forward 1회 분량 + 잔여 backlog 보존을 고려해 50건.
 * forward 성공 후에도 직전 응답들은 DebugModal에서 다시 볼 수 있어야 사용자가 자기 응답
 * 이력을 확인 가능.
 */
export const RESPONSE_BUFFER_CAPACITY = 50;

interface PersistedShape {
  pendingPrompt: TripGroundTruthPendingPrompt | null;
  responses: TripGroundTruthResponse[];
}

async function persist(snapshot: PersistedShape): Promise<void> {
  try {
    await AsyncStorage.setItem(TRIP_GROUND_TRUTH_KEY, JSON.stringify(snapshot));
  } catch (e) {
    logger.warn('persist 실패 (graceful):', e);
  }
}

function trimResponses(responses: TripGroundTruthResponse[]): TripGroundTruthResponse[] {
  if (responses.length <= RESPONSE_BUFFER_CAPACITY) return responses;
  // 오래된 응답부터 drop.
  return responses.slice(responses.length - RESPONSE_BUFFER_CAPACITY);
}

export const useTripGroundTruthStore = create<TripGroundTruthState>((set, get) => ({
  hydrated: false,
  pendingPrompt: null,
  responses: [],

  enqueuePrompt: async (prompt) => {
    const { pendingPrompt, responses } = get();
    // 이전 prompt가 미응답이면 'unanswered'로 합류시키고 새 prompt 교체.
    let nextResponses = responses;
    if (pendingPrompt !== null) {
      nextResponses = trimResponses([
        ...responses,
        {
          corrId: pendingPrompt.corrId,
          endedAt: pendingPrompt.endedAt,
          respondedAt: prompt.endedAt,
          outcome: 'unanswered',
        },
      ]);
    }
    set({ pendingPrompt: prompt, responses: nextResponses });
    await persist({ pendingPrompt: prompt, responses: nextResponses });
  },

  respond: async (outcome) => {
    const { pendingPrompt, responses } = get();
    if (pendingPrompt === null) return;
    const nextResponses = trimResponses([
      ...responses,
      {
        corrId: pendingPrompt.corrId,
        endedAt: pendingPrompt.endedAt,
        respondedAt: Date.now(),
        outcome,
      },
    ]);
    set({ pendingPrompt: null, responses: nextResponses });
    await persist({ pendingPrompt: null, responses: nextResponses });
    // #1957 — 응답 1건을 alarmLog로 stamp해 backend algorithmAccuracyRatio metric의 원천 신호로
    // forward. AsyncStorage persist와 무관하게 best-effort (graceful, throw 없음).
    logGroundTruthResult({ corrId: pendingPrompt.corrId, outcome });
  },

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(TRIP_GROUND_TRUTH_KEY);
      if (raw === null) {
        set({ hydrated: true });
        return;
      }
      const parsed = JSON.parse(raw) as PersistedShape;
      set({
        hydrated: true,
        pendingPrompt: parsed.pendingPrompt ?? null,
        responses: Array.isArray(parsed.responses) ? parsed.responses : [],
      });
    } catch (e) {
      logger.warn('hydrate 실패 (graceful):', e);
      set({ hydrated: true });
    }
  },
}));

/**
 * P0-3 telemetry forward payload에 합류시키기 위한 read helper.
 * 직전 N건의 응답 또는 corrId 매칭 응답 1건을 반환 — caller가 결정.
 *
 * 본 helper는 store가 hydrate되지 않은 상태에서도 동기적으로 메모리 snapshot을 읽는다 —
 * boot 직후 호출되면 빈 배열 (graceful).
 */
export function getResponsesForCorrId(corrId: string): TripGroundTruthResponse[] {
  const { responses } = useTripGroundTruthStore.getState();
  return responses.filter((r) => r.corrId === corrId);
}

/** 직전 N건 응답 (telemetry payload 보강용). */
export function getRecentResponses(limit: number): TripGroundTruthResponse[] {
  const { responses } = useTripGroundTruthStore.getState();
  if (limit <= 0) return [];
  return responses.slice(-limit);
}
