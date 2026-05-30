import i18next from 'i18next';

export function formatArrivalTime(seconds: number): string {
  if (seconds <= 0) return i18next.t('time.arrivingSoon');
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (min === 0) return i18next.t('time.seconds', { sec });
  return i18next.t('time.minutesAndSeconds', { min, sec });
}

/**
 * epoch ms → "HH:mm" (24h, zero-padded). 사용자가 익숙한 절대 시각 표시 (#625).
 * 디바이스 로컬 timezone 사용 — react-i18next의 locale-aware 포맷터는 다국어 의존을
 * 늘리는데 비해 HH:mm은 모든 지원 언어에서 동일 표기.
 */
export function formatClockTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
