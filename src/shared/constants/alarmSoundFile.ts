/**
 * #3373 — 취침 알람 사운드 파일명. backend `alertSoundPolicy.ts`의 `ALARM_SOUND`와 같은 값이어야 한다
 * (원격 push `aps.sound`와 FG 핸들러 판정이 이 값으로 만난다).
 */
export const ALARM_SOUND_FILE = 'alarm.wav';
