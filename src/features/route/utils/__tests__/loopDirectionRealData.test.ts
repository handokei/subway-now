// #2872 — inferLoopDirection 2호선 순환 방향 역전 fix. 실 stations.json 데이터로 ground truth
// (#2867 실측 52쌍 + 10/3 캡처 궤적: 내선 = id 증가 = 'up')를 직접 검증한다. loopDirection.test.ts는
// stationRoute를 합성 fixture로 모킹해 unit 경계를 고정하므로, 이슈 본문이 명시한 실 역명 케이스
// (강변/잠실나루, 성수/을지로입구)는 모킹 없이 별도 파일로 고정한다.
import { inferLoopDirection, parseTrainLineDirection } from '../loopDirection';

describe('inferLoopDirection — 2호선 실데이터 ground truth (#2872, #2867)', () => {
  it("강변(2-014) → 잠실나루(2-015): id 증가(forward) 짧음 → 'up' (내선)", () => {
    expect(inferLoopDirection('2', '강변', '잠실나루')).toBe('up');
  });

  it("성수(2-011) → 을지로입구(2-002): id 감소(backward wrap) 짧음 → 'down' (외선)", () => {
    expect(inferLoopDirection('2', '성수', '을지로입구')).toBe('down');
  });

  it('내선 호(강변→잠실나루) 출력 === parseTrainLineDirection(내선순환) — 자기정합', () => {
    expect(inferLoopDirection('2', '강변', '잠실나루')).toBe(parseTrainLineDirection('내선순환'));
  });
});
