import { CompositeArrivalProvider } from '../CompositeArrivalProvider';
import { KorailArrivalProvider } from '../KorailArrivalProvider';
import type { ArrivalProvider } from '../types';
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

function makeFallback(): jest.Mocked<ArrivalProvider> {
  return {
    getArrival: jest.fn().mockResolvedValue(FALLBACK_RESULT),
  };
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
    const korail = new KorailArrivalProvider('test-key');
    jest.spyOn(korail, 'getArrival').mockResolvedValueOnce(KORAIL_RESULT);
    const fallback = makeFallback();
    const composite = new CompositeArrivalProvider(korail, fallback);

    const result = await composite.getArrival('왕십리', { lineHint: 'bundang' });

    expect(result).toBe(KORAIL_RESULT);
    expect(fallback.getArrival).not.toHaveBeenCalled();
  });

  it('Korail 노선이지만 Korail provider가 null 반환 시 fallback', async () => {
    const korail = new KorailArrivalProvider('test-key');
    jest.spyOn(korail, 'getArrival').mockResolvedValueOnce(null);
    const fallback = makeFallback();
    const composite = new CompositeArrivalProvider(korail, fallback);

    const result = await composite.getArrival('왕십리', { lineHint: 'bundang' });

    expect(result).toBe(FALLBACK_RESULT);
    expect(fallback.getArrival).toHaveBeenCalledWith('왕십리', { lineHint: 'bundang' });
  });

  it('Korail provider가 throw해도 fallback으로 흡수', async () => {
    const korail = new KorailArrivalProvider('test-key');
    jest.spyOn(korail, 'getArrival').mockRejectedValueOnce(new Error('network'));
    const fallback = makeFallback();
    const composite = new CompositeArrivalProvider(korail, fallback);

    const result = await composite.getArrival('왕십리', { lineHint: 'bundang' });

    expect(result).toBe(FALLBACK_RESULT);
    expect(fallback.getArrival).toHaveBeenCalled();
  });

  it('Korail provider가 throw하고 error가 non-Error 객체여도 fallback', async () => {
    const korail = new KorailArrivalProvider('test-key');
    jest.spyOn(korail, 'getArrival').mockRejectedValueOnce('string error');
    const fallback = makeFallback();
    const composite = new CompositeArrivalProvider(korail, fallback);

    const result = await composite.getArrival('왕십리', { lineHint: 'bundang' });

    expect(result).toBe(FALLBACK_RESULT);
  });

  it('Korail 노선이지만 API 키 미설정(isAvailable=false) 시 즉시 fallback', async () => {
    const korail = new KorailArrivalProvider(undefined);
    const korailSpy = jest.spyOn(korail, 'getArrival');
    const fallback = makeFallback();
    const composite = new CompositeArrivalProvider(korail, fallback);

    const result = await composite.getArrival('왕십리', { lineHint: 'gyeongui' });

    expect(result).toBe(FALLBACK_RESULT);
    expect(korailSpy).not.toHaveBeenCalled();
  });

  it('서울교통공사 노선(예: 2호선)은 Korail 거치지 않고 fallback 직행', async () => {
    const korail = new KorailArrivalProvider('test-key');
    const korailSpy = jest.spyOn(korail, 'getArrival');
    const fallback = makeFallback();
    const composite = new CompositeArrivalProvider(korail, fallback);

    const result = await composite.getArrival('강남', { lineHint: '2' });

    expect(result).toBe(FALLBACK_RESULT);
    expect(korailSpy).not.toHaveBeenCalled();
  });

  it('lineHint 없을 때 stationName으로 lookup 후 routing', async () => {
    // '강남'은 2호선/신분당선 — Korail 아님. fallback 직행.
    const korail = new KorailArrivalProvider('test-key');
    const korailSpy = jest.spyOn(korail, 'getArrival');
    const fallback = makeFallback();
    const composite = new CompositeArrivalProvider(korail, fallback);

    const result = await composite.getArrival('강남');

    expect(result).toBe(FALLBACK_RESULT);
    expect(korailSpy).not.toHaveBeenCalled();
  });

  it('lineHint 없고 stationName lookup 실패해도 fallback 직행', async () => {
    const korail = new KorailArrivalProvider('test-key');
    const korailSpy = jest.spyOn(korail, 'getArrival');
    const fallback = makeFallback();
    const composite = new CompositeArrivalProvider(korail, fallback);

    const result = await composite.getArrival('존재하지않는역');

    expect(result).toBe(FALLBACK_RESULT);
    expect(korailSpy).not.toHaveBeenCalled();
  });
});
