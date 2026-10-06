/**
 * #1719 — legDirection.ts 단위 테스트.
 *
 * `lockSwap.attachTrainCodeForLeg` 가 `direction=null` 로 호출하면 wrong direction trains 가
 * candidate pool 에 통과하는 회귀를 차단하기 위해, segmentStations 의 첫 + 마지막 역으로
 * leg 진행 방향을 추론한다. frontend `loopDirection.ts` + `travelDirection.ts` 와 동일 정책
 * (`lineTopology.json` 단일 SSoT) 이지만 backend-local 로 작성된 helper 의 정합성 보장.
 */

import { describe, expect, it } from 'vitest';
import { inferLegDirection } from '../legDirection';
import { pickAutoTrainCode } from '../boardingPrompt';
import { ARRIVAL_CODE } from '../alarm';
import type { ArrivalEntry } from '../seoul';

describe('inferLegDirection — monotonic 노선', () => {
  it('7호선 중곡 → 어린이대공원 (id 증가) → down', () => {
    expect(inferLegDirection('7', '중곡', '어린이대공원')).toBe('down');
  });

  it('7호선 어린이대공원 → 중곡 (id 감소) → up', () => {
    expect(inferLegDirection('7', '어린이대공원', '중곡')).toBe('up');
  });

  it('3호선 대화 → 오금 (id 증가) → down', () => {
    expect(inferLegDirection('3', '대화', '오금')).toBe('down');
  });

  it('동일 역 → null', () => {
    expect(inferLegDirection('7', '중곡', '중곡')).toBeNull();
  });

  it('canonical fallback (부제 포함) → 정상 매칭', () => {
    // stations.json 은 "군자(능동)" 로 등록 — base name "군자" 도 normalizeStationName 으로 매칭.
    expect(inferLegDirection('7', '중곡', '군자')).toBe('down');
  });

  it('존재하지 않는 역 → null', () => {
    expect(inferLegDirection('7', '없는역', '중곡')).toBeNull();
    expect(inferLegDirection('7', '중곡', '없는역')).toBeNull();
  });
});

describe('inferLegDirection — closedLoop hybrid (6호선 응암 루프)', () => {
  it('합정 → 광흥창 (id 6-013 → 6-015) → down', () => {
    // 사용자 6/23 trip evidence — 합정에서 공덕 방면 진행. 잘못된 응암 방향 train(6184)
    // 차단의 정합성 검증.
    expect(inferLegDirection('6', '합정', '광흥창')).toBe('down');
  });

  it('합정 → 공덕 (id 6-013 → 6-017) → down', () => {
    expect(inferLegDirection('6', '합정', '공덕')).toBe('down');
  });

  it('공덕 → 합정 (id 감소) → up', () => {
    expect(inferLegDirection('6', '공덕', '합정')).toBe('up');
  });

  it('응암 → 연신내 (id 6-001 → 6-005, hybrid 단방향 꼬리) → down', () => {
    // hybrid 노선이지만 loopTailRange 가 있으면 단순 id 비교 — wrap 무의미.
    expect(inferLegDirection('6', '응암', '연신내')).toBe('down');
  });
});

describe('inferLegDirection — closedLoop pure (2호선 순환선)', () => {
  it('홍대입구 → 신촌 (인접, id 단조 증가) → up', () => {
    // #2867 — forward arc(idx 증가) < backward arc → 'up'(내선). 기존 'down' 기대값은
    // 역전된 믿음이었다(10/3·9/17 실측 52쌍으로 확정).
    expect(inferLegDirection('2', '홍대입구', '신촌')).toBe('up');
  });

  it('신촌 → 홍대입구 (인접, id 단조 감소) → down', () => {
    expect(inferLegDirection('2', '신촌', '홍대입구')).toBe('down');
  });

  it('지선 역(2-105+ 등 mainIdRange 밖) → null', () => {
    // 2호선 지선 (성수지선, 신정지선) 은 mainIdRange 밖 — null.
    expect(inferLegDirection('2', '용답', '신답')).toBeNull();
  });
});

