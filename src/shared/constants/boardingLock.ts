/**
 * BoardingLock 관련 상수 — PR C/D에서 scheduler/알람도 참조해 drift 방지 (#584).
 */

/**
 * trip ETA 미상 시 lock 생성에 사용할 fallback 지속시간(분).
 * 자동 만료는 expectedDurationMs × BOARDING_LOCK_EXPIRY_FACTOR(=1.5)이므로
 * fallback 적용 시 30 × 1.5 = 45분 후 자동 release.
 */
export const FALLBACK_BOARDING_DURATION_MINUTES = 30;

/**
 * 환승역 도착 list에서 "지금 못 잡는" 열차로 표시(disabled)할 도보 buffer (#584 PR E).
 * arrival.arrivalSeconds < TRANSFER_WALKING_BUFFER_SECONDS 인 첫 차는 비활성화.
 * 평균 환승 도보 시간 — 정밀화는 후속.
 */
export const TRANSFER_WALKING_BUFFER_SECONDS = 180;

/**
 * 정거장당 추정 이동 시간 (ms). #584 PR C scheduler + #621 fusion interpolation 공유 상수.
 * uniform 90s — 노선별/시간대별 정밀화는 후속(#624 hopTime lookup).
 */
export const HOP_TIME_MS = 90_000;

/**
 * 탑승역 근접 게이트 임계값 (미터, #758).
 * BoardingTrainList(현재역 도착 list)를 노출할 GPS 거리 한계.
 *
 * 정당화: 서울 지하철 역사 출구의 일반적인 도보 반경(~300m) + GPS 도심 정확도 여유(~200m).
 * 사용자가 역에서 멀리 떨어진 곳에서 list만 미리 보고 잘못 탭하는 케이스 차단 — 거리 게이트는
 * fusion 신호와 무관(미터 단위)이므로 지하/지상 신호 변동에 영향받지 않음.
 */
export const BOARDING_PROXIMITY_THRESHOLD_M = 500;

/**
 * #759 — 도착 자동 release 트리거 임계값(m). 사용자가 목적지역과 같은 정거장으로 매칭되고
 * fusion distance가 이 값 미만이면 "도착"으로 간주.
 *
 * 300m로 둔 이유:
 *  - 역 구조물 내(개찰구/출구 보행 반경)에서 GPS 정확도는 50~150m 수준.
 *  - 인접역과의 평균 거리는 600m 이상이라 옆 역으로 잘못 매칭되는 사고를 막을 마진.
 *  - useArrivalAutoClear의 500m보다 보수적 — 자동 release는 lock 해제까지 가는 강한 effect라
 *    더 보수적인 임계값 사용.
 */
export const ARRIVAL_PROXIMITY_THRESHOLD_M = 300;

/**
 * #759 — 도착 신호가 이 시간 이상 지속되어야 자동 release.
 *
 * 45_000ms로 둔 이유:
 *  - fusion 폴링 주기 30s + 사용자가 실제로 하차해 개찰구를 통과하기까지 여유.
 *  - GPS 흔들림으로 한두 사이클 인접역 표시 → 다시 목적지역 복귀하는 케이스에서 grace 만료 회피.
 *  - 너무 짧으면(예: 15s) 정차 직전 한 사이클만 매칭되고 떠나도 release 발화 위험.
 *  - 너무 길면(예: 90s) 사용자가 이미 하차해 다른 곳으로 이동 중인데 lock이 남는 시간이 길어짐.
 */
export const AUTO_RELEASE_GRACE_MS = 45_000;

/**
 * #1887 (RC-14 paradigm 4) — transfer 분기 자동 release에 추가되는 motion stationary 게이트(ms).
 *
 * 사용자 paradigm 4 "이동속도가 빠르지 않다면 판단 후에 자동 하차"의 정확 적용. 환승역 도달 +
 * `ARRIVAL_PROXIMITY_THRESHOLD_M`(300m) 거리 + `AUTO_RELEASE_GRACE_MS`(45s) grace에 더해
 * iOS CMMotionActivity stationary가 `LEG_TRANSITION_STATIONARY_GATE_MS` 이상 지속되어야 release.
 *
 * 30_000ms로 둔 이유:
 *  - 사용자 paradigm 5 "1정거장 이내 deadline" 정합 — 환승역에서 도보 시작 직전 정차 시간이 짧으면
 *    사용자가 곧바로 다음 leg로 이동한다는 신호이므로 release를 미뤄야 함.
 *  - 30s는 사용자 issue body T4 시나리오의 "30초~수분 stationary" 정신 정확 매칭.
 *  - 너무 짧으면(예: 10s) 정차 직전 한 사이클만 stationary로 잡혀도 release 발화 위험 — paradigm 4
 *    의 "판단 후" 정신 위반.
 *  - 너무 길면(예: 120s) 사용자가 이미 환승 통로로 이동했는데 lock이 남는 시간이 길어짐.
 *
 * 도착(destination) 분기에는 미적용 — 도착 시점에는 사용자가 짐 정리/하차 동작으로 motion이 walking
 * 변동 가능. transfer 분기만 환승 도보 전 정차 시간이 명확한 시그널.
 */
