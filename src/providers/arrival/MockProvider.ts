import type { ArrivalProvider, ArrivalOptions } from '../types';
import type { StationArrival } from '../../api/arrivalApi';
import { MOCK_ARRIVALS } from '../../api/arrivalApi';

export class MockArrivalProvider implements ArrivalProvider {
  async getArrival(
    _stationName: string,
    _options?: ArrivalOptions,
  ): Promise<StationArrival> {
    return MOCK_ARRIVALS;
  }
}
