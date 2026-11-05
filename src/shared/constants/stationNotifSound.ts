/**
 * #2822 — device 로컬 station 알림(aux station-passed / LA fallback)의 kind별 sound/interruption
 * 매핑. backend 정책 표(`backend/alarm-worker/src/alertSoundPolicy.ts`)의 **intermediate 행**과
 * 일관 — intermediate(매역 통과)는 무음. transfer/destination 행(sound + timeSensitive)은 소비처가
 * 없고(stationNotification.ts는 `'intermediate'`만 조회), backend 일반 모드 도착 행
 * (`NORMAL_ARRIVAL_ALERT`: active, alarm.wav 아님; #2510 재오픈 2026-11-02)과 다르다 — 동작 영향 없음. if-else 하드코딩 대신 kind → 필드 Record로 데이터 주도 구성(CLAUDE.md 룰3) —
 * `StationWaypointKind`에 새 값이 추가되면 이 Record 리터럴이 컴파일 에러를 낸다.
 */
import type { StationWaypointKind } from '../types/pushContract';

export interface StationNotifSoundFields {
  /** false = 무음(intermediate). true = 알림음(actionable: transfer/destination). */
  sound: boolean;
  /** iOS interruptionLevel 'timeSensitive' 부착 여부 — actionable kind에서만 true. */
  timeSensitive: boolean;
}

export const STATION_NOTIF_SOUND_FIELDS: Record<StationWaypointKind, StationNotifSoundFields> = {
  intermediate: { sound: false, timeSensitive: false },
  transfer: { sound: true, timeSensitive: true },
  destination: { sound: true, timeSensitive: true },
};

export function resolveStationNotifSoundFields(kind: StationWaypointKind): StationNotifSoundFields {
  return STATION_NOTIF_SOUND_FIELDS[kind];
}
