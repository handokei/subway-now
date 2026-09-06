/**
 * BoardingLock 관련 상수 — PR C/D에서 scheduler/알람도 참조해 drift 방지 (#584).
 */

import type { BoardingLock } from '../types/boardingLock';

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

/**
 * #1960 (2026-08-04 RCA 보강) — trip register 실패({ok:false}) 또는 APNs token 미가용 skip 시
 * 재시도 backoff 스케줄(ms). 활성 trip(route+destination 존재) 한정으로만 사용된다.
 *
 * 배경: `useApnsTripRegistration`의 register useEffect는 #703 의도(POST 폭주 방지)로
 * `nextStationEtaSeconds`/`currentStation`을 deps에서 제외한다. 그 결과 register가 실패하거나
 * token이 아직 발급 전이면 deps가 그대로인 한 재시도 기회 자체가 없어, lock이 활성인 짧은
 * window(예: 2026-08-04 아침 trip evidence — lock 활성 07:26:33~07:30:10, 첫 register 성공은
 * lock 해제 직후인 07:30:20) 동안 register가 한 번도 backend에 도달하지 못하면 그 trip은
 * silent push 채널 전체가 하루 종일 비활성으로 남는다.
 *
 * 15s → 30s → 60s로 둔 이유:
 *  - 15s는 APNs 토큰 발급(`getDevicePushTokenAsync`)이 완료되기까지의 전형적 지연을 커버.
 *  - 30s/60s는 backend 일시 장애(cold start, 네트워크 hiccup) 복구 여유를 늘려가며 확인.
 *  - 3회 상한(약 105s 총 대기) 이상 실패하면 실제 장애 가능성이 높아 무한 재시도로 배터리를
 *    소모하기보다 다음 정상 effect cycle(route/destination/lock 변경)에 맡긴다.
 *
 * dedup hash 경로는 불변 — 성공한 register(`ok:true`, `skipped:true` 포함)는 재시도를
 * 트리거하지 않아 #703(POST 폭주 방지) 의도를 보존한다.
 */
export const REGISTER_RETRY_BACKOFF_MS: readonly number[] = [15_000, 30_000, 60_000];

/**
 * #2164 — Tier 1 context-heal(useApnsTripRegistration) 세션당 POST 상한 백스톱.
 *
 * 배경: #2130/#2150의 "세션당 1회 가드"는 heal **시도**(성공 여부 무관) 자체로 세션을 영구
 * 잠갔다. 그 결과 cold-start 이후 첫 실질 전환이 또 다른 off-route 역(GPS 흔들림/인접역
 * 플립)이면 그 1회 실패 시도로 잠기고, 이후 진짜 탑승역(on-route) 전환에도 heal이 재발동하지
 * 않아 context 결손이 trip 내내 지속됐다.
 *
 * #2164 fix: 가드를 "성공 기준"으로 전환 — heal이 context 등록에 실제로 성공했을 때만 세션을
 * 잠근다. 실패(build 실패 또는 POST 네트워크 실패) 시 다음 station 전환에서 재시도를 허용한다.
 * 다만 무제한 재시도는 backend rate limit(10/10min)을 위협하므로, 세션당 heal POST 발사
 * 횟수에 상한을 둔다. `REGISTER_RETRY_BACKOFF_MS.length`(3)와 동일한 상한으로 통일 — 실제
 * 장애 상황이면 다음 정상 effect cycle(route/destination/lock 변경)에 맡긴다.
 *
 * context build 자체가 실패(off-route 역 등)한 경우는 이 상한에 포함하지 않는다 — POST를
 * 내지 않으므로 backend 부담이 없고, 다음 전환에서 다시 시도할 기회를 줘야 하기 때문이다.
 */
export const CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION = 3;

/**
 * #2167 (P2-1, PR #2169 리뷰) — register-retry(#1960)가 발화했으나 같은 세션의
 * context-heal(Tier 1/2) POST가 in-flight라 이번 backoff를 건너뛰고 재예약하는 경우 전용
 * recheck 지연(ms) + 재예약 횟수 상한.
 *
 * 배경: 이 재예약은 실제 register 실패가 아니라 "잠깐 heal이 끝날 때까지 대기"일 뿐이므로
 * `REGISTER_RETRY_BACKOFF_MS`의 attempt 예산을 소모하면 실제 POST 시도가 0회인 채로 3회
 * 상한을 태워버릴 수 있다(P2-1). attempt와 분리된 짧은 recheck 간격을 쓰고, 그 recheck 자체도
 * heal이 비정상적으로 오래 걸리는 상황(POST 응답 지연/네트워크 hang)에 대비해 별도 상한을 둔다
 * — 상한 도달 시엔 일반 backoff(`scheduleRegisterRetry`, attempt 소모)로 전환해 무한 대기를
 * 방지한다.
 *
 * 2s로 둔 이유: 일반적인 register POST 왕복(수백 ms~1~2s)을 커버하면서도 배터리 소모가
 * 미미한 짧은 간격.
 */
