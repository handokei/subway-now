import { detectMisBoarding } from '../detectMisBoarding';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { LinePositions, TrainPosition } from '../../../../shared/types/position';
import type { Route } from '../../../../shared/utils/stationRoute';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { PENDING_TRAIN_CODE } from '../../../../shared/constants/boardingLock';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

const lock: BoardingLock = {
  destinationId: 'd',
  trainCode: 'T-LOCK',
  boardingStationId: 's',
  boardingLine: '2',
  boardedAt: 1_000_000,
  expectedDurationMs: 1_800_000,
};

function train(overrides: Partial<TrainPosition>): TrainPosition {
  return {
    statnId: '',
    statnNm: '',
    trainNo: 'T-X',
    trainStatus: 0,
    updnLine: 0,
    terminalStationId: '',
    terminalStationName: '',
    trainType: 'normal',
    isLastTrain: false,
    receivedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function positions(overrides: Partial<LinePositions>): LinePositions {
  return { line: '2', trains: [], ...overrides };
}

describe('detectMisBoarding', () => {
  it('lock=null → no-signal', () => {
    expect(detectMisBoarding(null, positions({}))).toBe('no-signal');
  });

  it('positions=null → no-signal', () => {
    expect(detectMisBoarding(lock, null)).toBe('no-signal');
  });

  it('positions.isMock=true → no-signal (실측 아님)', () => {
    expect(detectMisBoarding(lock, positions({ isMock: true }))).toBe('no-signal');
  });

  it('positions.line이 lock.boardingLine과 다르면 no-signal', () => {
    expect(detectMisBoarding(lock, positions({ line: '3' }))).toBe('no-signal');
  });

  it('positions에 trainNo=lock.trainCode 존재 → present', () => {
    expect(
      detectMisBoarding(lock, positions({ trains: [train({ trainNo: 'T-LOCK' })] })),
    ).toBe('present');
  });

  it('positions에 trainNo 부재 → absent', () => {
    expect(
      detectMisBoarding(lock, positions({ trains: [train({ trainNo: 'T-OTHER' })] })),
    ).toBe('absent');
  });

  it('positions에 trains 빈 배열 → absent (관측은 됐지만 lock train 없음)', () => {
    expect(detectMisBoarding(lock, positions({ trains: [] }))).toBe('absent');
  });

  // #2407 — pending lock(fallback lock, trainCode 미확정)은 오탐 방지를 위해 no-signal로
  // 판정을 보류해야 한다. sentinel을 실 trainCode처럼 매칭에 넣으면 항상 'absent'로 잘못 확정된다.
  it('lock.trainCode가 pending sentinel이면 no-signal (오탐 금지, #2407)', () => {
    const pendingLock: BoardingLock = { ...lock, trainCode: PENDING_TRAIN_CODE };
    expect(
      detectMisBoarding(pendingLock, positions({ trains: [train({ trainNo: 'T-OTHER' })] })),
    ).toBe('no-signal');
    expect(detectMisBoarding(pendingLock, positions({ trains: [] }))).toBe('no-signal');
  });
});

// 반대 방향 탑승 감지 (Phase B, foreground, #2455). 실제 stations.json 좌표/id를 사용해
// resolveTripDirection 기반 방향 판정을 검증한다 — 가짜 id('s'/'d')로는 방향을 산출할 수 없다.
describe('detectMisBoarding — wrong-direction (#2455)', () => {
  const ddukseom = findStationByNameAndLine(canonicalStationName('뚝섬', '2'), '2')!;
  const sindangName = canonicalStationName('신당', '2');
  const directRoute: Route = { type: 'direct', stops: 4, line: '2', travelSeconds: 240 };
  const wrongDirectionLock: BoardingLock = {
    destinationId: 'd',
    trainCode: 'T-LOCK',
    boardingStationId: ddukseom.id,
    boardingLine: '2',
    boardedAt: 1_000_000,
    expectedDurationMs: 1_800_000,
  };

  // reproduce-first: 뚝섬(2호선)에서 신당 방향(내선/한양대 방면, 'up')으로 가야 하는데
  // 성수 방면(외선, 'down') 열차에 탑승 — 기존 trainNo 매칭만으로는 'present'로 오판했다.
  it('뚝섬→신당 route인데 성수(외선) 방면에서 관측 → wrong-direction', () => {
    const result = detectMisBoarding(
      wrongDirectionLock,
      positions({ trains: [train({ trainNo: 'T-LOCK', statnNm: '성수' })] }),
      directRoute,
      sindangName,
    );
    expect(result).toBe('wrong-direction');
  });

  it('건대입구(더 먼 외선)에서 관측해도 wrong-direction', () => {
    const result = detectMisBoarding(
      wrongDirectionLock,
      positions({ trains: [train({ trainNo: 'T-LOCK', statnNm: '건대입구' })] }),
      directRoute,
      sindangName,
    );
    expect(result).toBe('wrong-direction');
  });

  it('한양대(내선, 정방향)에서 관측 → present (오탐 아님)', () => {
    const result = detectMisBoarding(
      wrongDirectionLock,
      positions({ trains: [train({ trainNo: 'T-LOCK', statnNm: '한양대' })] }),
      directRoute,
      sindangName,
    );
    expect(result).toBe('present');
  });

  it('아직 탑승역(뚝섬)에 머무는 중 → present (이동 전, 판정 불가)', () => {
    const result = detectMisBoarding(
      wrongDirectionLock,
      positions({ trains: [train({ trainNo: 'T-LOCK', statnNm: ddukseom.name })] }),
      directRoute,
      sindangName,
    );
    expect(result).toBe('present');
  });

  it('route 미전달 → 방향 검사 skip, present (기존 2-arg 호출 하위호환)', () => {
    const result = detectMisBoarding(
      wrongDirectionLock,
      positions({ trains: [train({ trainNo: 'T-LOCK', statnNm: '성수' })] }),
    );
    expect(result).toBe('present');
  });

  it('destinationName 미전달 → 방향 검사 skip, present', () => {
    const result = detectMisBoarding(
      wrongDirectionLock,
      positions({ trains: [train({ trainNo: 'T-LOCK', statnNm: '성수' })] }),
      directRoute,
      null,
    );
    expect(result).toBe('present');
  });

  it('lock.boardingStationId가 stations.json에 없으면(getStationById 실패) present (판정 불가)', () => {
    const unknownOriginLock: BoardingLock = { ...wrongDirectionLock, boardingStationId: 'unknown-id' };
    const result = detectMisBoarding(
      unknownOriginLock,
      positions({ trains: [train({ trainNo: 'T-LOCK', statnNm: '성수' })] }),
      directRoute,
      sindangName,
    );
    expect(result).toBe('present');
  });

  it('destinationName이 boardingLine 위에 없으면(resolveTripDirection null) present', () => {
    const result = detectMisBoarding(
      wrongDirectionLock,
      positions({ trains: [train({ trainNo: 'T-LOCK', statnNm: '성수' })] }),
      directRoute,
      '존재하지않는역',
    );
    expect(result).toBe('present');
  });

  it('관측된 열차 statnNm이 boardingLine 위에 없으면(observedStation lookup 실패) present', () => {
    const result = detectMisBoarding(
      wrongDirectionLock,
      positions({ trains: [train({ trainNo: 'T-LOCK', statnNm: '존재하지않는역' })] }),
      directRoute,
      sindangName,
    );
    expect(result).toBe('present');
  });

  // resolveTripDirection은 route.line(또는 leg의 fromLine)만 보고 방향을 산출하는 반면
  // directionOnLine은 lock.boardingLine으로 별도 조회한다 — 데이터 불일치(예: lock.boardingLine이
  // route가 실제로 매칭한 leg의 line과 다름)로 expectedDirection은 resolve되는데
  // directionOnLine의 fromStationId 조회만 실패하는 경우를 재현해 line 69(actualDirection null)
  // 분기를 커버한다. currentStation(뚝섬, 2호선)이 route.fromLine('2')과 일치해 첫 leg가 선택되고
  // expectedDirection은 정상 resolve되지만, lock.boardingLine을 의도적으로 '7'로 불일치시켜
  // directionOnLine('7', 뚝섬.id, ...)의 fromIdx 조회가 실패한다.
  it('expectedDirection은 resolve되지만 directionOnLine fromId 조회 실패 → present', () => {
    const transferRouteForMismatch: Route = {
      type: 'transfer',
      transferName: canonicalStationName('건대입구', '7'),
      fromLine: '2',
      toLine: '7',
      stopsToTransfer: 2,
      stopsFromTransfer: 1,
      secondsToTransfer: 120,
      secondsFromTransfer: 60,
    };
    const mismatchedLock: BoardingLock = { ...wrongDirectionLock, boardingLine: '7' };
    const result = detectMisBoarding(
      mismatchedLock,
      { line: '7', trains: [train({ trainNo: 'T-LOCK', statnNm: '청담' })] },
      transferRouteForMismatch,
      sindangName,
    );
    expect(result).toBe('present');
  });

  // 환승 leg 경계 — lock.boardingStationId는 PR E 정책상 leg마다 새 lock으로 교체되어
  // 이미 "현재 leg" 시작역이다. 전체 trip origin(2호선)이 아니라 환승 후 leg(7호선) 기준으로
  // 판정되어야 한다.
  describe('환승 leg 경계 (whole-trip origin이 아닌 현재 leg 기준)', () => {
    const line7 = '7' as const;
    const transferOrigin = findStationByNameAndLine(canonicalStationName('건대입구', line7), line7)!;
    const transferRoute: Route = {
      type: 'transfer',
      transferName: canonicalStationName('건대입구', line7),
      fromLine: '2',
      toLine: line7,
      stopsToTransfer: 2,
      stopsFromTransfer: 1,
      secondsToTransfer: 120,
      secondsFromTransfer: 60,
    };
    const destName = canonicalStationName('자양(뚝섬한강공원)', line7);
    const transferLegLock: BoardingLock = {
      destinationId: 'd',
      trainCode: 'T-LOCK',
      boardingStationId: transferOrigin.id,
      boardingLine: line7,
      boardedAt: 1_000_000,
      expectedDurationMs: 1_800_000,
    };

    it('환승 후 leg 정방향(자양 쪽)에서 관측 → present', () => {
      const result = detectMisBoarding(
        transferLegLock,
        {
          line: line7,
          trains: [train({ trainNo: 'T-LOCK', statnNm: canonicalStationName('청담', line7) })],
        },
        transferRoute,
        destName,
      );
      expect(result).toBe('present');
    });

    it('환승 후 leg 반대 방향(어린이대공원 쪽)에서 관측 → wrong-direction', () => {
      const result = detectMisBoarding(
        transferLegLock,
        {
          line: line7,
          trains: [
            train({ trainNo: 'T-LOCK', statnNm: canonicalStationName('어린이대공원', line7) }),
          ],
        },
        transferRoute,
        destName,
      );
      expect(result).toBe('wrong-direction');
    });
  });

  // 2호선 순환선 seam(시청↔충정로) — resolveTripDirection의 wraparound 판정이 반대편
  // 알고리즘(inferLoopDirection)과 어긋나는 경계 지점(#2455 설계 노트). 기대/실제 방향 모두
  // resolveTripDirection 자신으로 계산해 self-consistent하게 만들었으므로, 이 seam 근방에서는
  // 최악의 경우 미탐(false negative)만 발생하고 오탐(false positive)은 절대 나지 않아야 한다 —
  // 이 안전 속성을 회귀 테스트로 고정한다.
  describe('2호선 순환선 seam(시청↔충정로) — 오탐 금지 회귀 고정', () => {
    const chungjeongno = findStationByNameAndLine(canonicalStationName('충정로', '2'), '2')!;
    const seamRoute: Route = { type: 'direct', stops: 1, line: '2', travelSeconds: 60 };
    const seamLock: BoardingLock = {
      destinationId: 'd',
      trainCode: 'T-LOCK',
      boardingStationId: chungjeongno.id,
      boardingLine: '2',
      boardedAt: 1_000_000,
      expectedDurationMs: 1_800_000,
    };
    const sicheongName = canonicalStationName('시청', '2');

    it('시청 방향으로 wrap-forward(을지로입구까지 진행) 관측 → 오탐 없음(present)', () => {
      const result = detectMisBoarding(
        seamLock,
        positions({ trains: [train({ trainNo: 'T-LOCK', statnNm: '을지로입구' })] }),
        seamRoute,
        sicheongName,
      );
      expect(result).not.toBe('wrong-direction');
    });

    it('시청 반대편(아현 방향, wrap 없는 backward) 관측 → 오탐 없음(present)', () => {
      const result = detectMisBoarding(
        seamLock,
        positions({ trains: [train({ trainNo: 'T-LOCK', statnNm: '아현' })] }),
        seamRoute,
        sicheongName,
      );
      expect(result).not.toBe('wrong-direction');
    });
  });
});
