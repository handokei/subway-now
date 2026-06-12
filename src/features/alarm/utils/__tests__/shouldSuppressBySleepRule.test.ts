import { isStationPassedFirstHop, shouldSuppressBySleepRule } from '../shouldSuppressBySleepRule';
import type {
  SleepRuleEventType,
  SleepRuleInput,
} from '../shouldSuppressBySleepRule';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

// #750 — 공통 게이트 단위 테스트.
// 동일 규칙(="탑승/leg 시작 직후 첫 hop이 transfer/station-passed + sleep ON → suppress")이
// scheduler/FG/BG 3개 path에서 일관 적용되는지 검증한다.
// #1214 (Epic #1204 D8): station-passed 카테고리 추가 + lock=null(lockless trip) 적용.

const lock: BoardingLock = {
  destinationId: 'D1',
  trainCode: 'T-1',
  boardingStationId: 'S-BOARD',
  boardingLine: '2',
  boardedAt: 1_000_000,
  expectedDurationMs: 60_000,
};

// Sonar S1192 — input factory로 case별 boilerplate를 줄여 it.each 매트릭스 사용.
function makeInput(overrides: {
  lock?: BoardingLock | null;
  eventType: SleepRuleEventType;
  stationName?: string;
  sleepMode: boolean;
  isFirstHop: boolean;
}): SleepRuleInput {
  return {
    lock: overrides.lock === undefined ? lock : overrides.lock,
    event: {
      type: overrides.eventType,
      stationName: overrides.stationName ?? '교대',
    },
    sleepMode: overrides.sleepMode,
    isFirstHop: overrides.isFirstHop,
  };
}

