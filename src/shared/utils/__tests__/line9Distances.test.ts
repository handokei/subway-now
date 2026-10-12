/**
 * #2967: 9호선 stationDistances 키 0개 + id 순서 오류로 ETA가 균일 120초 폴백으로 깔린다.
 *
 * Root:
 *   1) stations.json 9호선 id 순서가 CSV와 달라 `isAdjacentHop` 가드가 2쌍을 거부
 *      (한성백제 → 올림픽공원 → 둔촌오륜 → 중앙보훈병원인데 stations.json은
 *       한성백제 → 둔촌오륜 → 중앙보훈병원 → 올림픽공원).
 *   2) `국가철도공단_수도권9호선_역간거리` CSV는 서울교통공사 CSV와 반대로
 *      `역간거리` = '다음역까지' 거리를 쓴다 (서울교통공사는 '이전역으로부터').
 *      `mergeLineHops`는 (이전역, 현재역) edge에 거리를 붙이므로 9호선은
 *      `후행역간거리`('이전역으로부터' 의미의 상보 컬럼)를 읽어야 한다.
 *
 * #2968 정정 — 본문 "증상"표/TDD ①②(findRoutes가 null/환승3을 반환한다는 주장)는 무효다.
 * `stationRoute.ts::findRoutes`(실제 배선된 함수, HomeScreen.tsx:614)는 같은 노선 직통을
 * `getStationsOnLine` 배열 인덱스로 계산해 stationDistances 엣지를 쓰지 않으므로 거리 키가
 * 0개여도 경로 자체는 항상 정상이다 — 소실되는 것은 ETA 정확도뿐이다(`getStopSeconds` tier 3
 * 균일 120초 폴백 → `hopTime.ts` estimator·`calculateStaticETA`로 전파).
 * 새 ①′②′는 그 ETA 체인을 직접 검증한다.
 *
 * 이 테스트는 실제 production 데이터(stations.json / stationDistances.json)를
 * 직접 검증한다 — unit 레벨 mock이 아니라 생성 스크립트 실행 결과물 자체가 대상.
 */
import { getStationsOnLine, getStopSeconds, findStationByNameAndLine } from '../stationRoute';
import { getStopSecondsFromDistance } from '../lineSpeeds';
import { haversine } from '../haversine';
import { hopTimeMsForSegment } from '../../../features/route/utils/hopTime';
import stationDistances from '../../../data/stationDistances.json';

const LINE_9_PAIR_COUNT = 37; // 38개 역 → 인접 hop 37개
const LINE_9_KEY_COUNT = LINE_9_PAIR_COUNT * 2; // 양방향 저장
const STOP_FALLBACK_SECONDS = 120; // stationRoute.ts의 tier 3 균일 폴백과 동일 상수

function line9AdjacentPairs(): Array<{ fromId: string; toId: string }> {
  const line9Stations = getStationsOnLine('9');
  const pairs: Array<{ fromId: string; toId: string }> = [];
  for (let i = 1; i < line9Stations.length; i++) {
    pairs.push({ fromId: line9Stations[i - 1].id, toId: line9Stations[i].id });
  }
  return pairs;
}

