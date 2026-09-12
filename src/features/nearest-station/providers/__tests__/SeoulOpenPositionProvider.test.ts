import { SeoulOpenPositionProvider } from '../SeoulOpenPositionProvider';
import * as positionApi from '../../api/positionApi';

jest.mock('../../api/positionApi');

describe('SeoulOpenPositionProvider', () => {
  it('fetchTrainPositions로 위임한다', async () => {
    const mock = positionApi.fetchTrainPositions as jest.Mock;
    mock.mockResolvedValue({ line: '2', trains: [] });
    const provider = new SeoulOpenPositionProvider();

    await provider.getPositions('2', { timeoutMs: 1000 });
    expect(mock).toHaveBeenCalledWith('2', { timeoutMs: 1000 });
  });
});
