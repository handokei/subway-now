import { SeoulOdCongestionProvider } from '../SeoulOdCongestionProvider';

describe('SeoulOdCongestionProvider (stub)', () => {
  it('PoC 단계에서는 호출 시 명시적으로 throw — 후속 PR에서 구현 예정', () => {
    const provider = new SeoulOdCongestionProvider();
    expect(() =>
      provider.getCongestion('강남', '2', 'up', new Date(2026, 0, 5, 8, 0)),
    ).toThrow(/not implemented/);
  });
});
