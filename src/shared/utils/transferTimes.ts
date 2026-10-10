/**
 * 환승 도보 시간 lookup helper — ADR-015 §6 SSOT (#1435).
 *
 * 데이터 출처: 공공데이터포털 15044419 "서울교통공사 환승역거리 소요시간 정보_20250331"
 * 보행속도 1.2 m/s 기준 측정값. 양방향 등록(`fromLine|toLine|station`).
 *
 * 본 모듈은 두 호출자가 공유한다:
 *   1) `stationRoute.calculateStaticETA` — 경로 정적 ETA 산출 시 호선쌍별 시간 합산
 *   2) `HomeScreen` BoardingTrainList walkingBufferSeconds — 환승 도보 시간 부족한 traincode 비활성화
 *
 * 미등록 호선쌍(주로 외부 노선 환승)은 `TRANSFER_WALKING_BUFFER_SECONDS` fallback 적용 →
 * ADR-014 §"두 실패 모드 동급" 원칙과 호환(데이터 미보장 케이스도 fire 가능).
 */
import transferTimes from '../../data/transferTimes.json';
import type { LineNumber } from '../types/station';
import { TRANSFER_WALKING_BUFFER_SECONDS } from '../constants/boardingLock';
import { normalizeStationName } from './normalizeStationName';
import { applyStationAlias } from '../../data/stationAliases';

const transferTimeTable = transferTimes as Record<string, number>;

function buildKey(fromLine: LineNumber, toLine: LineNumber, stationName: string): string {
  // stationRoute의 normalizeStationName(괄호 부제 제거 + alias 적용)과 동일 정규화 — build-transfer-times.js와 SSOT 일치.
  const normalized = applyStationAlias(normalizeStationName(stationName));
  return `${fromLine}|${toLine}|${normalized}`;
}

/**
 * 호선쌍별 환승 도보 시간(초). 미등록이면 `undefined` 반환.
 *
 * 호출자가 fallback 정책을 직접 결정해야 하는 경우 사용 (예: UI에 "데이터 없음" 표시).
 */
export function getTransferSecondsOrNull(
  fromLine: LineNumber,
  toLine: LineNumber,
  stationName: string,
): number | undefined {
  return transferTimeTable[buildKey(fromLine, toLine, stationName)];
}

/**
 * 호선쌍별 환승 도보 시간(초). 미등록이면 `TRANSFER_WALKING_BUFFER_SECONDS`(180s) fallback.
 *
 * 호출자가 fallback을 신경 쓸 필요가 없는 일반 케이스에서 사용.
 */
export function getTransferSeconds(
  fromLine: LineNumber,
  toLine: LineNumber,
  stationName: string,
): number {
  return getTransferSecondsOrNull(fromLine, toLine, stationName) ?? TRANSFER_WALKING_BUFFER_SECONDS;
}
