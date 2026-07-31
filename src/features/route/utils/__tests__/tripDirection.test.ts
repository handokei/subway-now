import { resolveTripDirection } from '../tripDirection';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

describe('resolveTripDirection', () => {
  it('direct: next waypoint index > current index → "down"', () => {
    const route = makeDirectRoute(5, '1');
    // 소요산(1-001, idx 0) → 서울역(1-034)
    expect(resolveTripDirection(route, '서울역', '1-001')).toBe('down');
  });

  it('direct: next waypoint index < current index → "up"', () => {
    const route = makeDirectRoute(5, '1');
    expect(resolveTripDirection(route, '소요산', '1-034')).toBe('up');
  });

  it('current가 같은 station이면 null', () => {
    const route = makeDirectRoute(0, '1');
    expect(resolveTripDirection(route, '소요산', '1-001')).toBeNull();
  });

  it('current가 다른 노선이면 null', () => {
    const route = makeDirectRoute(5, '1');
    expect(resolveTripDirection(route, '서울역', '7-015')).toBeNull();
  });

  it('next waypoint name이 line에 존재하지 않으면 null', () => {
    const route = makeDirectRoute(5, '1');
    expect(resolveTripDirection(route, '없는역이름XYZ', '1-001')).toBeNull();
  });

  it('transfer: 첫 leg은 fromLine + transferName으로 판정한다', () => {
    const route = makeTransferRoute({
      transferName: '서울역',
      fromLine: '1',
      toLine: '4',
      stopsToTransfer: 5,
      stopsFromTransfer: 3,
    });
    // 소요산(1-001) → 서울역(1-034) = down
    expect(resolveTripDirection(route, '강남', '1-001')).toBe('down');
  });

  it('multi-transfer: transfers[0]의 fromLine + transferName으로 판정한다', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '서울역', fromLine: '1', toLine: '4', stopsToTransfer: 5 },
        { transferName: '명동', fromLine: '4', toLine: '2', stopsToTransfer: 3 },
      ],
      stopsAfterLastTransfer: 2,
    });
    expect(resolveTripDirection(route, '강남', '1-001')).toBe('down');
  });

  describe('#1922 — closed loop (2호선 환상선) direction', () => {
    // 2호선 본선 closed loop은 id 사전순 정렬이 wraparound와 일치하지 않을 수 있으므로
    // shortestLinePathIndices로 짧은 쪽 path를 산출해 방향 결정.
    // 강변(2-014) → 잠실나루(2-015)는 short forward (path[1] > currIdx) → 'down'.
    // 잠실나루(2-015) → 강변(2-014)는 short backward (path[1] < currIdx) → 'up'.

    it('환승 후 leg(2호선) — 강변 → 잠실나루 = down (외선)', () => {
      // 7→2 transfer route. 현재 위치가 강변(2-014)일 때 두 번째 leg(2호선)으로 direction 산출.
      const route = makeTransferRoute({
        transferName: '건대입구',
        fromLine: '7',
        toLine: '2',
        stopsToTransfer: 5,
        stopsFromTransfer: 3,
      });
      // destination = 잠실나루(2-015), current = 강변(2-014) → 'down' (외선 방향)
      expect(resolveTripDirection(route, '잠실나루', '2-014')).toBe('down');
    });

    it('환승 후 leg(2호선) — 잠실나루 → 강변 = up (내선)', () => {
      // 7→2 transfer route. destination = 강변(2-014), current = 잠실나루(2-015) → 'up'
      const route = makeTransferRoute({
        transferName: '건대입구',
        fromLine: '7',
        toLine: '2',
        stopsToTransfer: 5,
        stopsFromTransfer: 1,
      });
      expect(resolveTripDirection(route, '강변(동서울터미널)', '2-015')).toBe('up');
    });

    it('direct 2호선 환상선 leg 내 정상 방향 결정', () => {
      // direct route on line 2: 강변 → 잠실나루 = down (외선)
      const route = makeDirectRoute(1, '2');
      expect(resolveTripDirection(route, '잠실나루', '2-014')).toBe('down');
    });
  });

  describe('#1922 — multi-transfer post-transfer leg direction', () => {
    // multi-transfer route에서도 current.line이 두 번째 또는 마지막 leg에 진입한 경우
    // pickLegForCurrentLine이 해당 leg을 선택해 direction 결정.

    it('multi-transfer 마지막 leg(current.line === last.toLine) 진입 후 direction 결정', () => {
      // 1호선 → 4호선 → 2호선 multi-transfer. current가 2호선(마지막 leg toLine)에 있으면
      // 마지막 leg(toLine=2)로 direction 결정. 강변(2-014) → 잠실나루(2-015) = down.
      const route = makeMultiTransferRoute({
        transfers: [
          { transferName: '서울역', fromLine: '1', toLine: '4', stopsToTransfer: 5 },
          { transferName: '동대문역사문화공원', fromLine: '4', toLine: '2', stopsToTransfer: 3 },
        ],
        stopsAfterLastTransfer: 5,
      });
      // current 강변(2-014, 2호선), destination 잠실나루
      expect(resolveTripDirection(route, '잠실나루', '2-014')).toBe('down');
    });

    it('current가 어느 leg에도 없으면 first-leg fallback', () => {
      // 1호선 → 4호선 multi-transfer. current가 7호선(어느 leg에도 없음) → 첫 leg fallback.
      // 첫 leg은 line 1, endName='서울역'. current가 line 7이라 currIdx=-1 → null 반환 (정상).
      const route = makeMultiTransferRoute({
        transfers: [
          { transferName: '서울역', fromLine: '1', toLine: '4', stopsToTransfer: 5 },
          { transferName: '동대문역사문화공원', fromLine: '4', toLine: '2', stopsToTransfer: 3 },
        ],
        stopsAfterLastTransfer: 5,
      });
      // 7-015는 line 7 station. 어느 leg에도 없는 line → first-leg(line 1)로 fallback → currIdx=-1 → null.
      expect(resolveTripDirection(route, '잠실나루', '7-015')).toBeNull();
    });

    it('transfer route 두 번째 leg(toLine) 진입 후 direction 결정', () => {
      // 1호선 → 2호선 transfer. current가 2호선에 있으면 toLine으로 direction 결정.
      const route = makeTransferRoute({
        transferName: '서울역',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 5,
        stopsFromTransfer: 3,
      });
      // current 강변(2-014, 2호선), destination 잠실나루(2-015) → 'down'
      expect(resolveTripDirection(route, '잠실나루', '2-014')).toBe('down');
    });

    it('currentStationId가 stations.json에 없으면 first-leg fallback (방어 분기)', () => {
      // getStationById가 undefined를 반환하면 pickLegForCurrentLine을 건너뛰고 getFirstLeg 사용.
      // first-leg(line 1) + non-existent id → currIdx=-1 → null.
      const route = makeDirectRoute(5, '1');
      expect(resolveTripDirection(route, '서울역', 'NON-EXISTENT-XYZ')).toBeNull();
    });
  });

  describe('#1965 — multi-transfer line 재사용 시 첫 매칭 leg false positive 차단', () => {
    // 2호선 → 4호선 → 2호선(재사용) → 7호선 multi-transfer route.
    // transfers[0].fromLine === transfers[2].fromLine === '2' (line 재사용).
    // 사용자가 실제로는 transfers[2] 구간(동대문역사문화공원~건대입구 사이 성수)에 있는데도
    // 첫 매칭(transfers[0], 시청~사당 구간)을 채택하면 잘못된 endName(사당)이 산출된다.
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '사당', fromLine: '2', toLine: '4', stopsToTransfer: 10 },
        { transferName: '동대문역사문화공원', fromLine: '4', toLine: '2', stopsToTransfer: 3 },
        { transferName: '건대입구', fromLine: '2', toLine: '7', stopsToTransfer: 7 },
      ],
      stopsAfterLastTransfer: 4,
    });

    it('bounded arc(동대문역사문화공원~건대입구) 안의 성수는 transfers[2]로 정확히 매칭된다', () => {
      // 성수(2-011)는 동대문역사문화공원(idx4)~건대입구(idx11) 구간 안 → transfers[2] 채택.
      // 성수(idx10) → 건대입구(idx11) = down.
      expect(resolveTripDirection(route, '어린이대공원(세종대)', '2-011')).toBe('down');
    });

    it('transfers[0]의 bounded 되지 않은 구간(사당 이전) 내 역은 여전히 transfers[0]로 매칭된다', () => {
      // 을지로입구(2-002)는 transfers[2]의 arc(동대문역사문화공원~건대입구, idx4~11) 밖 →
      // bounded leg 미매칭 → 첫 leg(transfers[0], endName='사당', idx25) fallback 채택.
      // 2호선 본선은 closed loop이므로 을지로입구(idx1)→사당(idx25)은 wraparound 짧은 쪽인
      // 역방향(minusHops 19 < plusHops 24) 경로 → 'up'.
      expect(resolveTripDirection(route, '어린이대공원(세종대)', '2-002')).toBe('up');
    });

    it('bounded leg의 entry/exit boundary 역명이 해당 line에 없으면 arc 검증 실패 → 다음 후보 fallback', () => {
      // transfers[1].transferName이 오탈자(해당 line에 미존재)면 isStationInLegArc의
      // entryIdx가 -1이 되어 arc 검증이 false를 반환 → transfers[2]는 건너뛰고 transfers[0]로 fallback.
      const brokenRoute = makeMultiTransferRoute({
        transfers: [
          { transferName: '사당', fromLine: '2', toLine: '4', stopsToTransfer: 10 },
          { transferName: '존재하지않는역명XYZ', fromLine: '4', toLine: '2', stopsToTransfer: 3 },
          { transferName: '건대입구', fromLine: '2', toLine: '7', stopsToTransfer: 7 },
        ],
        stopsAfterLastTransfer: 4,
      });
      // 성수(2-011)는 여전히 line 2 위에 있으나 transfers[2]의 entryBoundary 조회 실패로
      // arc 검증 불가 → transfers[0](사당, idx25) fallback 채택.
      // 성수(idx10) → 사당(idx25) = down.
      expect(resolveTripDirection(brokenRoute, '어린이대공원(세종대)', '2-011')).toBe('down');
    });

    it('#1965 P2-1 — 최종 leg도 bounded arc 검증 대상. 리뷰 실증 시나리오(2호선→4호선(사당)→2호선) 회귀', () => {
      // 2호선 → 4호선(사당) → 2호선(충정로(경기대입구)) multi-transfer, destination 을지로3가.
      // 최종 leg(line 2, entry=충정로(idx42), exit=을지로3가(idx2))도 arc 검증 없이 채택하면
      // (또는 검증에 실패하면) transfers[0](사당, idx25)로 오귀속돼 잘못된 방향이 산출된다.
      // 사용자 위치 을지로입구(idx1)는 최종 leg의 wrap 경로(idx42→idx0→idx1→idx2) 안에 있으므로
      // 최종 leg가 채택되어야 한다.
      const route = makeMultiTransferRoute({
        transfers: [
          { transferName: canonicalStationName('사당', '2'), fromLine: '2', toLine: '4', stopsToTransfer: 10 },
          {
            transferName: canonicalStationName('충정로', '2'),
            fromLine: '4',
            toLine: '2',
            stopsToTransfer: 3,
          },
        ],
        stopsAfterLastTransfer: 2,
      });
      // 최종 leg 채택 시: 을지로입구(idx1) → 을지로3가(idx2) = down.
      // (오귀속되어 transfers[0]/사당(idx25)로 채택되면 'up'이 산출된다 — 회귀 방지 대상.)
      expect(resolveTripDirection(route, canonicalStationName('을지로3가', '2'), '2-002')).toBe('down');
    });

    it('#1965 P2-2 — 순환선 seam(시청↔충정로) 걸친 bounded leg는 wrap-aware하게 arc 검증한다', () => {
      // 7호선 → 2호선(충정로, idx42) → 4호선(을지로3가, idx2) multi-transfer.
      // bounded leg(i=1, entry=충정로 idx42, exit=을지로3가 idx2)가 순환선 seam(idx42↔idx0)을
      // 걸친다. naive min/max(2, 42) 비교면 시청(idx0)은 [2,42] 밖이라 arc 검증에 실패해
      // transfers[0](fromLine 7)도 currentLine(2)과 불일치 → 결국 getFirstLeg fallback(line 7)이
      // 채택되고 currIdx가 line 7에 없어 null이 산출된다.
      // wrap-aware(shortestLinePathIndices) 경로(idx42→idx0→idx1→idx2)는 idx0을 포함해
      // 정확히 이 bounded leg(line 2, endName=을지로3가)를 채택해야 한다.
      const route = makeMultiTransferRoute({
        transfers: [
          {
            transferName: canonicalStationName('충정로', '2'),
            fromLine: '7',
            toLine: '2',
            stopsToTransfer: 10,
          },
          {
            transferName: canonicalStationName('을지로3가', '2'),
            fromLine: '2',
            toLine: '4',
            stopsToTransfer: 3,
          },
        ],
        stopsAfterLastTransfer: 2,
      });
      // bounded leg(line 2) 채택 시: 시청(idx0) → 을지로3가(idx2) = down.
      // (arc 검증 실패로 fallback되면 line 7 불일치로 null이 산출된다 — 회귀 방지 대상.)
      expect(
        resolveTripDirection(route, canonicalStationName('동대문역사문화공원', '4'), '2-001'),
      ).toBe('down');
    });

    it('#1965 P3-1 — bounded leg boundary 역명이 부제 없는 base name이어도 정규화로 매칭된다', () => {
      // transfers[1].transferName을 부제 없는 base name('왕십리')으로 지정해도
      // findStationByNameAndLine의 정규화 fallback이 stations.json 정식 표기
      // '왕십리(성동구청)'로 흡수해 arc 검증이 정상 동작해야 한다(#1410 BLDN_NM drift 대응).
      const route = makeMultiTransferRoute({
        transfers: [
          { transferName: canonicalStationName('사당', '2'), fromLine: '2', toLine: '4', stopsToTransfer: 10 },
          { transferName: '왕십리', fromLine: '4', toLine: '2', stopsToTransfer: 3 },
          { transferName: canonicalStationName('건대입구', '2'), fromLine: '2', toLine: '7', stopsToTransfer: 7 },
        ],
        stopsAfterLastTransfer: 4,
      });
      // 성수(idx10)는 왕십리(성동구청, idx7)~건대입구(idx11) 구간 안 → transfers[2] 채택.
      // 성수(idx10) → 건대입구(idx11) = down.
      expect(
        resolveTripDirection(route, canonicalStationName('어린이대공원(세종대)', '7'), '2-011'),
      ).toBe('down');
    });

    it('#1965 P2-1 방어 분기 — 최종 leg entry boundary 조회 실패 시 unbounded fallback으로 채택된다', () => {
      // last.transferName이 line 2에 없는 오탈자면 최종 leg arc 검증(entry lookup)이 실패한다.
      // 다른 bounded leg(i=1)도 fromLine 불일치, i=0도 fromLine 불일치라 매칭할 후보가 없으므로
      // currentLine === last.toLine이라는 사실만으로 최종 leg를 unbounded fallback 채택해야 한다
      // (arc 데이터 조회 실패 시에도 기존 동작을 보존하는 방어 분기).
      const route = makeMultiTransferRoute({
        transfers: [
          {
            transferName: canonicalStationName('동대문역사문화공원', '7'),
            fromLine: '7',
            toLine: '4',
            stopsToTransfer: 5,
          },
          { transferName: '존재하지않는역명XYZ', fromLine: '4', toLine: '2', stopsToTransfer: 3 },
        ],
        stopsAfterLastTransfer: 2,
      });
      // 성수(idx10) → 건대입구(idx11) = down.
      expect(
        resolveTripDirection(route, canonicalStationName('건대입구', '2'), '2-011'),
      ).toBe('down');
    });
  });
});
