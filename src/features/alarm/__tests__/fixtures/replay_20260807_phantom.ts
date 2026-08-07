/**
 * 2026-08-07 07:38 KST 건대입구→뚝섬 phantom fire evidence fixture (Issue #2200, ADR-026 #2199).
 *
 * 출처: 2026-08-07 실기기 debug dump (텍스트 export).
 *   - Raw Signal (dump L826~868): 07:38:19 gps(43m/22.1m/s) automotive 스파이크 1개 →
 *     07:38:25~07:40:01 급격히 감속(16.4 → 12.7 → 9.4 → 0.0 m/s), arc는 4712.51 → 5637.41 로
 *     route-progress time-integration이 계속 전진.
 *   - Alarm log (dump L168~308): 07:38:21 `bg | fired | destination | early | 뚝섬` (phantom fire).
 *     같은 구간 `fg`는 movement-static-speed / movement-motion-stationary / lockless-no-user-intent
 *     로 반복 suppressed — FG 채널만 movementGate.ts(evaluateMovement/isStaticSpeedSignal) 보호를
 *     받고 BG 채널(stationPipeline.processLocationUpdate)은 이 gate를 아예 import하지 않는다.
 *
 * 본 fixture는 evidence의 "정지 상태(GPS speed 급감 + accel stationary)"를 device 로컬 유닛 레벨로
 * 재현한다 — processLocationUpdate에 speedMps=0(정지 확정)을 직접 주입해 BG 채널이 movement 신호를
 * 전혀 참조하지 않음을 증명한다.
 */

import type { Station } from '../../../../shared/types/station';
import type { AlarmEvent } from '../../utils/stationAlarm';

/** evidence L863~865 — 스파이크 직후 승객 기준 위치(건대입구, 2-011). */
export const PHANTOM_NEAREST_STATION: Station = {
  id: '2-011',
  name: '건대입구',
  line: '2',
  lineColor: '#00A84D',
  lat: 37.5404,
  lng: 127.07,
};

/** evidence 목적지 — 뚝섬(2-010 방면), destination-early phase가 오발사된 대상. */
export const PHANTOM_DESTINATION: Station = {
  id: '2-010',
  name: '뚝섬',
  line: '2',
  lineColor: '#00A84D',
  lat: 37.5474,
  lng: 127.0472,
};

/** Alarm log L252 — `bg | fired | destination | early | 뚝섬`. */
export const PHANTOM_ALARM_EVENT: AlarmEvent = {
  phaseId: 'early',
  type: 'destination',
  stationName: PHANTOM_DESTINATION.name,
};

/**
 * evidence 재현 — 07:39:56 이후 GPS speed=0.0m/s 구간(dump L841~845) + accel pattern=stationary
 * (dump 상단 Accel Fingerprint 섹션, 07:38:56/07:39:xx 다수 관측)을 결합한 "정지 확정" 신호.
 * processLocationUpdate 호출 시점의 speedMps로 직접 주입한다.
 */
export const PHANTOM_STATIONARY_SPEED_MPS = 0;

// evidence L864 — 스파이크 순간 값(참고, 22.1 m/s). 본 fixture의 assert 대상은 항상
// PHANTOM_STATIONARY_SPEED_MPS(정지 확정)이므로 별도 export는 두지 않는다.