export const REGISTER_RETRY_HEAL_BUSY_RECHECK_MS = 2_000;
export const REGISTER_RETRY_HEAL_BUSY_MAX_RESCHEDULES = 5;

/**
 * #2407 (root fix, 08-28 lockless cascade) — trainCode 확정 실패(arrivals null / line 매칭 0건)
 * 상태에서도 사용자 탑 탭 = lock 생성을 보장하기 위한 pending trainCode sentinel.
 *
 * 배경: `tryAutoLock`(useBoardingPromptResponder)이 arrivals 조회 실패/무매칭이면 `createLock`을
 * 아예 호출하지 않고 return해, 사용자가 명시 탭했는데도 lock이 하나도 생기지 않는 회귀가
 * 실탑승에서 확인됐다(#2405/#2406 RED fixture). ADR-014 "명시 탭 = lock 활성과 동급" 정합을
 * 지키려면 train 확정 실패해도 lock 자체는 생성해야 한다 — trainCode만 이 sentinel로 채운다.
 *
 * 설계(빈 문자열 vs sentinel 상수 — sentinel 채택 이유):
 *   - `BoardingLock.trainCode: string`은 이미 여러 소비처가 `.length > 0`/`.startsWith(...)`
 *     같은 명시적 predicate로 검사한다(`isScheduleFallbackTrainCode`의 `SCHED-` prefix가 동일
 *     선례). 빈 문자열('')은 일부 falsy-check(`!lock.trainCode`) 소비처에서는 우연히 안전하게
 *     걸러지지만, 값 비교(`row.trainCode === lock.trainCode`)나 `.startsWith()` 호출부에서는
 *     예외/오탐 가능성이 있어 암묵적 falsy coercion에 의존하는 게 더 위험하다.
 *   - 명시적 sentinel 상수 + `isPendingTrainCode()` predicate가 "이 값이 왜 특별한가"를 grep
 *     한 번으로 드러내고, 향후 코드 리뷰에서 실수로 빠뜨린 consumer를 찾기 쉽다(blast radius
 *     추적 용이).
 *   - `string` 타입을 `string | undefined`로 optional化하는 대안은 BoardingLock을 참조하는
 *     전 소비처(수십 곳, 위 grep 결과)의 타입 가드를 전수 추가해야 해 blast radius가 훨씬 크다.
 *
 * 🔴 소비처는 `lock.trainCode`를 실 trainCode처럼 매칭에 사용하기 전에 반드시
 * `isPendingTrainCode(lock.trainCode)`로 pending 여부를 먼저 판별해야 한다(오탐 금지).
 */
export const PENDING_TRAIN_CODE = 'PENDING-TRAIN-CODE';

/** lock.trainCode가 #2407 fallback lock의 미확정 sentinel인지 판별. */
export function isPendingTrainCode(trainCode: string): boolean {
  return trainCode === PENDING_TRAIN_CODE;
}

/**
 * #2407 Gap B (root fix) — lock이 backend에 도달 가능한 "실" lock인지 판별.
 *
 * pending fallback lock(trainCode=PENDING_TRAIN_CODE)은 `buildBoardingLockMeta`가 backend 등록을
 * 보류하는 sentinel이라 존재해도 backend 관점에서는 lockless와 동일하다. UI가 이를 "탑승
 * 확정됨"처럼 렌더하면(BoardingLockHopCard) 사용자가 실 trainCode를 고를 기회(BoardingTrainList)를
 * 영영 못 만나 deadlock(lockSuggestion만이 유일한 upgrade 경로인데 backend evidence가 없으면
 * lockSuggestion도 안 옴)에 빠진다. 소비처는 이 predicate로 "실 lock" vs "미확정 lock"을
 * 구분해, 미확정이면 lockless와 동일하게 취급(원 train 선택 UI로 유도)해야 한다.
 */
export function isRealBoardingLock(lock: BoardingLock | null): lock is BoardingLock {
  return lock !== null && !isPendingTrainCode(lock.trainCode);
}

