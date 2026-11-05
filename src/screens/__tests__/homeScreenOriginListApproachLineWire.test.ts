/**
 * #2696 — HomeScreen 배선 가드. origin 목록 방향은 BoardingTrainList에 넘기는 line(approachLine)과
 * 같은 여정 leg 기준이어야 하므로 useBoardingLockController에 approachLine을 전달한다.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(__dirname, '..', 'HomeScreen.tsx'), 'utf8');

describe('HomeScreen — origin 목록 방향 기준 노선 배선 (#2696)', () => {
  it('useBoardingLockController 입력에 approachLine이 전달된다', () => {
    expect(SOURCE).toMatch(/useBoardingLockController\(\{[\s\S]{0,700}\bapproachLine,/);
  });
});
