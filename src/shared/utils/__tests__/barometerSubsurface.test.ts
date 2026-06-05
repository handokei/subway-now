import {
  evaluateBarometerStop,
  evaluateSubsurfaceEnter,
  pruneStaleReadings,
  type BarometerReading,
} from '../barometerSubsurface';
import {
  BAROMETER_DPDT_WINDOW_MS,
  BAROMETER_RING_BUFFER_TTL_MS,
  BAROMETER_STOP_DP_THRESHOLD_HPA,
  BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
} from '../../constants/barometer';

const NOW = 1_700_000_000_000; // 고정 epoch (테스트 결정성 확보)

function reading(offsetMs: number, pressureHpa: number): BarometerReading {
  return { t: NOW + offsetMs, pressureHpa };
}

describe('barometerSubsurface (#875)', () => {
  describe('evaluateSubsurfaceEnter', () => {
    it('빈 readings → null (평가 불가)', () => {
      const v = evaluateSubsurfaceEnter([], NOW);
      expect(v).toBeNull();
    });

    it('window 미달 (30s 이내 데이터만) → null', () => {
      const readings = [
        reading(-10_000, 1013.0),
        reading(-5_000, 1013.1),
        reading(0, 1013.2),
      ];
      const v = evaluateSubsurfaceEnter(readings, NOW);
      expect(v).toBeNull();
    });

    it('정확히 dP=+0.3 hPa / 30s → detected', () => {
      const readings = [
        reading(-BAROMETER_DPDT_WINDOW_MS, 1013.0),
        reading(0, 1013.0 + BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA),
      ];
      const v = evaluateSubsurfaceEnter(readings, NOW);
      expect(v).not.toBeNull();
      expect(v!.detected).toBe(true);
      expect(v!.deltaHpa).toBeCloseTo(BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA);
      expect(v!.elapsedMs).toBe(BAROMETER_DPDT_WINDOW_MS);
    });

    it('dP=+0.5 hPa / 30s (임계 초과) → detected', () => {
      const readings = [
        reading(-BAROMETER_DPDT_WINDOW_MS, 1013.0),
        reading(-15_000, 1013.2),
        reading(0, 1013.5),
      ];
      const v = evaluateSubsurfaceEnter(readings, NOW);
      expect(v).not.toBeNull();
      expect(v!.detected).toBe(true);
      expect(v!.deltaHpa).toBeCloseTo(0.5);
    });

    it('dP=+0.1 hPa / 30s (임계 미달) → suppressed', () => {
      const readings = [
        reading(-BAROMETER_DPDT_WINDOW_MS, 1013.0),
        reading(0, 1013.1),
      ];
      const v = evaluateSubsurfaceEnter(readings, NOW);
      expect(v).not.toBeNull();
      expect(v!.detected).toBe(false);
      expect(v!.deltaHpa).toBeCloseTo(0.1);
    });

    it('dP 음수 (지상으로 상승) → suppressed', () => {
      const readings = [
        reading(-BAROMETER_DPDT_WINDOW_MS, 1013.5),
        reading(0, 1013.0),
      ];
      const v = evaluateSubsurfaceEnter(readings, NOW);
      expect(v).not.toBeNull();
      expect(v!.detected).toBe(false);
      expect(v!.deltaHpa).toBeCloseTo(-0.5);
    });

    it('30s 이전 reading이 여러 개면 가장 오래된 것(<= 30s 전 첫 매치) 사용', () => {
      // 50s, 40s, 30s 전 + 현재. 평가 baseline은 30s 이전 readings 중
      // 가장 최근(=가장 작은 elapsed) → 30s 전.
      const readings = [
        reading(-50_000, 1013.0),
        reading(-40_000, 1013.1),
        reading(-30_000, 1013.2),
        reading(0, 1013.5),
      ];
      const v = evaluateSubsurfaceEnter(readings, NOW);
      expect(v).not.toBeNull();
      expect(v!.detected).toBe(true);
      // baseline pressure = 1013.2 (30s 전), delta = 0.3
      expect(v!.deltaHpa).toBeCloseTo(0.3);
      expect(v!.elapsedMs).toBe(30_000);
    });

    it('정렬되지 않은 readings도 시간순으로 평가', () => {
      const readings = [
        reading(0, 1013.5),
        reading(-BAROMETER_DPDT_WINDOW_MS, 1013.0),
        reading(-10_000, 1013.2),
      ];
      const v = evaluateSubsurfaceEnter(readings, NOW);
      expect(v).not.toBeNull();
      expect(v!.detected).toBe(true);
      expect(v!.deltaHpa).toBeCloseTo(0.5);
    });

    it('baseline 후보 중 정렬되지 않은 순서로 들어와도 30s 이전 중 가장 최근을 baseline으로', () => {
      // -30s 후보가 먼저, -40s 후보가 나중 → 두 번째에서 r.t > baseline.t가 false인 분기.
      const readings = [
        reading(-30_000, 1013.2),
        reading(-40_000, 1013.1),
        reading(0, 1013.5),
      ];
      const v = evaluateSubsurfaceEnter(readings, NOW);
      expect(v).not.toBeNull();
      // baseline = -30s (1013.2) 유지, -40s는 더 오래되어 무시.
      expect(v!.deltaHpa).toBeCloseTo(0.3);
      expect(v!.elapsedMs).toBe(30_000);
    });

    it('readings의 가장 최신이 평가 시점(now)보다 미래면 그것을 latest로 사용', () => {
      // 클라이언트 clock 미세 차이를 흡수 — 가장 큰 t를 latest로 본다.
      const readings = [
        reading(-BAROMETER_DPDT_WINDOW_MS, 1013.0),
        reading(+500, 1013.4),
      ];
      const v = evaluateSubsurfaceEnter(readings, NOW);
      expect(v).not.toBeNull();
      expect(v!.detected).toBe(true);
      expect(v!.deltaHpa).toBeCloseTo(0.4);
    });
  });

  describe('evaluateBarometerStop (#921)', () => {
    it('빈 readings → null (평가 불가)', () => {
      expect(evaluateBarometerStop([], NOW)).toBeNull();
    });

    it('window 미달 (30s 이전 baseline 없음) → null', () => {
      const readings = [reading(-5_000, 1013.0), reading(0, 1013.0)];
      expect(evaluateBarometerStop(readings, NOW)).toBeNull();
    });

    it('dP=0 정확히 정차 → detected', () => {
      const readings = [
        reading(-BAROMETER_DPDT_WINDOW_MS, 1013.0),
        reading(0, 1013.0),
      ];
      const v = evaluateBarometerStop(readings, NOW);
      expect(v).not.toBeNull();
      expect(v!.detected).toBe(true);
      expect(v!.deltaHpa).toBeCloseTo(0);
    });

    it('|dP| 임계 정확히 (+0.05 hPa) → detected (FP_EPSILON 내)', () => {
      const readings = [
        reading(-BAROMETER_DPDT_WINDOW_MS, 1013.0),
        reading(0, 1013.0 + BAROMETER_STOP_DP_THRESHOLD_HPA),
      ];
      const v = evaluateBarometerStop(readings, NOW);
      expect(v).not.toBeNull();
      expect(v!.detected).toBe(true);
    });

    it('|dP| 임계 정확히 (-0.05 hPa, 음수 방향) → detected', () => {
      const readings = [
        reading(-BAROMETER_DPDT_WINDOW_MS, 1013.0),
        reading(0, 1013.0 - BAROMETER_STOP_DP_THRESHOLD_HPA),
      ];
      const v = evaluateBarometerStop(readings, NOW);
      expect(v).not.toBeNull();
      expect(v!.detected).toBe(true);
      expect(v!.deltaHpa).toBeCloseTo(-BAROMETER_STOP_DP_THRESHOLD_HPA);
    });

    it('|dP|=+0.1 hPa (임계 초과, 이동 중) → detected=false', () => {
      const readings = [
        reading(-BAROMETER_DPDT_WINDOW_MS, 1013.0),
        reading(0, 1013.1),
      ];
      const v = evaluateBarometerStop(readings, NOW);
      expect(v).not.toBeNull();
      expect(v!.detected).toBe(false);
    });

    it('|dP|=+0.3 hPa (subsurface 임계 — 지하 진입 중, stop 아님) → detected=false', () => {
      const readings = [
        reading(-BAROMETER_DPDT_WINDOW_MS, 1013.0),
        reading(0, 1013.0 + BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA),
      ];
      const v = evaluateBarometerStop(readings, NOW);
      expect(v).not.toBeNull();
      expect(v!.detected).toBe(false);
    });
  });

  describe('pruneStaleReadings', () => {
    it('빈 배열 → 빈 배열', () => {
      expect(pruneStaleReadings([], NOW)).toEqual([]);
    });

    it('TTL 이내 readings 보존', () => {
      const readings = [
        reading(-30_000, 1013.0),
        reading(-10_000, 1013.1),
        reading(0, 1013.2),
      ];
      const out = pruneStaleReadings(readings, NOW);
      expect(out).toHaveLength(3);
    });

    it('TTL 초과 reading 제거', () => {
      const readings = [
        reading(-(BAROMETER_RING_BUFFER_TTL_MS + 1_000), 1012.5),
        reading(-30_000, 1013.0),
        reading(0, 1013.2),
      ];
      const out = pruneStaleReadings(readings, NOW);
      expect(out).toHaveLength(2);
      expect(out[0].pressureHpa).toBeCloseTo(1013.0);
    });

    it('정확히 TTL 경계 reading은 보존 (inclusive)', () => {
      const readings = [reading(-BAROMETER_RING_BUFFER_TTL_MS, 1012.0)];
      const out = pruneStaleReadings(readings, NOW);
      expect(out).toHaveLength(1);
    });

    it('readings 입력 mutate 안 함 (새 배열 반환)', () => {
      const readings = [reading(-100_000, 1012.0), reading(0, 1013.0)];
      const before = readings.length;
      pruneStaleReadings(readings, NOW);
      expect(readings).toHaveLength(before);
    });
  });
});