/**
 * #2408 (위험1 guard) — pending fallback lock 생성 전 BG_LAST_STATION과 payload.line 모순 판정에
 * 쓰는 신선도 임계값(ms).
 *
 * 배경: `createPendingFallbackLock`은 payload.line/originStation을 위치 검증 없이 신뢰한다.
 * stale prompt(예: 용마산/7호선에서 발사됐는데 실제로는 성수/2호선에 있는 사용자가 뒤늦게 탭)에서도
 * lock을 생성해버리면 틀린 노선으로 lock이 잠기는 회귀가 생긴다. device가 최근에 관측한
 * BG_LAST_STATION(`backgroundLocationTask`가 적재)이 payload.line과 다르면 모순으로 간주해 lock
 * 생성을 skip한다.
 *
 * 5분으로 둔 이유:
 *  - BG task 폴링 주기(30s~수분, 이동 속도에 따라 가변)를 여러 tick 커버해 오탐(일시적 GPS 튐)을
 *    피하면서도, stale prompt가 보통 수 분~수십 분 전 발사분이라는 점을 고려하면 5분 이내 관측치는
 *    "지금 위치"로 신뢰할 만큼 충분히 최근이다.
 *  - 너무 짧으면(예: 1분) BG task가 저빈도 모드(이동 없음/절전)일 때 최근 관측치가 없어 guard가
 *    거의 작동하지 않는다.
 *  - 너무 길면(예: 30분) 실제로 이동한 사용자의 오래된 위치를 "현재 위치"로 오판해 정상 fallback
 *    lock 생성까지 잘못 skip할 위험이 커진다.
 */
export const FALLBACK_LOCK_POSITION_GUARD_FRESHNESS_MS = 5 * 60_000;

/**
 * #2197 (ADR-025 client 절반) — 이미 등록된 trip의 route/destination 변경 재-POST를
 * coalesce하는 debounce(ms).
 *
 * 배경: `useApnsTripRegistration`은 route/destination 변경을 즉시 발사한다(#767 lock-release
 * debounce와 달리 미적용). GPS/fusion 재계산이 짧은 시간 안에 route를 연속 갱신하면(환승 hop
 * 진입 직후 store 업데이트 race 등) 같은 세션에 대해 여러 POST /trips가 연쇄 발사되어 자체
 * rate-limit(10/10min) 소진을 device가 스스로 가속한다.
 *
 * `BOARDING_LOCK_RELEASE_DEBOUNCE_MS`(1500ms)와 동일한 값을 사용 — 같은 성격의 "짧은 창의
 * 연쇄 재등록을 흡수" 목적이며 근거(GPS 1 tick 이상 흡수)도 동일하다.
 *
 * **최초 등록(이전 trip 없음)에는 적용하지 않는다** — 신규 목적지 설정은 즉시성이 우선.
 * `lastRouteSigRef`/`lastDestinationIdRef`가 모두 null(이전 register 없음)인 경우가 이에
 * 해당하며, 이 상수는 오직 "이미 등록된 trip"의 이후 변경에만 쓰인다.
 */
export const ROUTE_CHANGE_DEBOUNCE_MS = 1500;

/**
 * #2438 (LA 인터랙티브 프롬프트 piece ⑤) — `useLiveActivityIntentBridge`가 App Group의
 * pending boarding intent(LA 버튼 탭)를 foreground에서 재확인하는 짧은 폴링 주기(ms).
 *
 * native가 push event 없이 App Group write만 하는 pull 모델이라, 마운트 + AppState 'active'
 * 진입 외에도 앱이 이미 foreground인 동안 버튼을 탭한 케이스(위젯/잠금화면에서 LA 버튼 탭 시
 * 앱은 이미 열려 있을 수 있음)를 흡수하려면 짧은 재확인이 필요하다.
 *
 * 5s로 둔 이유: `usePolling`이 이미 AppState 'active' 진입 시 즉시 1회 재확인하므로, 이 값은
 * "foreground 유지 중 버튼 탭"만 커버하면 된다 — 사용자가 버튼을 탭하고 화면을 계속 보고
 * 있어도 5s 이내 lock이 반영되면 체감 지연이 크지 않다. 배터리 부담은 로컬 App Group 읽기
 * 1회(AsyncStorage/UserDefaults 수준)라 무시할 만하다.
 */
export const LIVE_ACTIVITY_INTENT_POLL_MS = 5_000;
