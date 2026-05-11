import i18next from 'i18next';

export function formatArrivalTime(seconds: number): string {
  if (seconds <= 0) return i18next.t('time.arrivingSoon');
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (min === 0) return i18next.t('time.seconds', { sec });
  return i18next.t('time.minutesAndSeconds', { min, sec });
}
