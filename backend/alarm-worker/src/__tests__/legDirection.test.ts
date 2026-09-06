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
  it('홍대입구 → 신촌 (인접, id 단조 증가) → down', () => {
    // forward arc < backward arc → down.
    expect(inferLegDirection('2', '홍대입구', '신촌')).toBe('down');
  });

  it('신촌 → 홍대입구 (인접, id 단조 감소) → up', () => {
    expect(inferLegDirection('2', '신촌', '홍대입구')).toBe('up');
  });

  it('지선 역(2-105+ 등 mainIdRange 밖) → null', () => {
    // 2호선 지선 (성수지선, 신정지선) 은 mainIdRange 밖 — null.
    expect(inferLegDirection('2', '용답', '신답')).toBeNull();
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
