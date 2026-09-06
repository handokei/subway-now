/**
 * Seam E (#901) — 지상 BoardingLock 정정 채널 — 클라 측 송신.
 *
 * 사용자의 실시간 GPS-확신 위치를 backend에 통보해 lock의 currentWaypoint가 stale로
 * 알람 push 누락되는 회귀(#622, 2026-05-30 13:39~13:45 transfer leg fixture)를 차단한다.
 *
 * 호출 트리거(클라 책임):
 *   1) 좋은 fix(accuracy ≤ 50m) + 새 currentStation 확정 — debounce 5s (useBoardingLockSync)
 *   2) 지하→지상 경계 (Seam G barometer subsurface=false 전환 시)
 *   3) 트립 등록 직후 1회
 *
 * 백엔드 URL 미설정 / 네트워크 실패 / 404 trip_not_found 모두 graceful — throw 하지 않는다.
 * 사용자는 다음 fix에서 자연 retry. positionUpload와 동형 패턴.
 */

import { createLogger } from '../../../shared/utils/logger';
import { fetchWithTimeout, getBackendUrl } from './backendHttp';

const log = createLogger('boardingLockSync');

/**
 * Seam E POST payload. backend `validateBoardingLockSync` 시그니처와 1:1 정합.
 *  - token: APNs device token (hex)
 *  - observedStationName: 좋은 fix로 확정한 현재역 (stations.json `Station.name`)
 *  - observedAtMs: 디바이스 측정 시각 (epoch ms) — backend 시계 drift는 본 endpoint에서 미사용
 *  - accuracy: GPS accuracy meters — 호출자가 ≤ 50m 게이트 통과 후 호출
 *  - subsurface: Seam G 신호 (optional). false = 지상 진입 즉시 재동기 트리거 식별용 로그
 *  - trainCode/boardingLine: D4 (#1210) — 현재 lock의 trainCode + 노선. 환승 leg 진입 시
 *    새 trainCode가 backend에 즉시 반영돼 `consecutiveEtaMissing` 자동 종료를 차단한다.
 *    optional — 구버전 backend / lock 없는 trip은 미전송. backend는 trainCode 변경 감지 시
 *    KV `trip.boardingLock`을 갱신하고 `consecutiveEtaMissing`을 0으로 reset.
 */
export interface BoardingLockSyncPayload {
  token: string;
  observedStationName: string;
  observedAtMs: number;
  accuracy: number;
  subsurface?: boolean;
  trainCode?: string;
  boardingLine?: string;
}

/**
 * #2352 — 구 #916 A1 backend cron 자동 lock 후보 메타(`/boarding-lock/sync` 응답 필드)는
 * 삭제됐다("무탭 오토락 전량 삭제" 결정, #2342). 본 type은 device-side 별개 채널
 * (`transferSwap.ts`/`useTransferAutoDetect`의 환승 자동 detect, #924)이 동일 shape을 재사용해
 * 계속 존재 — 두 채널은 서로 독립적이며 이 type은 이제 순수 shape 정의일 뿐 backend 응답과
 * 1:1이 아니다.
 */
export interface AutoLockCandidate {
  trainCode: string;
  line: string;
  subwayId: string;
}

/**
 * Seam E response. 호출자는 `currentWaypoint`로 client store(useBoardingLockStore 등)에
 * 정정 결과를 반영할 수 있다. waypoints가 비면(`null`) destination 도착.
 */
export interface BoardingLockSyncResponse {
  ok: boolean;
  /** 본 sync로 backend가 waypoints를 shift했는지. false면 no-op. */
  advanced?: boolean;
  /** 정정 후 first waypoint stationName. null = destination 도착으로 trip 소진. */
  currentWaypoint?: string | null;
  /** currentWaypoint와 동일 — 의미상 alias (다음 알람 대상). */
  nextStation?: string | null;
  /** HTTP 실패/skip을 호출자가 진단할 수 있게 노출 — graceful (throw 아님). */
  skipped?: boolean;
  status?: number;
}

/**
 * Seam E POST 발사. backend 200 응답의 currentWaypoint/nextStation을 그대로 반환한다.
 *
 * 실패 경로:
 *   - URL 미설정 → { ok:false, skipped:true } (개발 환경)
 *   - 404 trip_not_found → { ok:false, status:404 } — 클라는 useApnsTripRegistration이 다음 cycle에 재등록
 *   - 네트워크/타임아웃 → { ok:false }
 */
export async function syncBoardingLock(
  payload: BoardingLockSyncPayload,
): Promise<BoardingLockSyncResponse> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip boarding-lock sync');
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetchWithTimeout(`${base}/boarding-lock/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log.warn(`boarding-lock sync failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    const json = (await res.json().catch(() => null)) as Partial<BoardingLockSyncResponse> | null;
    return {
      ok: true,
      status: res.status,
      advanced: json?.advanced ?? false,
      currentWaypoint: json?.currentWaypoint ?? null,
      nextStation: json?.nextStation ?? null,
    };
  } catch (e) {
    log.warn('boarding-lock sync error', e);
    return { ok: false };
  }
}
