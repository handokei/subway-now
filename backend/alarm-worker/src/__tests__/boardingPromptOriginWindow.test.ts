/**
 * #3036 (O3) — origin 탑승 질문 창 순수 함수 단위 테스트 (boardingPrompt.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  computeOriginPromptWindowStartAt,
  evaluateOriginPromptWindow,
  mergeOriginPromptWindow,
  ORIGIN_FIX_MAX_AGE_MS,
  ORIGIN_PROMPT_MAX_FIRES,
  ORIGIN_PROMPT_WALK_CAP_MS,
  ORIGIN_PROMPT_WINDOW_CAP_MS,
  ORIGIN_PROMPT_WINDOW_LEAD_MS,
  WALKING_SPEED_M_PER_S,
} from '../boardingPrompt';

const REG = 1_000_000_000;
const LIVE = { originAccuracyM: 20, originFixAgeMs: 30_000, originFixSource: 'gps-live' as const };

describe('computeOriginPromptWindowStartAt', () => {
  it('live fix: 등록 + (거리-정확도)/1.2m/s - 60s', () => {
    const startAt = computeOriginPromptWindowStartAt(REG, { ...LIVE, originDistanceM: 320 });
    expect(startAt).toBe(REG + (300 / WALKING_SPEED_M_PER_S) * 1000 - ORIGIN_PROMPT_WINDOW_LEAD_MS);
  });

  it('거리가 정확도보다 작으면 걷는 시간 0(음수 거리 금지)', () => {
    expect(computeOriginPromptWindowStartAt(REG, { ...LIVE, originDistanceM: 5 })).toBe(REG - ORIGIN_PROMPT_WINDOW_LEAD_MS);
  });

  it('걷는 시간은 15분 상한', () => {
    const startAt = computeOriginPromptWindowStartAt(REG, { ...LIVE, originDistanceM: 50_000 });
    expect(startAt).toBe(REG + ORIGIN_PROMPT_WALK_CAP_MS - ORIGIN_PROMPT_WINDOW_LEAD_MS);
  });

  it('fix 나이가 정확히 5분이면 아직 신뢰한다(경계 포함)', () => {
    const atBoundary = computeOriginPromptWindowStartAt(REG, { ...LIVE, originDistanceM: 2000, originFixAgeMs: ORIGIN_FIX_MAX_AGE_MS });
    expect(atBoundary).toBeGreaterThan(REG);
  });

  it.each([
    ['fix 나이 > 5분', { ...LIVE, originDistanceM: 2000, originFixAgeMs: ORIGIN_FIX_MAX_AGE_MS + 1 }],
    ['gps-last-known', { ...LIVE, originDistanceM: 2000, originFixSource: 'gps-last-known' as const }],
    ['출처 부재(구 클라)', { originDistanceM: 2000, originAccuracyM: 20, originFixAgeMs: 1000 }],
    ['나이 부재(구 클라)', { originDistanceM: 2000, originAccuracyM: 20, originFixSource: 'gps-live' as const }],
    ['정확도 부재', { originDistanceM: 2000, originFixAgeMs: 1000, originFixSource: 'gps-live' as const }],
    ['거리 부재', { ...LIVE }],
    ['geo 자체 없음(지하)', undefined],
  ])('%s -> 지연 없음', (_label, geo) => {
    expect(computeOriginPromptWindowStartAt(REG, geo)).toBe(REG - ORIGIN_PROMPT_WINDOW_LEAD_MS);
  });
});

describe('mergeOriginPromptWindow', () => {
  it('기존 창 없음 -> 새로 계산', () => {
    expect(mergeOriginPromptWindow(undefined, REG, undefined)).toEqual({ startAt: REG - ORIGIN_PROMPT_WINDOW_LEAD_MS });
  });

  it('신뢰할 수 없는 재등록은 기존 창을 그대로 둔다', () => {
    const existing = { startAt: REG + 500_000 };
    expect(mergeOriginPromptWindow(existing, REG + 1000, undefined)).toBe(existing);
  });

  it('더 가깝다는 live 증거는 창을 당긴다 / 더 멀면 늦추지 않는다 / closedAt은 보존', () => {
    const existing = { startAt: REG + 500_000, closedAt: REG + 9 };
    const pulled = mergeOriginPromptWindow(existing, REG, { ...LIVE, originDistanceM: 20 });
    expect(pulled).toEqual({ startAt: REG - ORIGIN_PROMPT_WINDOW_LEAD_MS, closedAt: REG + 9 });
    const notDelayed = mergeOriginPromptWindow(pulled, REG, { ...LIVE, originDistanceM: 5000 });
    expect(notDelayed.startAt).toBe(pulled.startAt);
  });
});

describe('evaluateOriginPromptWindow', () => {
  const window = { startAt: REG };
  it('시작 전 -> not-started', () => {
    expect(evaluateOriginPromptWindow({ window, now: REG - 1, fireCount: 0 })).toEqual({ open: false, reason: 'not-started', startAt: REG });
  });
  it('시작 시각 정각부터 열림', () => {
    expect(evaluateOriginPromptWindow({ window, now: REG, fireCount: 0 })).toEqual({ open: true });
  });
  it('발사 2회 소진 -> train-cap (1회는 열림)', () => {
    expect(evaluateOriginPromptWindow({ window, now: REG + 1, fireCount: ORIGIN_PROMPT_MAX_FIRES - 1 })).toEqual({ open: true });
    expect(evaluateOriginPromptWindow({ window, now: REG + 1, fireCount: ORIGIN_PROMPT_MAX_FIRES })).toEqual({ open: false, reason: 'train-cap', startAt: REG });
  });
  it('시작 후 15분 초과 -> expired (정확히 15분은 열림)', () => {
    expect(evaluateOriginPromptWindow({ window, now: REG + ORIGIN_PROMPT_WINDOW_CAP_MS, fireCount: 0 })).toEqual({ open: true });
    expect(evaluateOriginPromptWindow({ window, now: REG + ORIGIN_PROMPT_WINDOW_CAP_MS + 1, fireCount: 0 })).toEqual({ open: false, reason: 'expired', startAt: REG });
  });
  it('closedAt(떠남)이 모든 사유보다 우선하며 시간이 지나도 재개되지 않는다', () => {
    const closed = { startAt: REG, closedAt: REG + 10 };
    expect(evaluateOriginPromptWindow({ window: closed, now: REG + 20, fireCount: 0 })).toEqual({ open: false, reason: 'left-origin', startAt: REG });
    expect(evaluateOriginPromptWindow({ window: closed, now: REG - 5, fireCount: 5 })).toEqual({ open: false, reason: 'left-origin', startAt: REG });
  });
});
