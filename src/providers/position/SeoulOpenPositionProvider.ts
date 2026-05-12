import { fetchTrainPositions } from '../../api/positionApi';
import type { PositionProvider } from '../types';
import type { FetchPositionOptions, LinePositions } from '../../api/positionApi';
import type { LineNumber } from '../../types/station';

export class SeoulOpenPositionProvider implements PositionProvider {
  async getPositions(line: LineNumber, options?: FetchPositionOptions): Promise<LinePositions> {
    return fetchTrainPositions(line, options);
  }
}
