import { SeoulOdExitInfoProvider } from '../SeoulOdExitInfoProvider';

describe('SeoulOdExitInfoProvider (PoC stub)', () => {
  it('현재는 빈 배열만 반환한다 (API 키 연동은 follow-up)', async () => {
    const provider = new SeoulOdExitInfoProvider('test-key');
    const exits = await provider.getExits('강남', '2');
    expect(exits).toEqual([]);
  });
});