describe('#2867 — loop direction inversion (실측 52쌍 ground truth, idx 증가=내선=up)', () => {
  it('신당 → 을지로입구 (idx 감소) → down', () => {
    expect(inferLegDirection('2', '신당', '을지로입구')).toBe('down');
  });

  it('성수 → 뚝섬 (idx 감소) → down', () => {
    expect(inferLegDirection('2', '성수', '뚝섬')).toBe('down');
  });

  it('강변 → 잠실나루 (idx 증가) → up', () => {
    expect(inferLegDirection('2', '강변', '잠실나루')).toBe('up');
  });
});

describe('#2877 — 신분당·수인분당 정렬 극성 반대 (2026-10-06 라이브 프로브 136 이동 실측)', () => {
  // stations.json 정렬이 신분당/수인분당 두 노선에서 idx 0 = 하행 종점(나머지 1~9호선은
  // idx 0 = 상행 종점)이라, 전역 가정("id 작은 쪽=상행")을 그대로 쓰면 이 두 노선만 방향이
  // 뒤집힌다. 실측(updn↔idx 이동쌍 136건): 신분당 updn=0(상행) idx 증가 2/2, 수인분당
  // updn=0(상행) idx 증가 6/6 — 즉 두 노선은 "idx 증가=상행"이다(나머지 노선은 반대).

  it('신분당선 강남(id 013) → 광교(id 001, id 감소) → down (하행, 실제 광교 방향)', () => {
    expect(inferLegDirection('sinbundang', '강남', '광교(경기대)')).toBe('down');
  });

  it('신분당선 광교(id 001) → 강남(id 013, id 증가) → up (상행, 실제 신사 방향)', () => {
    expect(inferLegDirection('sinbundang', '광교(경기대)', '강남')).toBe('up');
  });

  it('수인분당선 수서(id 042) → 왕십리(id 053, id 증가) → up (상행, 실측 왕십리 방향 확인)', () => {
    expect(inferLegDirection('bundang', '수서', '왕십리')).toBe('up');
  });

  it('수인분당선 왕십리(id 053) → 수서(id 042, id 감소) → down (하행)', () => {
    expect(inferLegDirection('bundang', '왕십리', '수서')).toBe('down');
  });
});

describe('#2877 — inferLegDirection → pickAutoTrainCode whole slice (신분당 강남→광교, 하행)', () => {
  function entry(overrides: Partial<ArrivalEntry>): ArrivalEntry {
    return {
      destination: '',
      arrivalSeconds: 0,
      trainCode: 'T1',
      isUp: true,
      subwayNm: '신분당선',
      arvlCd: null,
      ...overrides,
    };
  }

  it('강남→광교(하행) leg direction이 하행(updn=1) 열차를 채택한다 (orientation 반전 전엔 상행 오채택)', () => {
    const direction = inferLegDirection('sinbundang', '강남', '광교(경기대)');
    const arrivals = [
      entry({ trainCode: 'UP-1', isUp: true, arvlCd: ARRIVAL_CODE.ARRIVED }),
      entry({ trainCode: 'DOWN-1', isUp: false, arvlCd: ARRIVAL_CODE.ARRIVED }),
    ];
    expect(pickAutoTrainCode(arrivals, '신분당선', direction)).toBe('DOWN-1');
  });
});

describe('inferLegDirection — 추론 불가 노선', () => {
  it('1호선 (다중 종착/지선) → null', () => {
    expect(inferLegDirection('1', '서울역', '시청')).toBeNull();
  });

  it('5호선 (마천/상일동 분기) → null', () => {
    expect(inferLegDirection('5', '광화문', '종로3가')).toBeNull();
  });

  it('알 수 없는 line code → null', () => {
    expect(inferLegDirection('99', '서울역', '시청')).toBeNull();
  });
});
