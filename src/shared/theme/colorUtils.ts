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

/**
 * 두 #RRGGBB 색을 w(0~1) 비율로 섞어 #RRGGBB를 반환한다 (w=0 → a, w=1 → b).
 * hex 외 포맷이 들어오면 a를 그대로 반환한다.
 */
export function mixHex(a: string, b: string, w: number): string {
  const pattern = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
  const ma = pattern.exec(a);
  const mb = pattern.exec(b);
  if (!ma || !mb) return a;
  const channels = [1, 2, 3].map((i) => {
    const mixed = Math.round(parseInt(ma[i], 16) * (1 - w) + parseInt(mb[i], 16) * w);
    return mixed.toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}
