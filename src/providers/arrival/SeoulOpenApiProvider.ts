import { fetchArrivalInfo } from '../../api/arrivalApi';
import type { ArrivalProvider, ArrivalOptions } from '../types';
import type { StationArrival } from '../../api/arrivalApi';

export class SeoulOpenApiProvider implements ArrivalProvider {
  async getArrival(
    stationName: string,
    options?: ArrivalOptions,
  ): Promise<StationArrival> {
    return fetchArrivalInfo(stationName, options);
  }
}
