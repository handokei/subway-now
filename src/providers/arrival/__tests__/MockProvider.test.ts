import { MockArrivalProvider } from '../MockProvider';
import { MOCK_ARRIVALS } from '../../../api/arrivalApi';

describe('MockArrivalProvider', () => {
  let provider: MockArrivalProvider;

  beforeEach(() => {
    provider = new MockArrivalProvider();
  });

  it('should return MOCK_ARRIVALS regardless of station name', async () => {
    const result = await provider.getArrival('강남');
    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('should return MOCK_ARRIVALS when station name is empty string', async () => {
    const result = await provider.getArrival('');
    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('should return MOCK_ARRIVALS when options are provided', async () => {
    const result = await provider.getArrival('홍대입구', { timeoutMs: 3000, maxPerDirection: 5 });
    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('should return MOCK_ARRIVALS when options is undefined', async () => {
    const result = await provider.getArrival('서울역', undefined);
    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('should return object with isMock true', async () => {
    const result = await provider.getArrival('신촌');
    expect(result.isMock).toBe(true);
  });

  it('should return object with up and down arrays', async () => {
    const result = await provider.getArrival('종각');
    expect(Array.isArray(result.up)).toBe(true);
    expect(Array.isArray(result.down)).toBe(true);
  });
});