describe('shouldSuppressBySleepRule', () => {
  describe('lock 활성', () => {
    it.each<[SleepRuleEventType, boolean]>([
      ['transfer', true],
      ['station-passed', true],
    ])(
      '%s + sleep ON + firstHop=true → suppress',
      (eventType, expected) => {
        expect(
          shouldSuppressBySleepRule(
            makeInput({ eventType, sleepMode: true, isFirstHop: true }),
          ),
        ).toBe(expected);
      },
    );

    it.each<SleepRuleEventType>(['transfer', 'station-passed'])(
      '%s + sleep ON + firstHop=false → fire (첫 hop 아님)',
      (eventType) => {
        expect(
          shouldSuppressBySleepRule(
            makeInput({ eventType, sleepMode: true, isFirstHop: false }),
          ),
        ).toBe(false);
      },
    );

    it('destination + sleep ON + firstHop=true → fire (도착 알람 보존)', () => {
      expect(
        shouldSuppressBySleepRule(
          makeInput({ eventType: 'destination', sleepMode: true, isFirstHop: true }),
        ),
      ).toBe(false);
    });

    it.each<SleepRuleEventType>(['transfer', 'station-passed', 'destination'])(
      '%s + sleep OFF → fire (sleep off면 모든 카테고리 통과)',
      (eventType) => {
        expect(
          shouldSuppressBySleepRule(
            makeInput({ eventType, sleepMode: false, isFirstHop: true }),
          ),
        ).toBe(false);
      },
    );
  });

  describe('lockless trip (lock=null, #1214)', () => {
    // 호출자(useStationAlarm / stationPipeline)가 lockless estimator hopIndex===0으로
    // isFirstHop을 계산해 전달한 케이스 — 22:11:56 사가정 회귀 차단(Epic #1204 §1 회귀 6).
    it('station-passed + sleep ON + lockless hopIndex=0 → suppress (✅ 사가정 회귀)', () => {
      expect(
        shouldSuppressBySleepRule(
          makeInput({
            lock: null,
            eventType: 'station-passed',
            stationName: '사가정',
            sleepMode: true,
            isFirstHop: true,
          }),
        ),
      ).toBe(true);
    });

    it('station-passed + sleep ON + lockless hopIndex≠0 → fire', () => {
      expect(
        shouldSuppressBySleepRule(
          makeInput({
            lock: null,
            eventType: 'station-passed',
            sleepMode: true,
            isFirstHop: false,
          }),
        ),
      ).toBe(false);
    });

    it('station-passed + sleep OFF → fire (sleep off면 통과)', () => {
      expect(
        shouldSuppressBySleepRule(
          makeInput({
            lock: null,
            eventType: 'station-passed',
            sleepMode: false,
            isFirstHop: true,
          }),
        ),
      ).toBe(false);
    });

    it('destination + sleep ON + lockless hopIndex=0 → fire (도착 알람 보존)', () => {
      expect(
        shouldSuppressBySleepRule(
          makeInput({
            lock: null,
            eventType: 'destination',
            sleepMode: true,
            isFirstHop: true,
          }),
        ),
      ).toBe(false);
    });

    it('transfer + sleep ON + lockless hopIndex=0 → suppress', () => {
      expect(
        shouldSuppressBySleepRule(
          makeInput({
            lock: null,
            eventType: 'transfer',
            sleepMode: true,
            isFirstHop: true,
          }),
        ),
      ).toBe(true);
    });
  });

  // #1236 (Epic #1204 D8 wire) — station-passed dispatch path 공통 isFirstHop 헬퍼.
  describe('isStationPassedFirstHop', () => {
    it.each<[string, BoardingLock | null, string, number | null | undefined, boolean]>([
      // [name, lock, candidateStationId, currentHopIndex, expected]
      ['lock 활성 + candidate=boardingStation → true', lock, 'S-BOARD', null, true],
      ['lock 활성 + candidate≠boardingStation → false', lock, 'S-OTHER', null, false],
      ['lock 활성 + candidate=boardingStation + hopIndex=3 → lock SSOT 우선 true', lock, 'S-BOARD', 3, true],
      ['lockless + hopIndex=0 → true', null, 'S-ANY', 0, true],
      ['lockless + hopIndex=3 → false (첫 hop 아님)', null, 'S-ANY', 3, false],
      ['lockless + hopIndex=null → false (SSOT 부재, graceful)', null, 'S-ANY', null, false],
      ['lockless + hopIndex=undefined → false (BG path 미전달, graceful)', null, 'S-ANY', undefined, false],
    ])('%s', (_, lockArg, candidateStationId, currentHopIndex, expected) => {
      expect(
        isStationPassedFirstHop({ lock: lockArg, candidateStationId, currentHopIndex }),
      ).toBe(expected);
    });
  });

  // SSOT: tasks/epic-lockless-recovery-2026-06-12.md §2 보고 #6
  // 회귀: 22:11:56 사가정 station-passed fire (취침 ON, lockless, 첫 환승 전).
  // 차단: D8 shouldSuppressBySleepRule (PR #1251, lockless 경로 적용).
  // 본 describe는 evidence 박제(#1259) — 위 'lockless trip' 매트릭스와 일부 겹치지만
  // 보고 #6 사용자 trip 재현 + D8 정책 boundary 명시를 위해 별도 유지.
  describe('사용자 trip 2026-06-12 회귀 가드 — D8 lockless station-passed (#1259)', () => {
    it('보고 #6 — 22:11:56 사가정 lockless station-passed fire 차단', () => {
      expect(
        shouldSuppressBySleepRule({
          lock: null,
          event: { type: 'station-passed', stationName: '사가정' },
          sleepMode: true,
          isFirstHop: true,
        }),
      ).toBe(true);
    });

    it.each<{
      label: string;
      lock: BoardingLock | null;
      eventType: SleepRuleEventType;
      sleepMode: boolean;
      isFirstHop: boolean;
      expected: boolean;
    }>([
      {
        label: 'lockless + sleep ON + firstHop + station-passed → suppress (보고 #6)',
        lock: null,
        eventType: 'station-passed',
        sleepMode: true,
        isFirstHop: true,
        expected: true,
      },
      {
        label: 'lockless + sleep ON + firstHop + transfer → suppress (D8 확장)',
        lock: null,
        eventType: 'transfer',
        sleepMode: true,
        isFirstHop: true,
        expected: true,
      },
      {
        label: 'lockless + sleep ON + firstHop + destination → fire (도착 보존)',
        lock: null,
        eventType: 'destination',
        sleepMode: true,
        isFirstHop: true,
        expected: false,
      },
      {
        label: 'lockless + sleep ON + NOT firstHop + station-passed → fire',
        lock: null,
        eventType: 'station-passed',
        sleepMode: true,
        isFirstHop: false,
        expected: false,
      },
      {
        label: 'lockless + sleep OFF + station-passed → fire',
        lock: null,
        eventType: 'station-passed',
        sleepMode: false,
        isFirstHop: true,
        expected: false,
      },
      {
        label: 'lockless + sleep OFF + transfer → fire',
        lock: null,
        eventType: 'transfer',
        sleepMode: false,
        isFirstHop: true,
        expected: false,
      },
      {
        label: 'lockless + sleep OFF + destination → fire',
        lock: null,
        eventType: 'destination',
        sleepMode: false,
        isFirstHop: true,
        expected: false,
      },
      {
        label: 'lock 활성 + sleep ON + firstHop + station-passed → suppress (D8 확장)',
        lock,
        eventType: 'station-passed',
        sleepMode: true,
        isFirstHop: true,
        expected: true,
      },
      {
        label: 'lock 활성 + sleep ON + firstHop + transfer → suppress (#750 기존)',
        lock,
        eventType: 'transfer',
        sleepMode: true,
        isFirstHop: true,
        expected: true,
      },
    ])('$label', ({ lock: lockInput, eventType, sleepMode, isFirstHop, expected }) => {
      expect(
        shouldSuppressBySleepRule(
          makeInput({ lock: lockInput, eventType, sleepMode, isFirstHop }),
        ),
      ).toBe(expected);
    });
  });
});
