import { toDayType, toTimeSlot } from '../timeSlot';

describe('toTimeSlot', () => {
  it('분 < 30 은 :00 슬롯으로 floor', () => {
    expect(toTimeSlot(new Date(2026, 0, 5, 8, 0))).toBe('08:00');
    expect(toTimeSlot(new Date(2026, 0, 5, 8, 29))).toBe('08:00');
  });

  it('분 ≥ 30 은 :30 슬롯', () => {
    expect(toTimeSlot(new Date(2026, 0, 5, 8, 30))).toBe('08:30');
    expect(toTimeSlot(new Date(2026, 0, 5, 8, 59))).toBe('08:30');
  });

  it('한 자리 시간도 zero-pad', () => {
    expect(toTimeSlot(new Date(2026, 0, 5, 5, 15))).toBe('05:00');
  });
});

describe('toDayType', () => {
  it('월~금은 weekday', () => {
    // 2026-01-05는 월요일
    expect(toDayType(new Date(2026, 0, 5))).toBe('weekday');
    // 2026-01-09는 금요일
    expect(toDayType(new Date(2026, 0, 9))).toBe('weekday');
  });

  it('토요일은 saturday', () => {
    // 2026-01-10은 토요일
    expect(toDayType(new Date(2026, 0, 10))).toBe('saturday');
  });

  it('일요일은 sunday', () => {
    // 2026-01-11은 일요일
    expect(toDayType(new Date(2026, 0, 11))).toBe('sunday');
  });
});
