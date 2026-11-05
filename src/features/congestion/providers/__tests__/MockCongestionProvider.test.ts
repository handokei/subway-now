import { MockCongestionProvider } from '../MockCongestionProvider';

describe('MockCongestionProvider', () => {
  const provider = new MockCongestionProvider();

  it('평일 출근 시간대 강남 상행: high 단계 매칭 (raw 155 → veryHigh)', () => {
    // 2026-01-05 월요일 08:00 KST 기준 (로컬 시간으로 생성)
    const result = provider.getCongestion('강남', '2', 'up', new Date(2026, 0, 5, 8, 0));
    expect(result).not.toBeNull();
    expect(result!.raw).toBe(155);
    expect(result!.level).toBe('veryHigh');
    expect(result!.timeSlot).toBe('08:00');
    expect(result!.dayType).toBe('weekday');
  });

  it('분이 30 미만이면 :00 슬롯으로 매칭', () => {
    const result = provider.getCongestion('강남', '2', 'up', new Date(2026, 0, 5, 8, 15));
    expect(result?.timeSlot).toBe('08:00');
    expect(result?.raw).toBe(155);
  });

  it('분이 30 이상이면 :30 슬롯으로 매칭 (raw 168 → veryHigh)', () => {
    const result = provider.getCongestion('강남', '2', 'up', new Date(2026, 0, 5, 8, 45));
    expect(result?.timeSlot).toBe('08:30');
    expect(result?.level).toBe('veryHigh');
  });

  it('방향이 다르면 별도 매칭 (down 95 → medium)', () => {
    const result = provider.getCongestion('강남', '2', 'down', new Date(2026, 0, 5, 8, 0));
    expect(result?.raw).toBe(95);
    expect(result?.level).toBe('medium');
  });

  it('토요일은 saturday 데이터 매칭 (raw 60 → low)', () => {
    // 2026-01-10 토요일
    const result = provider.getCongestion('강남', '2', 'up', new Date(2026, 0, 10, 8, 0));
    expect(result?.dayType).toBe('saturday');
    expect(result?.level).toBe('low');
  });

  it('일요일은 sunday 데이터 매칭 (raw 48 → low)', () => {
    // 2026-01-11 일요일
    const result = provider.getCongestion('강남', '2', 'up', new Date(2026, 0, 11, 8, 0));
    expect(result?.dayType).toBe('sunday');
    expect(result?.raw).toBe(48);
  });

  it('high 경계 매칭 (raw 142 → high)', () => {
    const result = provider.getCongestion('강남', '2', 'up', new Date(2026, 0, 5, 9, 0));
    expect(result?.raw).toBe(142);
    expect(result?.level).toBe('high');
  });

  it('미커버 시간대는 null', () => {
    // 강남 데이터는 평일 08:00/08:30/09:00만 존재
    const result = provider.getCongestion('강남', '2', 'up', new Date(2026, 0, 5, 10, 0));
    expect(result).toBeNull();
  });

  it('미커버 역명은 null', () => {
    const result = provider.getCongestion('존재하지않는역', '2', 'up', new Date(2026, 0, 5, 8, 0));
    expect(result).toBeNull();
  });

  it('미커버 노선은 null', () => {
    // 강남은 2호선만 fixture에 있음
    const result = provider.getCongestion('강남', '3', 'up', new Date(2026, 0, 5, 8, 0));
    expect(result).toBeNull();
  });

  it('9호선 여의도 상행: 188 → veryHigh', () => {
    const result = provider.getCongestion('여의도', '9', 'up', new Date(2026, 0, 5, 8, 30));
    expect(result?.raw).toBe(188);
    expect(result?.level).toBe('veryHigh');
  });
});
