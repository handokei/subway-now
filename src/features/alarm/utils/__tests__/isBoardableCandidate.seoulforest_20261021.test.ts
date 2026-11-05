/**
 * #3122 — 10/21 14:50 서울숲(수인분당) → 강남구청 탑승 목록 공란 replay.
 * 실측 Seoul realtimeStationArrival 응답(불변 fixture)을 실제 파서(fetchArrivalInfo)에 통과시키고
 * 탑승 범위 술어(isCandidateInBoardingScope)까지 이어 6139(종착 고색, 하행)가 포함되는지 본다.
 */
import fixture from '../../../../testUtils/fixtures/seoulforest_bundang_20261021_1450.json';
import { fetchArrivalInfo } from '../../../arrival/api/arrivalApi';
import { isCandidateInBoardingScope } from '../isBoardableCandidate';
import { pickAutoTrainCodeFromArrivals } from '../boardingPromptAutoLock';

describe('replay 10/21 서울숲 수인분당 (#3122)', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => fixture });
  });
  afterEach(() => jest.restoreAllMocks());

  it('파서: 하행 bucket에 6139(종착 고색)가 들어온다', async () => {
    const { down } = await fetchArrivalInfo('서울숲', { maxPerDirection: 10 });
    const train = down.find((t) => t.trainCode === '6139');
    expect(train?.terminalStation).toBe('고색');
    expect(train?.line).toBe('bundang');
  });

  it('탑승 범위: 하행 목록(다음역 압구정로데오)에 6139가 남는다 — 공란 아님', async () => {
    const { down } = await fetchArrivalInfo('서울숲', { maxPerDirection: 10 });
    const inScope = down.filter((t) =>
      isCandidateInBoardingScope(t, {
        line: 'bundang',
        direction: 'down',
        nextTargetStationName: '압구정로데오',
      }),
    );
    expect(inScope.map((t) => t.trainCode)).toEqual(['6139']);
  });

  it('탑승 범위: 상행 목록(다음역 왕십리)은 6546·6112 모두 유지', async () => {
    const { up } = await fetchArrivalInfo('서울숲', { maxPerDirection: 10 });
    const inScope = up.filter((t) =>
      isCandidateInBoardingScope(t, {
        line: 'bundang',
        direction: 'up',
        nextTargetStationName: '왕십리',
      }),
    );
    expect(inScope.map((t) => t.trainCode).sort()).toEqual(['6112', '6546']);
  });

  // 프롬프트 auto-lock(pickAutoTrainCodeFromArrivals)·usePrevTrainCandidate도 같은 isBoardableCandidate 사용.
  // 실측 6139는 arrivalCode=5라 상태 게이트에서 어차피 제외(영향 없음) — 같은 열차가 도착(1) 상태였다면
  // 수정 전에는 범위 판정에서 먼저 탈락해 auto-lock이 null이었다(영향 있음).
  it('auto-lock: 실측 그대로(arrivalCode 5)면 상태 게이트로 null — 범위 수정과 무관', async () => {
    const { down } = await fetchArrivalInfo('서울숲', { maxPerDirection: 10 });
    expect(
      pickAutoTrainCodeFromArrivals(down, {
        line: 'bundang',
        direction: 'down',
        nextTargetStationName: '압구정로데오',
      }),
    ).toBeNull();
  });

  it('auto-lock: 6139가 도착(arrivalCode 1) 상태였다면 선택된다 — 수정 전엔 범위에서 탈락', async () => {
    const { down } = await fetchArrivalInfo('서울숲', { maxPerDirection: 10 });
    const arrived = down.map((t) => ({ ...t, arrivalCode: 1 }));
    const picked = pickAutoTrainCodeFromArrivals(arrived, {
      line: 'bundang',
      direction: 'down',
      nextTargetStationName: '압구정로데오',
    });
    expect(picked?.trainCode).toBe('6139');
  });

  it('거부: 같은 하행 열차라도 종착이 목표역 뒤쪽(서울숲)이면 조기종착으로 제외', async () => {
    const { down } = await fetchArrivalInfo('서울숲', { maxPerDirection: 10 });
    const early = { ...down[0], terminalStation: '서울숲' };
    expect(
      isCandidateInBoardingScope(early, {
        line: 'bundang',
        direction: 'down',
        nextTargetStationName: '압구정로데오',
      }),
    ).toBe(false);
  });
});
