import { buildFeedbackMessage } from '../feedbackMessage';

describe('buildFeedbackMessage (#3366 — 구 서버 빈 message 400 방지용 자동 생성)', () => {
  it('메모가 있으면 메모 그대로(trim)', () => {
    expect(buildFeedbackMessage({ memo: '  알람이 안 왔어요  ', categoryLabel: '기타' })).toBe(
      '알람이 안 왔어요',
    );
  });

  it('칩만 선택 → "[라벨]"', () => {
    expect(buildFeedbackMessage({ memo: '', categoryLabel: '알람이 안 왔어요' })).toBe(
      '[알람이 안 왔어요]',
    );
  });

  it('칩 + 역 → "[라벨] 역명"', () => {
    expect(
      buildFeedbackMessage({ memo: '  ', categoryLabel: '알람이 안 왔어요', stationName: '성수' }),
    ).toBe('[알람이 안 왔어요] 성수');
  });

  it('메모·칩 둘 다 없으면 빈 문자열(보내기 비활성 판정에 사용)', () => {
    expect(buildFeedbackMessage({ memo: '', stationName: '성수' })).toBe('');
  });
});
