/**
 * #RRGGBB hex 토큰에 alpha를 입혀 rgba 문자열로 변환한다.
 * hex 외 포맷(rgba, hsl 등)이면 원본을 그대로 반환해 시각적 회귀를 막는다.
 *
 * 단순 문자열 연결(`color + '22'`)은 토큰 포맷이 바뀌면 잘못된 색을 조용히
 * 생성하므로 모든 alpha 합성은 이 헬퍼를 거친다.
 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
