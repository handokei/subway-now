import { MockPositionProvider } from '../MockPositionProvider';

describe('MockPositionProvider', () => {
  it('mock positions 반환 + line 보존', async () => {
    const provider = new MockPositionProvider();
    const result = await provider.getPositions('5');
    expect(result.isMock).toBe(true);
    expect(result.line).toBe('5');
  });
});
