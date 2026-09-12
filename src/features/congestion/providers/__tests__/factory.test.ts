import { createCongestionProvider } from '../factory';
import { MockCongestionProvider } from '../MockCongestionProvider';

describe('createCongestionProvider', () => {
  it('PoC 단계에서는 항상 MockCongestionProvider 반환', () => {
    expect(createCongestionProvider()).toBeInstanceOf(MockCongestionProvider);
  });
});

describe('features/congestion/providers/index re-exports', () => {
  it('MockCongestionProvider / SeoulOdCongestionProvider / createCongestionProvider 노출', () => {
    const idx = require('../index');
    expect(idx.MockCongestionProvider).toBeDefined();
    expect(idx.SeoulOdCongestionProvider).toBeDefined();
    expect(idx.createCongestionProvider).toBeDefined();
  });
});
