/**
 * #1702 (B2-A) — arrivalsFromPositions 단위 테스트.
 *
 * Seoul OpenAPI 단방향/0건 시 realtimePosition snapshot 으로 ArrivalEntry 를 합성하는 pure
 * helper. autoLock + lockSwap 양쪽에서 사용되므로 합성 정책(direction 필터, segmentStations
 * 위치 검증, ETA 합성, canonical subwayNm) 을 한 곳에서 보장한다.
 */

import { describe, expect, it } from 'vitest';
import {
  pickFallbackTrainCodeFromPositions,
  resolveTrainCodeWithFallback,
  synthesizeArrivalsFromPositions,
} from '../arrivalsFromPositions';
import type { ArrivalEntry, PositionEntry } from '../seoul';

// HOP_SEC 기본 값 90 — `scheduled.ts:FALLBACK_HOP_SEC` 와 동일.
const HOP_SEC = 90;

function position(overrides: Partial<PositionEntry> & { trainCode: string }): PositionEntry {
  return {
    stationName: '',
    trainSttus: 0,
    isUp: false,
    recptnMs: 0,
    ...overrides,
  };
}

describe('synthesizeArrivalsFromPositions', () => {
  // 합정 → 광흥창 → 대흥 → 공덕 (6호선 하행 의도) — 사용자 trip evidence 와 같은 segment.
  const segmentStations = ['합정', '광흥창', '대흥', '공덕'] as const;
  const targetStation = '광흥창';

  it('positions 비어있음 → 빈 배열', () => {
    const result = synthesizeArrivalsFromPositions({
      positions: [],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result).toEqual([]);
  });

  it('segmentStations 비어있음 → 빈 배열', () => {
    const result = synthesizeArrivalsFromPositions({
      positions: [position({ trainCode: '6187', stationName: '합정', isUp: false })],
      line: '6',
      direction: 'down',
      segmentStations: [],
      targetStation,
    });
    expect(result).toEqual([]);
  });

  it('targetStation이 segmentStations 안 없음 → 빈 배열', () => {
    const result = synthesizeArrivalsFromPositions({
      positions: [position({ trainCode: '6187', stationName: '합정', isUp: false })],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation: '망원', // segmentStations 밖
    });
    expect(result).toEqual([]);
  });

  it('canonical 매핑 누락 line → 빈 배열 (matchLine 우회 차단)', () => {
    const result = synthesizeArrivalsFromPositions({
      positions: [position({ trainCode: 'X', stationName: '합정', isUp: false })],
      line: 'unmapped',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result).toEqual([]);
  });

  it('direction=down: isUp=true train 필터링 (반대 방향 제외)', () => {
    const result = synthesizeArrivalsFromPositions({
      positions: [
        position({ trainCode: '6184', stationName: '합정', isUp: true }), // up — 제외
        position({ trainCode: '6187', stationName: '합정', isUp: false }), // down — 채택
      ],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result).toHaveLength(1);
    expect(result[0].trainCode).toBe('6187');
    expect(result[0].isUp).toBe(false);
  });

  it('direction=up: isUp=false train 필터링', () => {
    const result = synthesizeArrivalsFromPositions({
      positions: [
        position({ trainCode: '6184', stationName: '합정', isUp: true }),
        position({ trainCode: '6187', stationName: '합정', isUp: false }),
      ],
      line: '6',
      direction: 'up',
      segmentStations,
      targetStation,
    });
    expect(result).toHaveLength(1);
    expect(result[0].trainCode).toBe('6184');
  });

  it('direction=null: 양방향 허용', () => {
    const result = synthesizeArrivalsFromPositions({
      positions: [
        position({ trainCode: '6184', stationName: '합정', isUp: true }),
        position({ trainCode: '6187', stationName: '합정', isUp: false }),
      ],
      line: '6',
      direction: null,
      segmentStations,
      targetStation,
    });
    expect(result).toHaveLength(2);
  });

  it('segmentStations 밖 train (stationName 매칭 X) 제외', () => {
    const result = synthesizeArrivalsFromPositions({
      positions: [
        position({ trainCode: '6187', stationName: '아예다른역', isUp: false }),
      ],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result).toEqual([]);
  });

  it('이미 target 지난 train (currentIdx > targetIdx) 제외', () => {
    // target=광흥창(idx=1), train@대흥(idx=2) — 이미 target 지나감 → 제외.
    const result = synthesizeArrivalsFromPositions({
      positions: [position({ trainCode: '6187', stationName: '대흥', isUp: false })],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result).toEqual([]);
  });

  it('이미 target 역에 있음 (currentIdx === targetIdx) → arrivalSeconds=0', () => {
    const result = synthesizeArrivalsFromPositions({
      positions: [position({ trainCode: '6187', stationName: '광흥창', isUp: false })],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result).toHaveLength(1);
    expect(result[0].arrivalSeconds).toBe(0);
  });

  it('upstream train ETA = (targetIdx - currentIdx) * HOP_SEC', () => {
    // target=공덕(idx=3), train@합정(idx=0) → 3 hops × 90s = 270s.
    const segmentToGongdeok = ['합정', '광흥창', '대흥', '공덕'];
    const result = synthesizeArrivalsFromPositions({
      positions: [position({ trainCode: '6187', stationName: '합정', isUp: false })],
      line: '6',
      direction: 'down',
      segmentStations: segmentToGongdeok,
      targetStation: '공덕',
    });
    expect(result[0].arrivalSeconds).toBe(3 * HOP_SEC);
  });

  it('합성 ArrivalEntry — subwayNm=canonical, arvlCd=0(ENTERING) 보수', () => {
    const result = synthesizeArrivalsFromPositions({
      positions: [position({ trainCode: '6187', stationName: '합정', isUp: false })],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result[0]).toEqual({
      destination: '',
      arrivalSeconds: HOP_SEC, // 합정(0) → 광흥창(1) = 1 hop
      trainCode: '6187',
      isUp: false,
      subwayNm: '6호선', // canonical
      arvlCd: 0, // ENTERING — 가장 보수적, RC1 confidence gate 트리거 X
      synthesized: true, // #1720 — strongBE signal B 자격 X
    });
  });

  it('여러 train 동시 합성 — 각자 ETA 독립 계산', () => {
    const segmentToGongdeok = ['합정', '광흥창', '대흥', '공덕'];
    const result = synthesizeArrivalsFromPositions({
      positions: [
        position({ trainCode: '6187', stationName: '합정', isUp: false }), // 3 hops
        position({ trainCode: '6189', stationName: '대흥', isUp: false }), // 1 hop
      ],
      line: '6',
      direction: 'down',
      segmentStations: segmentToGongdeok,
      targetStation: '공덕',
    });
    expect(result).toHaveLength(2);
    const map = Object.fromEntries(result.map((r) => [r.trainCode, r.arrivalSeconds]));
    expect(map['6187']).toBe(3 * HOP_SEC);
    expect(map['6189']).toBe(1 * HOP_SEC);
  });
});

describe('pickFallbackTrainCodeFromPositions', () => {
  const segmentStations = ['합정', '광흥창', '대흥', '공덕'] as const;
  const targetStation = '광흥창';

  function realArrival(overrides: Partial<ArrivalEntry> & { trainCode: string }): ArrivalEntry {
    return {
      destination: '',
      arrivalSeconds: 60,
      isUp: false,
      subwayNm: '6호선',
      arvlCd: 1,
      ...overrides,
    };
  }

  it('positions undefined → null', () => {
    const result = pickFallbackTrainCodeFromPositions({
      realArrivals: [],
      positions: undefined,
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result).toBeNull();
  });

  it('positions=[] → null', () => {
    const result = pickFallbackTrainCodeFromPositions({
      realArrivals: [],
      positions: [],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result).toBeNull();
  });

  it('synthesized 0건 (segmentStations 밖 train) → null', () => {
    const result = pickFallbackTrainCodeFromPositions({
      realArrivals: [],
      positions: [position({ trainCode: '6187', stationName: '아예다른역', isUp: false })],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result).toBeNull();
  });

  it('합성 단일 candidate → { trainCode, arrivals } 반환', () => {
    const result = pickFallbackTrainCodeFromPositions({
      realArrivals: [],
      positions: [position({ trainCode: '6187', stationName: '합정', isUp: false })],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result?.trainCode).toBe('6187');
    expect(result?.arrivals).toHaveLength(1);
  });

  it('real arrivals + synthesized merge — 같은 trainCode dedup', () => {
    // realArrivals: T1 wrong direction (UP). Synthesized: T1 DOWN + T2 DOWN.
    // dedup 으로 T1 합성 제외 → merged=[T1 real UP, T2 synth DOWN]. direction=down 필터 → T2 만.
    const result = pickFallbackTrainCodeFromPositions({
      realArrivals: [realArrival({ trainCode: 'T1', isUp: true })],
      positions: [
        position({ trainCode: 'T1', stationName: '합정', isUp: false }),
        position({ trainCode: 'T2', stationName: '합정', isUp: false }),
      ],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result?.trainCode).toBe('T2');
    // merged 에는 T1 real + T2 synth = 2개 (T1 synth 는 dedup 으로 제외).
    expect(result?.arrivals).toHaveLength(2);
  });

  it('합성 ambiguity (2개 down train) → pickAutoTrainCode null → 반환 null', () => {
    const result = pickFallbackTrainCodeFromPositions({
      realArrivals: [],
      positions: [
        position({ trainCode: 'T1', stationName: '합정', isUp: false }),
        position({ trainCode: 'T2', stationName: '합정', isUp: false }),
      ],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result).toBeNull();
  });
});

describe('resolveTrainCodeWithFallback', () => {
  const segmentStations = ['합정', '광흥창', '대흥', '공덕'] as const;
  const targetStation = '광흥창';

  function realArrival(overrides: Partial<ArrivalEntry> & { trainCode: string }): ArrivalEntry {
    return {
      destination: '',
      arrivalSeconds: 60,
      isUp: false,
      subwayNm: '6호선',
      arvlCd: 1,
      ...overrides,
    };
  }

  it('realArrivals 통과 → real candidate 사용, fallback 미진입', () => {
    const result = resolveTrainCodeWithFallback({
      realArrivals: [realArrival({ trainCode: 'REAL' })],
      positions: [position({ trainCode: 'SYNTH', stationName: '합정', isUp: false })],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result?.trainCode).toBe('REAL');
    // arrivals 는 realArrivals 그대로 (synth 미포함).
    expect(result?.arrivals).toHaveLength(1);
  });

  it('real 0건 + positions 합성 → fallback 사용', () => {
    const result = resolveTrainCodeWithFallback({
      realArrivals: [],
      positions: [position({ trainCode: 'SYNTH', stationName: '합정', isUp: false })],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result?.trainCode).toBe('SYNTH');
  });

  it('real wrong direction + positions 합성 → fallback retry', () => {
    const result = resolveTrainCodeWithFallback({
      realArrivals: [realArrival({ trainCode: 'UP_TRAIN', isUp: true })],
      positions: [position({ trainCode: 'DOWN_TRAIN', stationName: '합정', isUp: false })],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result?.trainCode).toBe('DOWN_TRAIN');
  });

  it('real 0건 + positions 미전달 → null', () => {
    const result = resolveTrainCodeWithFallback({
      realArrivals: [],
      positions: undefined,
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result).toBeNull();
  });

  it('real 0건 + positions 빈 list → null', () => {
    const result = resolveTrainCodeWithFallback({
      realArrivals: [],
      positions: [],
      line: '6',
      direction: 'down',
      segmentStations,
      targetStation,
    });
    expect(result).toBeNull();
  });
});
