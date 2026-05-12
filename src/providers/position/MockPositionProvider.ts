import type { PositionProvider } from '../types';
import { MOCK_POSITIONS, type LinePositions } from '../../api/positionApi';
import type { LineNumber } from '../../types/station';

export class MockPositionProvider implements PositionProvider {
  async getPositions(line: LineNumber): Promise<LinePositions> {
    return { ...MOCK_POSITIONS, line };
  }
}