describe('#2967 9호선 ETA (getStopSeconds / hopTime)', () => {
  // ①′ — fix 전 premise 검증: 9호선 인접 37쌍 전부가 getStopSeconds === 120(tier 3 균일
  // 폴백)이었다(확인 완료, 구현 커밋 기록 참고). fix 후에는 거리 기반 값으로 갈라져야 하므로
  // 이 테스트는 "120이 전부는 아니다"를 assert한다 — fix 전에는 전부 120이라 반드시 실패하고,
  // fix 후에는 통과한다.
  it('①′(green) fix 후: 9호선 인접 37쌍이 더 이상 전부 120(tier 3 균일 폴백)이 아니다', () => {
    const pairs = line9AdjacentPairs();
    expect(pairs).toHaveLength(LINE_9_PAIR_COUNT);
    const seconds = pairs.map(({ fromId, toId }) => getStopSeconds('9', fromId, toId));
    expect(seconds.every((s) => s === STOP_FALLBACK_SECONDS)).toBe(false);
  });

  // ②′ — 같은 premise의 hopTime 소비 경로(estimator가 실제로 호출하는 함수). fix 전에는
  // getStopSeconds가 전부 120이므로 hopTimeMsForSegment도 전부 120_000ms로 균일했다.
  it('②′(green) fix 후: hopTimeMsForSegment가 9호선 구간에서 더 이상 120_000ms로 균일하지 않다', () => {
    const pairs = line9AdjacentPairs();
    const ms = pairs.map(({ fromId, toId }) => hopTimeMsForSegment('9', fromId, toId));
    expect(ms.every((m) => m === STOP_FALLBACK_SECONDS * 1000)).toBe(false);
  });

  it('③′(green) fix 후: 9호선 hop 초가 tier 2(거리÷속도)로 산출되고 pair별로 달라진다', () => {
    const pairs = line9AdjacentPairs();
    const seconds = pairs.map(({ fromId, toId }) => getStopSeconds('9', fromId, toId));

    // stationTravelTimes.json을 생성하지 않으므로 tier 1(실측)이 아니라 tier 2(거리÷속도)여야 한다.
    for (let i = 0; i < pairs.length; i++) {
      const { fromId, toId } = pairs[i];
      const key = `9|${fromId}|${toId}`;
      const distM = (stationDistances as Record<string, number>)[key];
      expect(distM).toBeDefined();
      expect(seconds[i]).toBeCloseTo(getStopSecondsFromDistance('9', distM), 5);
    }

    // 균일 120초 폴백이 아니라 구간별로 달라야 한다 (라벨 밀림 없이 실거리가 반영됐다는 증거).
    const uniqueSeconds = new Set(seconds.map((s) => Math.round(s)));
    expect(uniqueSeconds.size).toBeGreaterThan(1);
    expect(seconds.every((s) => s === STOP_FALLBACK_SECONDS)).toBe(false);
  });

  it('④′(회귀) 기존 노선(1~8호선/경의중앙)의 getStopSeconds 값은 불변이다', () => {
    // 2호선 tier 1(실측 60s) + DWELL_SECONDS(30s) = 90 — 9호선 CSV 변경과 무관하게 불변.
    expect(getStopSeconds('2', '2-002', '2-003')).toBe(90);
    // 경의중앙 tier 2(거리÷속도) — distKeys 기본값(DIST_KEYS)을 그대로 쓰는 노선이라 무영향.
    const gyeonguiDist = (stationDistances as Record<string, number>)['gyeongui|gyeongui-001|gyeongui-002'];
    expect(getStopSeconds('gyeongui', 'gyeongui-001', 'gyeongui-002')).toBeCloseTo(
      getStopSecondsFromDistance('gyeongui', gyeonguiDist),
      5,
    );
  });

  it('③ stationDistances.json 9호선 키가 74개(37쌍 × 양방향)다', () => {
    const line9Keys = Object.keys(stationDistances).filter((k) => k.startsWith('9|'));
    expect(line9Keys.length).toBe(LINE_9_KEY_COUNT);
  });

  it('④ R-1: 다른 노선 거리 키는 894개로 불변 — 전체는 968개(894 + 74)', () => {
    const allKeys = Object.keys(stationDistances);
    const nonLine9Keys = allKeys.filter((k) => !k.startsWith('9|'));
    expect(nonLine9Keys.length).toBe(894);
    expect(allKeys.length).toBe(894 + LINE_9_KEY_COUNT);
  });

  it('⑤ R-5: 재배치된 3개 역의 좌표·역명은 불변, id만 바뀐다', () => {
    const dunchon = findStationByNameAndLine('둔촌오륜', '9');
    const vhs = findStationByNameAndLine('중앙보훈병원', '9');
    const olympic = findStationByNameAndLine('올림픽공원(한국체대)', '9');

    expect(dunchon).toMatchObject({ id: '9-037', lat: 37.519683, lng: 127.137989 });
    expect(vhs).toMatchObject({ id: '9-038', lat: 37.529191, lng: 127.148739 });
    expect(olympic).toMatchObject({ id: '9-036', lat: 37.516201, lng: 127.130923 });
  });

  it('R-9: 9호선 37쌍 전부 haversine/실측 비가 0.8~2.0 범위다 (라벨 밀림 기계 가드)', () => {
    const line9Stations = getStationsOnLine('9');
    expect(line9Stations).toHaveLength(38);

    const ratios: Array<{ pair: string; ratio: number }> = [];
    for (let i = 1; i < line9Stations.length; i++) {
      const prev = line9Stations[i - 1];
      const cur = line9Stations[i];
      const key = `9|${prev.id}|${cur.id}`;
      const meters = (stationDistances as Record<string, number>)[key];
      expect(meters).toBeDefined();
      expect(meters).toBeGreaterThan(0);

      const straightKm = haversine(prev.lat, prev.lng, cur.lat, cur.lng);
      const actualKm = meters / 1000;
      const ratio = actualKm / straightKm;
      ratios.push({ pair: `${prev.name}↔${cur.name}`, ratio });
    }

    expect(ratios).toHaveLength(LINE_9_PAIR_COUNT);
    for (const { pair, ratio } of ratios) {
      if (ratio < 0.8 || ratio > 2.0) {
        throw new Error(`${pair} haversine ratio ${ratio.toFixed(2)} out of [0.8, 2.0] range`);
      }
    }
  });
});
