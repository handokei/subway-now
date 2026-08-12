/**
 * 2026-08-07 건대입구(2·7호선) 환승역 boarding 후보 truncation red fixture
 * (Issue #2207, Part of ADR-027 epic #2206).
 *
 * evidence: `/Users/kimdohan/Downloads/텍스트-123E02178164-1.txt` 덤프.
 *   - 건대입구서 line-2 boarding 후보가 빈 리스트로 노출 (성수 도착쯤에야 2038(line2) 등장).
 *
 * 근본 원인:
 *   `arrivalApi.ts:106` — Seoul API `/0/10/` 전노선(전 line) 응답을 line 필터 없이
 *   `:169`에서 방향(up/down)별 slice(0, maxPerDirection=2)만 적용한다. 환승역에서 한
 *   line의 열차가 응답 앞쪽을 채우면 다른 line 후보가 통째로 truncation된다.
 *
 * 본 테스트는 ADR-027(#2206)의 green flip 전, 현재 코드에서 위 증상이 그대로 재현됨을
 * 증명하는 red fixture다. 프로덕션 코드는 건드리지 않는다 — #2208(arrivalApi line 필터)이
 * fix + green flip을 담당한다.
 *
 * #2154 — 이 evidence의 두 번째 증상("auto-lock이 line-7 후보를 오선택")을 재현하던 describe는
 * `useBoardingLockController`의 무탭 origin auto-lock effect(#1640) 삭제와 함께 제거됐다.
 * auto-lock 자체가 더 이상 존재하지 않아(lock은 user-tap/boardingPrompt 응답으로만 생성) 그
 * 회귀 시나리오는 구조적으로 재발 불가능해졌다.
 */

import { fetchArrivalInfo } from '../../arrival/api/arrivalApi';
import { canonicalStationName } from '../../../testUtils/canonicalStationName';
import type { ArrivalInfo } from '../../../shared/types/arrival';

describe('#2207 건대입구(2·7) arrivalApi truncation red fixture — flip in #2208', () => {
  const GUNDAE_LINE2_NAME = canonicalStationName('건대입구', '2');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
    jest.restoreAllMocks();
  });

  it(
    '건대입구 전노선(2·7) 혼합 realtimeArrivalList — 상행 line-2 후보가 slice(0,2) truncation으로 0건',
    async () => {
      // evidence 재구성: Seoul API가 상행 방향에 7호선 3대 → 2호선 2대 순서로 응답. 앱은
      // maxPerDirection=2로 line 구분 없이 잘라, 2호선 두 대가 통째로 사라진다.
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          realtimeArrivalList: [
            { subwayId: '1007', btrainNo: '7370', barvlDt: 60, updnLine: '상행', trainLineNm: '장암행', arvlCd: 3 },
            { subwayId: '1007', btrainNo: '7371', barvlDt: 180, updnLine: '상행', trainLineNm: '장암행', arvlCd: 3 },
            { subwayId: '1007', btrainNo: '7372', barvlDt: 300, updnLine: '상행', trainLineNm: '장암행', arvlCd: 3 },
            { subwayId: '1002', btrainNo: '2036', barvlDt: 420, updnLine: '상행', trainLineNm: '성수행', arvlCd: 3 },
            { subwayId: '1002', btrainNo: '2038', barvlDt: 540, updnLine: '상행', trainLineNm: '성수행', arvlCd: 3 },
          ],
        }),
      });

      const result = await fetchArrivalInfo(GUNDAE_LINE2_NAME);

      // 수리 후 기대치 (#2208): line-2 상행 후보 > 0. 현재는 line 필터 없는 slice(0,2)가
      // 두 line-7 열차만 남기고 line-2를 전부 truncation — evidence의 "빈 리스트"를 그대로 재현.
      const line2Up = result.up.filter((arrival: ArrivalInfo) => arrival.line === '2');
      expect(line2Up.length).toBeGreaterThan(0);
    },
  );
});