export const LEG_TRANSITION_STATIONARY_GATE_MS = 30_000;

/**
 * #767 — boardingLock 해제(non-null → null) 시 register POST를 지연하는 debounce(ms).
 *
 * 배경(PR #765 evidence): 사용자가 옛 lock을 release하고 즉시 새 lock을 잡는 swap 흐름에서
 * 짧은 시간 안에 3 POST가 발사된다(boardingLock=null → null → 새 lock). 첫 POST(null)가
 * backend KV의 기존 lock을 unset해 새 lock POST가 `existingHasLock=false`로 들어오는 회귀가
 * 관측되었다 (정상은 새 lock으로 직접 교체).
 *
 * 해제 → 새 lock 전환을 흡수하기 위해 lock release POST만 debounce — 다음 effect cycle이
 * 새 lock을 들고 오면 옛 null POST는 cleanup으로 cancel되어 backend KV 상의 lock unset
 * 사이드이펙트를 차단한다. 새 lock POST는 즉시 발사(debounce 미적용)되어 사용자 경험 영향 없음.
 *
 * 1500ms로 둔 이유:
 *  - PR #765 evidence: 3 POST가 25초 안에 분포(~12.5s 간격), 사용자 swap 의도가 같은 effect
 *    cycle 안에 들어오기엔 짧지 않다. 그러나 race window 자체는 React effect 재실행 + GPS/arrival
 *    polling 사이의 1초 이내 발생 — 1.5s면 GPS 1 tick 이상 흡수.
 *  - 너무 짧으면(예: 300ms) lock 해제 후 즉시 새 lock을 못 잡으면 null POST가 그대로 backend로
 *    가서 race 미차단.
 *  - 너무 길면(예: 5000ms) 진짜 trip 종료(사용자가 의도적으로 lock 해제) 시 backend KV 갱신이
 *    지연돼 BG cron이 옛 lock으로 한 사이클 더 폴링 가능.
 */
export const BOARDING_LOCK_RELEASE_DEBOUNCE_MS = 1500;

/**
 * Free-trip sentinel destinationId (#978, PR #955 follow-up).
 *
 * 사용자가 명시 destination을 설정하지 않은 free trip 상태에서도 transfer auto-detect로
 * boardingLock을 자동 hydrate하려면 lock storage 스키마상 destinationId가 비어 있을 수 없다
 * (#915 정책: 모든 lock은 trip 단위 id로 trip과 1:1 매핑되며, destination 변경 시 자동 release).
 *
 * 이 sentinel을 destinationId로 사용해 lock을 생성하면:
 *   1) 사용자가 나중에 실제 destination을 설정하는 순간, controller의 destination 변경 effect
 *      (lock.destinationId !== input.destinationId)가 발동해 sentinel lock을 자동 invalidate.
 *      → 다른 trip의 stale lock cross-talk 차단.
 *   2) sentinel이 유지되는 동안은 같은 free trip으로 간주, lock 그대로 유지.
 *
 * 값은 일반 destination id(`stn-*`, UUID 등)와 충돌하지 않도록 `__` prefix.
 */
export const FREE_TRIP_DESTINATION_SENTINEL = '__free-trip-sentinel__';

/**
 * #2130 (B-1 Tier 2) — 지하 fallback context-heal 대기 시간(ms).
 *
 * trip 등록 후 이 시간 동안 `currentStation`이 여전히 미해소(GPS dead zone)이고 지하 판정
 * (subsurface)이면 route 출발역 기준으로 boarding-prompt context를 heal한다. 60s로 둔 이유:
 *  - GPS/fusion 폴링 주기(30s)의 2 tick — 일시적 fix 지연을 최소 1~2회 흡수한 뒤에만 fallback.
 *  - 너무 짧으면(예: 15s) 정상 GPS 해소 중인 trip까지 route-origin 근사치로 stamp해 정밀도 손실.
 *  - 너무 길면(예: 5분) 사용자가 이미 열차에 탑승한 뒤에야 prompt 평가가 시작돼 A1(≤3분) 위반.
 */
export const CONTEXT_HEAL_TIER2_DELAY_MS = 60_000;
