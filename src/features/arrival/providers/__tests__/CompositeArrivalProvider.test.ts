import { CompositeArrivalProvider } from '../CompositeArrivalProvider';
import { KorailArrivalProvider } from '../KorailArrivalProvider';
import type { ArrivalProvider, ArrivalOptions } from '../types';
import type { StationArrival } from '../../api/arrivalApi';

const KORAIL_RESULT: StationArrival = {
  up: [
    {
      destination: '청량리',
      arrivalMinutes: 2,
      arrivalSeconds: 120,
      statusMessage: '',
      trainCode: 'KR-001',
      line: 'bundang',
      receivedAtMs: 0,
      arrivalCode: -1,
      isLastTrain: false,
      trainType: 'normal',
    },
  ],
  down: [],
  source: 'realtime',
};

const FALLBACK_RESULT: StationArrival = {
  up: [
    {
      destination: '서울역',
      arrivalMinutes: 4,
      arrivalSeconds: 240,
      statusMessage: '',
      trainCode: 'SO-001',
      line: '2',
      receivedAtMs: 0,
      arrivalCode: -1,
      isLastTrain: false,
      trainType: 'normal',
    },
  ],
  down: [],
  source: 'realtime',
};

type SetupOpts = { korailKeyless?: boolean };
function setup(opts: SetupOpts = {}) {
  const korail = new KorailArrivalProvider(opts.korailKeyless ? undefined : 'test-key');
  const korailSpy = jest.spyOn(korail, 'getArrival');
  const fallback: jest.Mocked<ArrivalProvider> = {
    getArrival: jest.fn().mockResolvedValue(FALLBACK_RESULT),
  };
  const composite = new CompositeArrivalProvider(korail, fallback);
  return { korail, korailSpy, fallback, composite };
}

async function expectFallbackDirect(
  stationName: string,
  options?: ArrivalOptions,
  setupOpts: SetupOpts = {},
) {
  const { korailSpy, composite } = setup(setupOpts);

  const result = await composite.getArrival(stationName, options);

  expect(result).toBe(FALLBACK_RESULT);
  expect(korailSpy).not.toHaveBeenCalled();
}

describe('CompositeArrivalProvider', () => {
  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Korail 노선이고 Korail provider 사용 가능 + 결과 반환 시 1차 hit', async () => {
    const { korail, fallback, composite } = setup();
    jest.spyOn(korail, 'getArrival').mockResolvedValueOnce(KORAIL_RESULT);

    const result = await composite.getArrival('왕십리', { lineHint: 'bundang' });

    expect(result).toBe(KORAIL_RESULT);
    expect(fallback.getArrival).not.toHaveBeenCalled();
  });

  it('Korail 노선이지만 Korail provider가 null 반환 시 fallback', async () => {
    const { korail, fallback, composite } = setup();
    jest.spyOn(korail, 'getArrival').mockResolvedValueOnce(null);

    const result = await composite.getArrival('왕십리', { lineHint: 'bundang' });

    expect(result).toBe(FALLBACK_RESULT);
    expect(fallback.getArrival).toHaveBeenCalledWith('왕십리', { lineHint: 'bundang' });
  });

  it('Korail provider가 throw해도 fallback으로 흡수', async () => {
    const { korail, fallback, composite } = setup();
    jest.spyOn(korail, 'getArrival').mockRejectedValueOnce(new Error('network'));

    const result = await composite.getArrival('왕십리', { lineHint: 'bundang' });

    expect(result).toBe(FALLBACK_RESULT);
    expect(fallback.getArrival).toHaveBeenCalled();
  });

  it('Korail provider가 throw하고 error가 non-Error 객체여도 fallback', async () => {
    const { korail, composite } = setup();
    jest.spyOn(korail, 'getArrival').mockRejectedValueOnce('string error');

    const result = await composite.getArrival('왕십리', { lineHint: 'bundang' });

    expect(result).toBe(FALLBACK_RESULT);
  });

  // 데이터 주도: Korail을 거치지 않고 fallback 직행하는 케이스 묶음
  it.each([
    {
      name: 'Korail 노선이지만 API 키 미설정(isAvailable=false) 시 즉시 fallback',
      stationName: '왕십리',
      options: { lineHint: 'gyeongui' } as ArrivalOptions | undefined,
      setupOpts: { korailKeyless: true },
    },
    {
      name: '서울교통공사 노선(예: 2호선)은 Korail 거치지 않고 fallback 직행',
      stationName: '강남',
      options: { lineHint: '2' } as ArrivalOptions | undefined,
      setupOpts: {},
    },
    {
      name: 'lineHint 없을 때 stationName으로 lookup 후 routing (강남=비Korail → fallback)',
      stationName: '강남',
      options: undefined as ArrivalOptions | undefined,
      setupOpts: {},
    },
    {
      name: 'lineHint 없고 stationName lookup 실패해도 fallback 직행',
      stationName: '존재하지않는역',
      options: undefined as ArrivalOptions | undefined,
      setupOpts: {},
    },
  ])('$name', async ({ stationName, options, setupOpts }) => {
    await expectFallbackDirect(stationName, options, setupOpts);
  });
});
