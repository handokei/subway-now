/**
 * #1935 — silent push payload SSoT + BG context fallback로 widget update용 station/distance를
 * 결정하는 helper 검증.
 *
 * stationLookup은 stations.json 의존이라 직접 mock해 분기 검증을 격리.
 */

const mockFindByName = jest.fn();
const mockFindByNameAndLine = jest.fn();
jest.mock('../../../../shared/utils/stationLookup', () => ({
  findStationByName: (...args: unknown[]) => mockFindByName(...args),
  findStationByNameAndLine: (...args: unknown[]) => mockFindByNameAndLine(...args),
}));

import {
  lookupStationFromSsot,
  type BgLastStationContext,
  type SsotStationInput,
} from '../lookupStationFromSsot';
import type { Station } from '../../../../shared/types/station';

const ssotStation: Station = {
  id: '0226',
  name: '역삼',
  line: '2',
  lineColor: '#009933',
  lat: 37.5,
  lng: 127.04,
};

const bgStation: Station = {
  id: '0228',
  name: '강남',
  line: '2',
  lineColor: '#009933',
  lat: 37.498,
  lng: 127.027,
};

const bgContext: BgLastStationContext = {
  station: bgStation,
  distanceKm: 0.15,
  timestamp: 1_700_000_000_000,
};

describe('lookupStationFromSsot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByName.mockReturnValue(null);
    mockFindByNameAndLine.mockReturnValue(null);
  });

  describe('SSoT 우선', () => {
    it('SSoT에 currentStationLine 있으면 findStationByNameAndLine으로 line 정확 매칭, distance=0', () => {
      mockFindByNameAndLine.mockReturnValue(ssotStation);
      const ssot: SsotStationInput = {
        currentStationId: '역삼',
        currentStationLine: '2',
      };
      const result = lookupStationFromSsot(ssot, bgContext);
      expect(mockFindByNameAndLine).toHaveBeenCalledWith('역삼', '2');
      expect(mockFindByName).not.toHaveBeenCalled();
      expect(result).toEqual({ station: ssotStation, distanceKm: 0 });
    });

    it('SSoT에 currentStationLine 없으면 findStationByName으로 name-only fallback', () => {
      mockFindByName.mockReturnValue(ssotStation);
      const ssot: SsotStationInput = { currentStationId: '역삼' };
      const result = lookupStationFromSsot(ssot, bgContext);
      expect(mockFindByName).toHaveBeenCalledWith('역삼');
      expect(mockFindByNameAndLine).not.toHaveBeenCalled();
      expect(result).toEqual({ station: ssotStation, distanceKm: 0 });
    });

    it('SSoT lookup 실패 → BG context fallback (line 매칭 실패 케이스)', () => {
      mockFindByNameAndLine.mockReturnValue(null);
      const ssot: SsotStationInput = {
        currentStationId: '존재안함',
        currentStationLine: '99' as unknown as string,
      };
      const result = lookupStationFromSsot(ssot, bgContext);
      expect(result).toEqual({ station: bgStation, distanceKm: 0.15 });
    });

    it('SSoT lookup 실패 (name-only) → BG context fallback', () => {
      mockFindByName.mockReturnValue(null);
      const ssot: SsotStationInput = { currentStationId: '존재안함' };
      const result = lookupStationFromSsot(ssot, bgContext);
      expect(result).toEqual({ station: bgStation, distanceKm: 0.15 });
    });
  });

  describe('BG context fallback', () => {
    it('SSoT null이면 BG context 사용', () => {
      const result = lookupStationFromSsot(null, bgContext);
      expect(mockFindByName).not.toHaveBeenCalled();
      expect(mockFindByNameAndLine).not.toHaveBeenCalled();
      expect(result).toEqual({ station: bgStation, distanceKm: 0.15 });
    });

    it('SSoT undefined도 BG context 사용', () => {
      const result = lookupStationFromSsot(undefined, bgContext);
      expect(result).toEqual({ station: bgStation, distanceKm: 0.15 });
    });
  });

  describe('둘 다 없음', () => {
    it('SSoT null + BG context null → null', () => {
      const result = lookupStationFromSsot(null, null);
      expect(result).toBeNull();
    });

    it('SSoT lookup 실패 + BG context null → null', () => {
      mockFindByName.mockReturnValue(null);
      const ssot: SsotStationInput = { currentStationId: '존재안함' };
      const result = lookupStationFromSsot(ssot, null);
      expect(result).toBeNull();
    });
  });
});
