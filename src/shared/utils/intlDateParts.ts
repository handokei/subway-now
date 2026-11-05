/**
 * Intl.DateTimeFormat.formatToParts() 안전 래퍼.
 *
 * Hermes/iOS의 일부 빌드에서 `weekday: 'short'` 옵션을 줘도 formatToParts 결과에
 * weekday part가 누락되는 회귀가 관측됐다(#1088). 그대로 `parts.find(...)!.value`
 * non-null 단언을 사용하면 TypeError로 화면이 통째로 크래시한다.
 *
 * 본 모듈은 정확히 한 자리에서 try/catch + nullable 반환을 제공해, 호출자가
 * 도메인별로 적절한 fallback("판정 불가" 등)을 선택할 수 있게 한다.
 */
export type DateTimeFormatOptions = Intl.DateTimeFormatOptions;
export type DateTimeFormatPartTypes = Intl.DateTimeFormatPartTypes;

/**
 * 주어진 옵션으로 formatToParts를 호출해 특정 part 값을 반환. 누락/예외 시 null.
 */
export function getDatePart(
  date: Date,
  options: DateTimeFormatOptions,
  partType: DateTimeFormatPartTypes,
): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date);
    const part = parts.find((p) => p.type === partType);
    return part?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * 여러 part를 한 번의 formatToParts 호출로 추출. 옵션으로 요청한 part가 누락되면
 * 해당 key는 결과 객체에 존재하지 않는다(null 반환). 예외 시 빈 객체.
 */
export function getDateParts(
  date: Date,
  options: DateTimeFormatOptions,
  partTypes: readonly DateTimeFormatPartTypes[],
): Partial<Record<DateTimeFormatPartTypes, string>> {
  const result: Partial<Record<DateTimeFormatPartTypes, string>> = {};
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date);
  } catch {
    return result;
  }
  for (const partType of partTypes) {
    const part = parts.find((p) => p.type === partType);
    if (part) result[partType] = part.value;
  }
  return result;
}

/**
 * 특정 timeZone 기준 요일 약자(Sun/Mon/.../Sat) 추출. 누락/예외 시 null.
 */
export function getWeekdayShort(date: Date, timeZone: string): string | null {
  return getDatePart(date, { timeZone, weekday: 'short' }, 'weekday');
}
