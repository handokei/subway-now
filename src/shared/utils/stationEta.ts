import { haversine } from './haversine';

// 0.5m/s 미만은 GPS 정지 노이즈로 간주. 역 진입 시 감속(1~5m/s)은 통과시켜 imminent phase가 동작하도록 한다.
const MIN_VALID_SPEED_MPS = 0.5;

export function estimateEtaSeconds(
  distanceMeters: number,
  speedMps: number | null,
): number | null {
  if (speedMps === null || speedMps < MIN_VALID_SPEED_MPS) return null;
  return distanceMeters / speedMps;
}

/**
 * #2279 — 열차 탑승 중 ETA. haversine 직선거리 ÷ 순간속도는 정거장수와 무관하게 산출되어
 * 역 진입 감속 구간(저속 샘플)에서 실제 1정거장(~2분)인데도 9분처럼 크게 부풀 수 있다
 * (성수→뚝섬 evidence: 1000m ÷ 2m/s = 500s).
 *
 * `hopBasedSeconds`(호출자가 `getRouteRemainingSeconds(route)`로 구한, 잔여 정거장수 ×
 * 실측 hop 시간 합)를 상한으로 clamp한다 — distance/speed 추정이 이를 초과하면(감속·우회
 * 등으로 과대추정) hop 기반 값을 대신 쓴다. distance/speed 추정이 hop 기반보다 짧으면(역
 * 진입 직전 근접 감속) 그대로 사용해 imminent phase 반응성을 보존한다.
 *
 * speed가 null이거나 임계 미만(`estimateEtaSeconds`가 null 반환)이면 나눗셈 자체를 폐기하고
 * hop 기반 값만 사용한다.
 *
 * `stationTravelTimes.json` 실측 최솟값은 현재 60s — hopBasedSeconds가 evaluateAlarmPhase의
 * imminent 게이트 문턱(`IMMINENT_ETA_SECONDS`=10s, `src/features/alarm/utils/alarmPhases.ts`)
 * 미만으로 들어오는 경로는 없다는 데이터 불변식에 의존한다(붕괴 시 회귀 테스트 참고:
 * `__tests__/stationEta.test.ts` "passes hopBasedSeconds through unmodified…").
 *
 * 반환값은 **표시 텍스트(알림/화면 "약 N분")가 아니라** `evaluateAlarmPhase`의 destination
 * imminent 게이트 입력(`AlarmContext.etaSeconds`)으로만 소비된다. 알림 body의 표시 ETA는
 * `calculateStaticETA`(`stationRoute.ts`)가 별도 산출하며, 탑승 중에도 다음 열차 대기시간을
 * 합산하는 결함은 이 함수의 범위 밖 — #2290이 담당한다.
 */
export function estimateTransitEtaSeconds(
  distanceMeters: number,
  speedMps: number | null,
  hopBasedSeconds: number,
): number {
  const distanceEstimate = estimateEtaSeconds(distanceMeters, speedMps);
  return distanceEstimate !== null ? Math.min(distanceEstimate, hopBasedSeconds) : hopBasedSeconds;
}

export function distanceMetersBetween(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  return haversine(fromLat, fromLng, toLat, toLng) * 1000;
}
