/**
 * #3122 — 10/21 14:50 서울숲(수인분당) → 강남구청 탑승 목록 공란 replay.
 * 실측 Seoul realtimeStationArrival 응답(불변 fixture)을 실제 파서(fetchArrivalInfo)에 통과시키고
 * 탑승 범위 술어(isCandidateInBoardingScope)까지 이어 6139(종착 고색, 하행)가 포함되는지 본다.
 */
import fixture from '../../../../testUtils/fixtures/seoulforest_bundang_20261021_1450.json';
import { fetchArrivalInfo } from '../../../arrival/api/arrivalApi';
import { isCandidateInBoardingScope } from '../isBoardableCandidate';

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
