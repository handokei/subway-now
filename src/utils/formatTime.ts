export function formatArrivalTime(seconds: number): string {
  if (seconds <= 0) return '곧 도착';
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (min === 0) return `${sec}초`;
  return `${min}분 ${sec}초`;
}
