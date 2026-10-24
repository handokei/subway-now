import { hasConsumedOriginWait, isInTripByEvidence } from '../boardingWait';
import type { BoardingLock } from '../../types/boardingLock';

const baseLock: BoardingLock = {
  destinationId: 'dest-1',
  trainCode: 'T-1',
  boardingStationId: 'station-1',
  boardingLine: '2',
  boardedAt: 1_700_000_000_000,
  expectedDurationMs: 600_000,
};

describe('hasConsumedOriginWait', () => {
  it('lock이 null이면 false를 반환한다', () => {
    expect(hasConsumedOriginWait(null, 1_700_000_100_000)).toBe(false);
  });

  // #2290 P1-1 RCA: user-tap lock(BoardingTrainList 직접 탭)은 "미래 열차 선택"일 뿐 탑승
  // evidence가 아니다. 생성 직후(initialEtaSeconds 미경과)에는 여전히 승강장 대기 중이므로 false여야
  // 한다 — 기존 `Boolean(lock)`만으로 판정하던 버그가 여기서 true를 반환해 ETA를 과소표시했다.
  it('user-tap lock(boardingEvidence 없음) 생성 직후에는 false를 반환한다(RCA 회귀)', () => {
    const lock: BoardingLock = { ...baseLock, initialEtaSeconds: 420 }; // 7분 후 도착 예정 train을 탭
    // now === boardedAt (생성 직후, 0초 경과) — 아직 대기 중.
    expect(hasConsumedOriginWait(lock, lock.boardedAt)).toBe(false);
  });

  it('user-tap lock은 initialEtaSeconds 경과 전까지 false를 유지한다', () => {
    const lock: BoardingLock = { ...baseLock, initialEtaSeconds: 420 };
    expect(hasConsumedOriginWait(lock, lock.boardedAt + 419_000)).toBe(false);
  });

  it('user-tap lock은 initialEtaSeconds 경과 시점부터 true를 반환한다', () => {
    const lock: BoardingLock = { ...baseLock, initialEtaSeconds: 420 };
    expect(hasConsumedOriginWait(lock, lock.boardedAt + 420_000)).toBe(true);
    expect(hasConsumedOriginWait(lock, lock.boardedAt + 500_000)).toBe(true);
  });

  it('initialEtaSeconds가 없으면(레거시/evidence 없는 자동 lock) 시간이 지나도 보수적으로 false를 반환한다', () => {
    expect(hasConsumedOriginWait(baseLock, baseLock.boardedAt + 10 * 60_000)).toBe(false);
  });

  // device-side origin auto-lock(arvlCd 강 게이트 + consensus 통과)은 생성 시점 자체가 탑승
  // evidence이므로 initialEtaSeconds 경과와 무관하게 즉시 true.
  it('boardingEvidence=true인 lock은 생성 직후에도 즉시 true를 반환한다', () => {
    const lock: BoardingLock = { ...baseLock, initialEtaSeconds: 420, boardingEvidence: true };
    expect(hasConsumedOriginWait(lock, lock.boardedAt)).toBe(true);
  });

  it('boardingEvidence=true이고 initialEtaSeconds가 없어도 true를 반환한다', () => {
    const lock: BoardingLock = { ...baseLock, boardingEvidence: true };
    expect(hasConsumedOriginWait(lock, lock.boardedAt)).toBe(true);
  });
});

// #2393 — isInTripByEvidence: HomeScreen/stationPipeline 공통 in-trip 판정 헬퍼.
// 4 입력 조합(lock/legAdvance/firedAlarms 각 신호 단독 true, 전부 false) 단위 테스트.
describe('isInTripByEvidence', () => {
  const now = 1_700_000_100_000;

  it('세 신호 모두 false/null이면 false를 반환한다', () => {
    expect(isInTripByEvidence(null, now, null, false)).toBe(false);
  });

  it('hasConsumedOriginWait만 true이면 true를 반환한다', () => {
    const lock: BoardingLock = { ...baseLock, boardingEvidence: true };
    expect(isInTripByEvidence(lock, now, null, false)).toBe(true);
  });

  it('legAdvanceLine만 non-null이면 true를 반환한다', () => {
    expect(isInTripByEvidence(null, now, '2', false)).toBe(true);
  });

  // RED(수정 전 실패) → GREEN(수정 후 통과): lockless + legAdvance 없음 + firedAlarms만 있는
  // 조합이 이 이슈(#2393)의 핵심 신규 신호다. 성수→뚝섬 evidence(2026-08-27): device가 이미
  // station-passed/도착 알람을 발사했다면 lock/legAdvance가 둘 다 없어도 in-trip이어야 한다.
  it('hasFiredThisTrip만 true이면 true를 반환한다(lockless + legAdvance 없음)', () => {
    expect(isInTripByEvidence(null, now, null, true)).toBe(true);
  });
});
