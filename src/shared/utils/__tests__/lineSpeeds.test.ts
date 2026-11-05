import { getStopSecondsFromDistance } from '../lineSpeeds';
import { LINE_AVERAGE_SPEED_KMH } from '../../constants/lineSpeeds';

describe('lineSpeeds', () => {
  describe('LINE_AVERAGE_SPEED_KMH', () => {
    it('모든 LineNumber에 대해 양수 속도가 정의되어 있다', () => {
      const speeds = Object.values(LINE_AVERAGE_SPEED_KMH);
      expect(speeds.length).toBeGreaterThan(0);
      for (const v of speeds) expect(v).toBeGreaterThan(0);
    });

    it('신분당선이 1호선보다 빠르다 (50 > 32)', () => {
      expect(LINE_AVERAGE_SPEED_KMH.sinbundang).toBeGreaterThan(LINE_AVERAGE_SPEED_KMH['1']);
    });

    it('공항철도가 가장 빠르다', () => {
      const max = Math.max(...Object.values(LINE_AVERAGE_SPEED_KMH));
      expect(LINE_AVERAGE_SPEED_KMH.airport).toBe(max);
    });
  });

  describe('getStopSecondsFromDistance', () => {
    it('1호선 1km hop → 32 km/h ≈ 112.5초', () => {
      // 1000m / (32*1000/3600) = 1000 / 8.888... ≈ 112.5
      expect(getStopSecondsFromDistance('1', 1000)).toBeCloseTo(112.5, 1);
    });

    it('신분당 1km hop → 50 km/h = 72초', () => {
      expect(getStopSecondsFromDistance('sinbundang', 1000)).toBeCloseTo(72, 1);
    });

    it('거리가 0이면 0초', () => {
      expect(getStopSecondsFromDistance('1', 0)).toBe(0);
    });

    it('거리에 선형 비례한다', () => {
      const a = getStopSecondsFromDistance('2', 800);
      const b = getStopSecondsFromDistance('2', 1600);
      expect(b).toBeCloseTo(a * 2, 5);
    });
  });
});
