import type { StationArrival } from '../api/arrivalApi';
import { ARRIVAL_CODE } from '../constants/arrivalCodes';

/**
 * 도착정보 응답에서 lock된 사용자 열차의 arrivalCode가 "곧 도착"(ENTERING/ARRIVED)인지 판정.
 *
 * #396: 기존 ETA 기반 imminent는 speedMps null/<0.5 시 ETA가 null로 빠져 거의 발사 안 됨.
 * API 신호는 GPS/속도와 무관하게 직접 "곧 도착"을 알려줘 본질적 해법.
 *
 * 보수 정책: trainCode가 null이면 false. lock 실패 상태에서 임의 train으로 판정하면
 * 잘못된 imminent 발사 위험. 호출부는 ETA fallback을 별도로 두어 안전망을 확보한다.
 *
 * FG/BG 공유 — silent push(#478) 핸들러에서도 동일 import해 동일 판정에 쓴다.
 */
export function isImminentByArrivalCode(
  arrival: StationArrival | null,
  trainCode: string | null,
): boolean {
  if (!arrival || !trainCode) return false;
  const trains = [...arrival.up, ...arrival.down];
  const match = trains.find((t) => t.trainCode === trainCode);
  if (!match) return false;
  return match.arrivalCode === ARRIVAL_CODE.ENTERING || match.arrivalCode === ARRIVAL_CODE.ARRIVED;
}
