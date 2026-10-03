/**
 * #2377: 위젯 딥링크(subwaynow://current-station)가 중간 리다이렉트 라우트 없이
 * 라우터 마운트 전에 홈으로 재작성되는지 검증한다.
 */
import { redirectSystemPath } from '../+native-intent';

describe('redirectSystemPath', () => {
  it("'current-station' 경로를 홈('/')으로 재작성한다", () => {
    expect(redirectSystemPath({ path: 'current-station', initial: true })).toBe('/');
  });

  it("'/current-station' 경로(선행 슬래시 포함)도 홈으로 재작성한다", () => {
    expect(redirectSystemPath({ path: '/current-station', initial: false })).toBe('/');
  });

  it('그 외 경로는 그대로 통과시킨다', () => {
    expect(redirectSystemPath({ path: '/onboarding', initial: true })).toBe('/onboarding');
    expect(redirectSystemPath({ path: 'language', initial: false })).toBe('language');
  });
});
