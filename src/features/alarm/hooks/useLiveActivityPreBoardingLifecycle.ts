/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: destination(route 슬라이스)이 설정되는 시점에 pre-boarding
 * Live Activity를 확보하는 훅이라 route 슬라이스의 store를 직접 읽어야 한다. tripCorrId(observability
 * 슬라이스)도 trip 식별용으로 필요 — alarm 슬라이스의 다른 hook(useApnsTripRegistration 등)과
 * 동일 패턴. orchestration이 본질이라 file-level disable로 옵트인.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #2436 — LA 인터랙티브 프롬프트 piece ②. destination 설정 시점부터 pre-boarding 상태
 * Live Activity를 확보해 후속 piece(버튼/AppIntent)가 얹힐 토대를 만든다.
 *
 * 트리거:
 *   - destination 설정 + lock 없음 → pre-boarding LA start(or update). #2854부터 boardingPhase/
 *     버튼 컨텍스트(#2434)는 싣지 않는다 — 평범한 추적 content만(배너 없음). 트립 시작부터
 *     무조건 "탑승하셨나요" 유령 배너가 뜨던 회귀였다. 열차 임박 시의 phase 전환 + alert는
 *     이제 backend(`fireBoardingPromptForAnchor`, PR-A #2854)가 LA alert push로 전담한다.
 *   - lock 생성됨(탑승 확정) → 이 훅은 관여를 멈춘다. 이후 LA 콘텐츠는 기존 GPS-트리거 파이프라인
 *     (`stationPipeline.ts` / `HomeScreen`의 `updateStationNotification`)이 소유한다 — 그 경로는
 *     boardingPrompt 필드를 넘기지 않으므로 다음 정기 tick에서 boardingPhase가 자연히 비워진다
 *     ("or 미세팅" 허용, 스펙 명시). (#3221 PR-4 — lock이 device evidence로 자동 확정된 직후의
 *     "추적중" 배너 갱신(구 #2528 D6)은 폐기했다. 질문은 답해진 상태이고 탑승 LA는 응답 시 닫힌다.)
 *   - destination 해제(non-null→null) → 이 훅이 스스로 시작한 pre-boarding 세션만 종료.
 *     (lock 활성 중 destination이 해제되는 통상 trip 종료는 HomeScreen이 이미 `clearStationNotification`을
 *     호출하므로 중복 종료를 피한다 — `preBoardingActiveRef`로 소유권 구분.)
 *
 * dedup (기존 GPS-트리거 LA와 단일 인스턴스 보장):
 *   `ensureLiveActivityRegistered`(liveActivityPushChannel.ts)는 backend push 등록 세션 시작
 *   전용이라, 세션이 없다고 판단되면 native `startLiveActivity`를 호출한다 — native
 *   `LiveActivityManager.start(data:)`는 호출 즉시 `endAllActivities()`로 기존 Activity를
 *   종료하고 새로 만든다. GPS 파이프라인은 lock 전 구간에서 `LiveActivity.updateLiveActivity`를
 *   직접 호출(트립 미등록이라 push 채널을 타지 않음)하므로 그 세션은 `activeTripToken`에
 *   기록되지 않는다. 이 상태에서 `ensureLiveActivityRegistered`를 호출하면 이미 떠 있는 GPS LA를
 *   모른 채 start를 시도해 강제 종료 후 재생성(깜빡임)이 발생한다.
 *
 *   반면 native `LiveActivityManager.update(data:)`는 활성 Activity가 있으면 update만, 없으면
 *   내부적으로 `start`를 호출하는 진짜 "start-vs-update 판정"을 이미 구현하고 있다 — GPS
 *   파이프라인이 pre-lock 구간에 쓰는 것과 동일한 호출. 이 훅도 같은 `LiveActivity.updateLiveActivity`
 *   를 사용해 단일 Activity 인스턴스를 보장한다(이중 start 없음).
 *
 * additive: destination 없거나 lock 있으면 아무 것도 하지 않는다 — 기존 렌더와 100% 동일.
 * 네이티브(Swift)/버튼/AppIntent 변경 없음. JS만.
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import i18next from 'i18next';
import * as LiveActivity from 'live-activity';
import type { Station } from '../../../shared/types/station';
import { LINE_COLORS, LINE_NAMES } from '../../../shared/constants/lineColors';
import { getStationDisplayName } from '../../../shared/utils/stationDisplay';
import { getStationById, type Route } from '../../../shared/utils/stationRoute';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { computeJourneyLaFields } from '../../route/utils/journeyLaFields';
import { clearStationNotification } from '../utils/stationNotification';
import { startAmbientLiveActivityTokenRegistration } from '../utils/liveActivityPushChannel';
import { logLaWrite } from '../utils/alarmLog';
import { resolveGpsFreeOrigin } from '../utils/gpsFreeOrigin';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('useLiveActivityPreBoardingLifecycle');

/**
 * GPS가 아직 출발역을 확정하지 못한 상태에서 pre-boarding LA를 보여줄 때 쓰는 중립 placeholder
 * 색상(iOS system gray). 노선이 확정되면(originStation 확보) 즉시 실제 노선색으로 대체된다.
 */
const PRE_BOARDING_UNKNOWN_LINE_COLOR_HEX = '#8E8E93';

/**
 * pre-boarding 단계 Live Activity content. GPS로 확정된 출발역(origin)이 있으면 실제 역/노선
 * 정보를, 없으면 "감지 중"(기존 `widget.detecting` 관례) placeholder를 stationName에 싣는다.
 * distanceM은 이 단계에선 의미가 없어 0 고정 — destinationName이 있으면 위젯은 거리 대신
 * "→ 목적지" 라우트 뷰를 그리므로 화면에 노출되지 않는다.
 *
 * #2854 — boardingPhase/버튼 컨텍스트(#2434)는 의도적으로 싣지 않는다. 트립 시작부터 무조건
 * "탑승하셨나요" 배너를 띄우던 유령 pre-boarding 배너가 원인이었다 — 임박 전환은 이제
 * backend(`fireBoardingPromptForAnchor`, PR-A #2854)가 LA alert push로 전담하므로, 이 훅은
 * 평범한 추적 content만 깔아둔다(phase 미설정 → 위젯이 배너를 그리지 않음).
 */
function buildPreBoardingLiveActivityData(
  destination: Station,
  origin: Station | null,
  route: Route,
): LiveActivity.LiveActivityData {
  return {
    stationName: origin ? getStationDisplayName(origin) : i18next.t('widget.detecting'),
    lineName: origin ? LINE_NAMES[origin.line] : '',
    lineColorHex: origin ? LINE_COLORS[origin.line] : PRE_BOARDING_UNKNOWN_LINE_COLOR_HEX,
    distanceM: 0,
    destinationName: getStationDisplayName(destination),
    // #3221 — 탑승 전(서버 갱신 전)에도 남은 시간·진행 막대·다음 역을 채운다. 출발역이 미확정이면 산출 불가라 생략.
    ...(origin ? computeJourneyLaFields(route, origin, destination) : {}),
  };
}

/**
 * #2782 — origin 해석 결과의 출처(custom/lock/trip/none)를 관측용으로 라벨링한다.
 * `resolveGpsFreeOrigin`은 `[customOrigin, boardingLockStation, tripOrigin]` 우선순위 순으로
 * 첫 매치만 반환하므로, resolvedOrigin이 custom/lock 어느 쪽도 아니면 남은 유일한 가능성은
 * tripOrigin이다(그 외 출처는 resolveGpsFreeOrigin이 만들어낼 수 없다) — 그래서 tripOrigin
 * 자체를 인자로 받지 않아도 라벨링이 정확하다.
 */
function describeOriginSource(
  customOrigin: Station | null,
  boardingLockStation: Station | null,
  resolvedOrigin: Station | null,
): 'custom' | 'lock' | 'trip' | 'none' {
  if (!resolvedOrigin) return 'none';
  if (customOrigin && customOrigin.id === resolvedOrigin.id) return 'custom';
  if (boardingLockStation && boardingLockStation.id === resolvedOrigin.id) return 'lock';
  return 'trip';
}

/**
 * #2782 — `route`는 호출자(HomeScreen)가 이미 계산해둔 값을 그대로 받는다(`useApnsTripRegistration`/
 * `buildBoardingPromptContext`와 동일 패턴 — 이 훅은 GPS currentStation을 아예 보지 않으므로
 * 자체적으로 route를 재계산할 입력이 없다). `resolveGpsFreeOrigin`의 R-3(route 밖 노선 후보
 * 필터)에 필요.
 */
export function useLiveActivityPreBoardingLifecycle(route: Route): void {
  const destination = useDestinationStore((s) => s.destination);
  const tripOrigin = useDestinationStore((s) => s.tripOrigin);
  const customOrigin = useDestinationStore((s) => s.customOrigin);
  const lock = useBoardingLockStore((s) => s.lock);

  // 이 훅이 직접 시작한 pre-boarding 세션인지 추적 — lock 전환/GPS 파이프라인이 소유하게 된
  // 세션까지 이 훅이 대신 종료하지 않도록 소유권을 구분한다.
  const preBoardingActiveRef = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    if (!destination) {
      if (preBoardingActiveRef.current) {
        preBoardingActiveRef.current = false;
        clearStationNotification().catch((e) => {
          log.warn('pre-boarding LA 종료 실패', e);
        });
      }
      return;
    }

    // #2782 — GPS 무관 origin 후보(우선순위: customOrigin > boardingLockStation > tripOrigin).
    // 이 훅은 GPS currentStation을 보지 않으므로 1번 인자는 항상 null — R-2(currentStation 있으면
    // 그대로 반환) 분기는 여기서 트리거되지 않고 항상 후보 체인이 평가된다. 등록 경로
    // (`useApnsTripRegistration.ts`)·boarding-prompt context(`boardingPromptContext.ts`)와
    // 동일 해석기·동일 후보 — 사본 금지(L21).
    const boardingLockStation = lock ? getStationById(lock.boardingStationId) ?? null : null;
    const resolvedOrigin = resolveGpsFreeOrigin(null, [customOrigin, boardingLockStation, tripOrigin], route);
    const originSource = describeOriginSource(customOrigin, boardingLockStation, resolvedOrigin);
    log.info(
      `origin 해석: source=${originSource}${resolvedOrigin ? ` station=${resolvedOrigin.name}` : ''}`,
    );

    if (lock) {
      // #3221 PR-4 (U3=A) — 자동락 "추적중" 배너(구 #2528 D6)는 폐기했다. lock은 사용자 응답/탭으로만 생기고
      // (자동 lock 없음, 2026-10-24) 질문은 이미 답해진 상태이며 탑승 LA는 응답 시 닫힌다. 여기서는 소유권만 넘긴다.
      // 탑승 확정 — 콘텐츠 소유권을 GPS-트리거 파이프라인에 넘긴다.
      preBoardingActiveRef.current = false;
      return;
    }

    if (!LiveActivity.isLiveActivityEnabled()) return;

    const data = buildPreBoardingLiveActivityData(destination, resolvedOrigin, route);
    preBoardingActiveRef.current = true;
    // #2667 — 이 update가 native `start()`로 fall-through해 Activity를 만들면 push token이
    // emit된다. 구독이 없으면 그 token이 버려져 backend가 LA push를 영영 못 보낸다(실측
    // laPushDelivery=0/0). 구독 시작은 멱등.
    startAmbientLiveActivityTokenRegistration();
    LiveActivity.updateLiveActivity(data)
      .then(() => {
        // #2735 PR-1 — D5 writer(pre-boarding 시작/갱신). lock 전이라 권위 판정 대상 아님.
        logLaWrite({ writer: 'D5', source: 'pre-boarding', data, authority: 'n/a' });
      })
      .catch((e) => {
        log.warn('pre-boarding LA 갱신 실패', e);
      });
  }, [destination, tripOrigin, customOrigin, lock, route]);
}
