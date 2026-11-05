/**
 * #3036 PR-3c — 출발역 arrival 조회 스케줄 순수 함수. 스펙(계획 §14.3 + 적용 결정 LEAD=120s):
 * 다음 조회 시각 = 발사 cycle pool 중 "발사 열차가 아닌, 아직 도착 전(ETA > 0)" 열차의 가장 이른 도착 예정 - 120s.
 * 모르면(후보 없음/ETA null) undefined = 매 cycle 조회(현행). 120s 이내로 임박했으면 절감이 없으니 undefined.
 * 상한 = 발사 시각 + 15분.
 */
import { describe, expect, it } from 'vitest';
import {
  computeOriginNextLookupAt,
  isOriginArrivalLookupDeferred,
  ORIGIN_LOOKUP_DEFER_MAX_MS,
  ORIGIN_LOOKUP_RESUME_LEAD_MS,
} from '../boardingPrompt';

const NOW = 1_000_000_000_000;
const entry = (trainCode: string, arrivalSeconds: number | null) => ({ trainCode, arrivalSeconds });

describe('#3036 PR-3c computeOriginNextLookupAt', () => {
  it('상수: 재개 여유 120s(실측 198건 중 197건 커버), 상한 15분', () => {
    expect(ORIGIN_LOOKUP_RESUME_LEAD_MS).toBe(120_000);
    expect(ORIGIN_LOOKUP_DEFER_MAX_MS).toBe(15 * 60_000);
  });

  it('발사 열차 제외 + 가장 이른 다음 열차 ETA - 120s', () => {
    const pool = [entry('7035', 0), entry('7039', 317), entry('7043', 677)];
    expect(computeOriginNextLookupAt(pool, { now: NOW, excludeTrainCodes: ['7035'] })).toBe(NOW + 317_000 - 120_000);
  });

  it('풀 순서와 무관하게 가장 이른 ETA를 고른다', () => {
    const pool = [entry('7043', 677), entry('7039', 317)];
    expect(computeOriginNextLookupAt(pool, { now: NOW, excludeTrainCodes: [] })).toBe(NOW + 197_000);
  });

  it('ETA 모름(null)만 있으면 undefined — 매 cycle 조회', () => {
    expect(computeOriginNextLookupAt([entry('7039', null)], { now: NOW, excludeTrainCodes: [] })).toBeUndefined();
  });

  it('null은 건너뛰고 ETA를 아는 다른 열차를 쓴다', () => {
    const pool = [entry('7039', null), entry('7043', 500)];
    expect(computeOriginNextLookupAt(pool, { now: NOW, excludeTrainCodes: [] })).toBe(NOW + 380_000);
  });

  it('후보가 발사 열차뿐이면 undefined', () => {
    expect(computeOriginNextLookupAt([entry('7035', 0)], { now: NOW, excludeTrainCodes: ['7035'] })).toBeUndefined();
  });

  it('이미 역에 있는(ETA 0) 다른 열차는 "다음 열차"가 아니다 — 무시', () => {
    const pool = [entry('7031', 0), entry('7039', 400)];
    expect(computeOriginNextLookupAt(pool, { now: NOW, excludeTrainCodes: ['7035'] })).toBe(NOW + 280_000);
  });

  it('ETA <= 120s면 절감이 없어 undefined(경계: 120s)', () => {
    expect(computeOriginNextLookupAt([entry('7039', 120)], { now: NOW, excludeTrainCodes: [] })).toBeUndefined();
    expect(computeOriginNextLookupAt([entry('7039', 100)], { now: NOW, excludeTrainCodes: [] })).toBeUndefined();
    expect(computeOriginNextLookupAt([entry('7039', 121)], { now: NOW, excludeTrainCodes: [] })).toBe(NOW + 1_000);
  });

  it('상한: 발사 시각 + 15분을 넘기지 않는다', () => {
    expect(computeOriginNextLookupAt([entry('7039', 3600)], { now: NOW, excludeTrainCodes: [] })).toBe(NOW + 15 * 60_000);
  });

  it('빈 풀이면 undefined', () => {
    expect(computeOriginNextLookupAt([], { now: NOW, excludeTrainCodes: [] })).toBeUndefined();
  });
});

describe('#3036 PR-3c isOriginArrivalLookupDeferred', () => {
  it('저장값 없음 -> 보류 아님(현행: 매 cycle 조회)', () => {
    expect(isOriginArrivalLookupDeferred(undefined, NOW)).toBe(false);
  });
  it('now < 저장값 -> 보류, now >= 저장값 -> 재개', () => {
    expect(isOriginArrivalLookupDeferred(NOW + 1, NOW)).toBe(true);
    expect(isOriginArrivalLookupDeferred(NOW, NOW)).toBe(false);
    expect(isOriginArrivalLookupDeferred(NOW - 1, NOW)).toBe(false);
  });
});
