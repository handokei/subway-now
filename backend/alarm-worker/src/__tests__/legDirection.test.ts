/**
 * #1719 — legDirection.ts 단위 테스트.
 * #2943 (plan 2026-10-10 J1+J2, 방안 H-1) — 화이트리스트(monotonic/closedLoop) 분기 제거 +
 * `shortestLinePathIndices` 기반 단일 알고리즘 전환의 red→green 앵커. 10/9 실측(군자→광화문,
 * 5호선)에서 반대 방향 열차(5559, 마천행 하행)가 null 방향 필터를 통과해 프롬프트에
 * 제시·lock됐다 — "inferLegDirection — 추론 불가 노선" describe의 기존 두 테스트가 바로 그
 * null 반환(버그의 전제)을 assert하고 있었다. #2943에서 그 두 테스트를 "이제는 방향이
 * 해소된다"는 기대값으로 뒤집고, 10/9 R2 원본 fixture로 pickAutoTrainCode까지의 체인을
 * 고정한다(아래 "#2943 J1→J2" describe).
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
import { SeoulArrivalClient } from '../seoul';
// #2943 — 10/9 11:37:26 군자(능동) 역 cycle, R2 `seoul-capture/2026-10-09/1791513504415.json`
// 원본(subwayId=1005/1007 8건) 그대로. 조정 금지 — 실측 불변 fixture.
import gunjaArrivals1009 from './fixtures/gunja_20261009_1137_arrivals.json';

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

describe('#2943 — 화이트리스트 밖(1/5/경의중앙) 노선도 이제 방향이 해소된다 (H-1)', () => {
  // #2943 전: 1/5/gyeongui는 MONOTONIC_LINES/CLOSED_LOOPS 화이트리스트 밖이라 무조건 null —
  // 10/9 반대 방향 lock 사고의 근본. H-1 후: 화이트리스트 분기 자체가 없어져 모든 노선이
  // 같은 shortestLinePathIndices 기반 알고리즘을 통과한다.
  it('1호선 서울역(1-034) → 시청(1-033, id 감소) → up', () => {
    expect(inferLegDirection('1', '서울역', '시청')).toBe('up');
  });

  it('1호선 시청(1-033) → 서울역(1-034, id 증가) → down', () => {
    expect(inferLegDirection('1', '시청', '서울역')).toBe('down');
  });

  it('5호선 광화문(5-024) → 종로3가(5-025, id 증가) → down', () => {
    expect(inferLegDirection('5', '광화문', '종로3가')).toBe('down');
  });

  it('5호선 종로3가(5-025) → 광화문(5-024, id 감소) → up', () => {
    expect(inferLegDirection('5', '종로3가', '광화문')).toBe('up');
  });

  it('경의중앙선 홍대입구(gyeongui-022) → 공덕(gyeongui-024, id 증가) → down', () => {
    expect(inferLegDirection('gyeongui', '홍대입구', '공덕')).toBe('down');
  });

  it('경의중앙선 공덕(gyeongui-024) → 홍대입구(gyeongui-022, id 감소) → up', () => {
    expect(inferLegDirection('gyeongui', '공덕', '홍대입구')).toBe('up');
  });

  it('알 수 없는 line code → null (stations.json에 노선 자체가 없음, 화이트리스트와 무관)', () => {
    expect(inferLegDirection('99', '서울역', '시청')).toBeNull();
  });
});

describe('#2943 거부 케이스 ⓒⓓ — 지선 교차 (과차단 방어, shortestLinePathIndices 검증)', () => {
  // ⓒ 5호선 마천/하남검단산 분기 — 검증 결과: stations.json에 하남검단산/하남풍산/하남시청이
  // 전혀 등록돼 있지 않다(마천 분기 쪽만 046까지 선형 존재, legDirection.ts 상단 doc 참고).
  // 하남 방향 역명은 findStationByNameAndLine이 항상 null을 반환하므로 교차 쌍 자체가
  // 표현 불가능 — "틀리면 null 유지"가 데이터 부재로 자동 보장된다(과차단 아님).
  it('5호선 군자 → 하남검단산 → null (stations.json에 하남검단산 없음, 안전)', () => {
    expect(inferLegDirection('5', '군자', '하남검단산')).toBeNull();
  });

  it('5호선 마천 → 하남검단산 → null (같은 이유)', () => {
    expect(inferLegDirection('5', '마천', '하남검단산')).toBeNull();
  });

  // ⓓ 1호선 다중 종착/지선 — stations.json의 유일한 실제 분기점은 구로(1-042)↔가산디지털단지
  // (1-100, 경부선 방면에서 유일하게 등록된 station). `shortestLinePathIndices`의 forward
  // slice는 물리적으로 틀린 경로(인천 경유)를 만들어내지만, 방향 판정은 path[1]과 fromIdx의
  // 대소(부호)만 보므로 — 인천행도 가산디지털단지행도 구로보다 id가 커서("하행") 부호는 항상
  // 맞게 나온다. 검증 결과: 안전.
  it('1호선 구로(1-042) → 가산디지털단지(1-100) → down (물리적으로 옳음, 경부선 방면 하행)', () => {
    expect(inferLegDirection('1', '구로', '가산디지털단지')).toBe('down');
  });

  it('1호선 가산디지털단지(1-100) → 구로(1-042) → up (역방향, 옳음)', () => {
    expect(inferLegDirection('1', '가산디지털단지', '구로')).toBe('up');
  });

  // 광명/신창/서동탄/금천구청/병점/수원/천안 등 경부선 남쪽 연장은 stations.json에 전혀
  // 없다 — null(판정 불가로 안전하게 수렴, 과차단 아님).
  it('1호선 구로 → 광명 → null (stations.json에 광명 없음, 안전)', () => {
    expect(inferLegDirection('1', '구로', '광명')).toBeNull();
  });
});

describe('#2943 J1→J2 — 10/9 실측 R2 fixture 전체 체인 (군자→광화문, 5호선)', () => {
  // AC1(오수용 차단) — 사용자는 군자(5-035)→광화문(5-024)으로 id 감소 = 상행으로 이동 중이었다.
  // R2 cycle(11:37:26, 1791513504415.json)의 5호선 후보 4건:
  //   rowNum2 btrainNo=5554 updnLine=상행 arvlCd=99 (방화행)
  //   rowNum3 btrainNo=5066 updnLine=상행 arvlCd=99 (방화행)
  //   rowNum5 btrainNo=5559 updnLine=하행 arvlCd=1  (마천행) ← 반대 방향, 10/9 사고 열차
  //   rowNum7 btrainNo=5055 updnLine=하행 arvlCd=99 (하남검단산행)
  // #2943 전: inferLegDirection('5', '군자', '광화문')는 null(화이트리스트 밖) → pickAutoTrainCode가
  // 양방향 허용 → arvlCd=1(ARRIVED) tier에 5559 단독 매칭 → 5559 선택(10/9 실측 그대로).
  // #2943 후: direction='up' → isUp=false(하행)인 5559/5055가 배제 → 남는 상행 2건(5554/5066)은
  // 둘 다 arvlCd=99(어느 priority tier에도 안 걸림) → "그 외" 분기(수신 순서 첫 후보)로 5554 선택.

  // 실 프로덕션 파싱 경로(SeoulArrivalClient.fetchArrivals → parseEntry)를 그대로 통과시켜
  // updnLine/arvlCd/subwayNm 파생을 수작업으로 베끼지 않는다 — R2 raw JSON을 fetchImpl mock으로
  // 그대로 반환한다.
  async function fetchGunjaArrivals(): Promise<ArrivalEntry[]> {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ realtimeArrivalList: gunjaArrivals1009 }), { status: 200 })) as unknown as typeof fetch;
    const client = new SeoulArrivalClient({
      host: 'seoul.api',
      apiKey: 'KEY',
      fetchImpl,
      now: () => Date.now(),
    });
    return client.fetchArrivals('군자(능동)');
  }

  it('direction = inferLegDirection(5, 군자, 광화문) → up (#2943 전: null)', () => {
    expect(inferLegDirection('5', '군자', '광화문')).toBe('up');
  });

  it('pickAutoTrainCode(실 R2 pool, 5, up) → 5559 배제 + 상행 후보(5554) 선택', async () => {
    const arrivals = await fetchGunjaArrivals();
    const line5Arrivals = arrivals.filter((a) => a.trainCode === '5554' || a.trainCode === '5066' || a.trainCode === '5559' || a.trainCode === '5055');
    expect(line5Arrivals).toHaveLength(4);

    const direction = inferLegDirection('5', '군자', '광화문');
    const selected = pickAutoTrainCode(line5Arrivals, '5', direction);

    // 사유까지 확인: 5559는 하행(isUp=false)이라 방향 필터에서 배제됐어야 한다.
    const picked5559 = line5Arrivals.find((a) => a.trainCode === '5559');
    expect(picked5559?.isUp).toBe(false);
    expect(selected).not.toBe('5559');
    expect(selected).toBe('5554');
  });

  it('(회귀 확인용) direction=null을 강제하면 여전히 5559가 선택된다 — pickAutoTrainCode 자체의 fail-open은 H-6 범위(이 PR 밖)', () => {
    // #2943 H-6 범위 밖임을 명시하는 앵커 — pickAutoTrainCode(direction=null)의 양방향 허용은
    // 의도적으로 남겨둔 기존 동작이다(boardingPrompt.ts:468, scheduled.ts 등 fail-open 4곳).
    return fetchGunjaArrivals().then((arrivals) => {
      const line5Arrivals = arrivals.filter((a) =>
        ['5554', '5066', '5559', '5055'].includes(a.trainCode),
      );
      expect(pickAutoTrainCode(line5Arrivals, '5', null)).toBe('5559');
    });
  });
});
