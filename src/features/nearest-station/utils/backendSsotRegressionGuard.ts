/**
 * #2669 — backend SSoT가 **경로를 거슬러 표시를 되돌리는 것**을 막는 좁은 가드.
 *
 * 관측(2026-09-16 라이드, Estimator State):
 * ```
 * 06:41:20 | backend-ssot-override | 건대입구(2) idx=5
 * 06:41:25 | lockless-route-hop    | 뚝섬(2)     idx=7
 * 06:44:46 | backend-ssot-override | 건대입구(7) idx=0   ← 사용자는 이때 뚝섬(gp=뚝섬, acc 10~23m)
 * ```
 * 사용자가 목적지(뚝섬)에 도착하는 순간 화면이 3정거장 뒤 환승역(건대입구)으로 되돌아갔다.
 *
 * 왜 생기나: backend SSoT 채택 freshness는 `receivedAt`(mirror가 device에 도달한 시각) 기준이다
 * (#2261 — `lastAdvanceAt` 기준은 지하·정지 trip을 영구 미채택시키는 deadlock을 만들어 의도적으로
 * 바꾼 것). 그런데 leg-2처럼 backend가 lock 없이 **추적을 멈춘** 구간에서는 같은 값이 계속
 * 재전송되며 `receivedAt`만 갱신되고 내용은 얼어붙는다. 그 얼어붙은 값이 GPS보다 우선 채택되면
 * 표시가 뒤로 간다.
 *
 * 그래서 이 가드는 `lastAdvanceAt` 기준 freshness를 **되살리지 않는다**(그 deadlock 재발 금지).
 * 아래 세 조건이 **모두** 성립할 때만 채택을 거부한다:
 *   1. backend가 실제로 전진을 멈췄다 — `now - lastAdvanceAt > BACKEND_SSOT_ADVANCE_STALE_MS`
 *   2. device GPS가 신뢰 가능하다 — 품질 게이트 통과(`gpsQualityDegraded === false`) + 좌표 존재
 *   3. GPS가 가리키는 역이 경로상 mirror보다 **앞서 있다** — arc index가 더 큼
 *
 * 지하/정지(=GPS 죽음)에서는 2번이 깨져 가드가 비활성 → backend 권위가 그대로 유지된다
 * (ADR 확정 아키텍처 "backend추적 → LA 표시" 불변). 사용자가 실제로 되돌아가는 경우(역주행)도
 * 3번이 "앞서 있을 때만"이라 거부하지 않는다.
 *
 * #2686 — 위 GPS 경로 하나만으로는 지하에서 무방비다. backend가 멈추는 곳이 정확히 지하이고,
 * 지하에서 GPS는 저하 상태(2번 깨짐)라 가드가 꺼진 채로 남는다. 그런데 지하에서 실제로 전진하는
 * 주체는 GPS가 아니라 `reanchored-hop`(시간 적분 추정) — 그 전진이 mirror보다 앞서 있어도 이
 * 함수는 무조건 통과(거부 안 함)시켜, 얼어붙은 mirror가 채택되고 표시가 되감긴다(2026-09-17 저녁,
 * 17분 3바퀴).
 *
 * 그래서 `deviceEstimateArcIndex`(source 무관 — reanchored-hop 포함, device가 현재 채택 중인
 * 추정치의 arc index)를 **독립 경로**로 추가한다. GPS 경로(2·3번)와 별개로, "backend 정체 AND
 * deviceEstimateArcIndex가 mirror보다 앞섬"만으로도 거부한다 — GPS 품질 게이트는 이 경로에
 * 적용하지 않는다(지하가 정확히 GPS 저하 상태이므로, 그 게이트를 걸면 이 경로 자체가 무의미).
 * 기존 GPS 경로는 그대로 유지(OR 결합) — 하나만 성립해도 거부.
 *
 * 금지: `reanchored-hop`을 mirror보다 무조건 우선시키지 않는다. "backend 멈춤" 전제(stale)가
 * 여전히 두 경로 모두의 공통 게이트다.
 */

/**
 * backend가 이 시간 이상 advance하지 않았으면 "추적이 멈췄을 수 있다"고 본다.
 * 지하 한 구간(역간 2~3분) + 여유. `BACKEND_SSOT_MIRROR_MAX_AGE_MS`(180s, receivedAt 상한)와
 * 같은 값을 쓰되 의미가 다르므로(내용 신선도 vs 도달 신선도) 별 상수로 둔다.
 */
export const BACKEND_SSOT_ADVANCE_STALE_MS = 180_000;

export interface BackendSsotRegressionInputs {
  /** mirror가 보고한 backend의 마지막 advance 시각(epoch ms). 0/미정착이면 판정하지 않는다. */
  mirrorLastAdvanceAt: number;
  /** mirror station의 경로(arc) 인덱스. -1이면 경로 밖 — 판정하지 않는다. */
  mirrorArcIndex: number;
  /** GPS가 가리키는 역의 경로(arc) 인덱스. -1이면 경로 밖 — 판정하지 않는다. */
  gpsArcIndex: number;
  /** GPS 품질 게이트 저하 여부(#2070). true면 GPS를 판정 근거로 쓰지 않는다. */
  gpsQualityDegraded: boolean;
  /**
   * #2686 — device가 현재 채택 중인 추정치(source 무관 — `reanchored-hop` 포함)의 arc index.
   * GPS 품질 게이트와 무관한 독립 판정 경로. -1/미지정이면 이 경로는 판정하지 않는다
   * (기존 GPS 전용 호출부가 이 필드 없이 호출해도 동작이 회귀하지 않는다).
   */
  deviceEstimateArcIndex?: number;
  now: number;
}

/**
 * @returns true면 이 mirror 채택을 거부해야 한다(= 경로를 거스르는 표시 회귀).
 */
export function isBackendSsotRouteRegression(inputs: BackendSsotRegressionInputs): boolean {
  const {
    mirrorLastAdvanceAt,
    mirrorArcIndex,
    gpsArcIndex,
    gpsQualityDegraded,
    deviceEstimateArcIndex = -1,
    now,
  } = inputs;
  // lazy-seed(0) 상태는 "아직 전진한 적 없음"이라 stale 판정 대상이 아니다 — 갓 시작한 trip을
  // 거부하면 backend 채택이 영영 부트스트랩되지 않는다.
  if (mirrorLastAdvanceAt <= 0) return false;
  if (now - mirrorLastAdvanceAt <= BACKEND_SSOT_ADVANCE_STALE_MS) return false;
  if (mirrorArcIndex < 0) return false;
  // 기존 GPS 경로 — GPS 품질이 신뢰 가능하고 GPS가 경로상 mirror보다 앞설 때만 성립.
  const gpsAhead = !gpsQualityDegraded && gpsArcIndex >= 0 && gpsArcIndex > mirrorArcIndex;
  // #2686 — source 무관 device 추정치 경로. GPS 품질 게이트 없이 독립 판정(지하에서도 동작).
  const deviceAhead = deviceEstimateArcIndex >= 0 && deviceEstimateArcIndex > mirrorArcIndex;
  return gpsAhead || deviceAhead;
}
