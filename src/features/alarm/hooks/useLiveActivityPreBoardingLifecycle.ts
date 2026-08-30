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
 *   - destination 설정 + lock 없음 → pre-boarding LA start(or update) + boardingPhase 컨텍스트.
 *   - lock 생성됨(탑승 확정) → 이 훅은 관여를 멈춘다. 이후 LA 콘텐츠는 기존 GPS-트리거 파이프라인
 *     (`stationPipeline.ts` / `HomeScreen`의 `updateStationNotification`)이 소유한다 — 그 경로는
 *     boardingPrompt 필드를 넘기지 않으므로 다음 정기 tick에서 boardingPhase가 자연히 비워진다
 *     ("or 미세팅" 허용, 스펙 명시).
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
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { clearStationNotification } from '../utils/stationNotification';
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
 */
function buildPreBoardingLiveActivityData(
  destination: Station,
  origin: Station | null,
  tripToken: string | null,
): LiveActivity.LiveActivityData {
  const data: LiveActivity.LiveActivityData = {
    stationName: origin ? getStationDisplayName(origin) : i18next.t('widget.detecting'),
    lineName: origin ? LINE_NAMES[origin.line] : '',
    lineColorHex: origin ? LINE_COLORS[origin.line] : PRE_BOARDING_UNKNOWN_LINE_COLOR_HEX,
    distanceM: 0,
    destinationName: getStationDisplayName(destination),
    boardingPhase: 'pre-boarding',
  };
  if (tripToken) {
    data.boardingPromptTripToken = tripToken;
  }
  if (origin) {
    data.boardingPromptOriginStation = getStationDisplayName(origin);
    data.boardingPromptLine = origin.line;
  }
  return data;
}

export function useLiveActivityPreBoardingLifecycle(): void {
  const destination = useDestinationStore((s) => s.destination);
  const tripOrigin = useDestinationStore((s) => s.tripOrigin);
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

    if (lock) {
      // 탑승 확정 — 콘텐츠 소유권을 GPS-트리거 파이프라인에 넘긴다.
      preBoardingActiveRef.current = false;
      return;
    }

    if (!LiveActivity.isLiveActivityEnabled()) return;

    const tripToken = getCurrentTripCorrIdSync();
    const data = buildPreBoardingLiveActivityData(destination, tripOrigin, tripToken);
    preBoardingActiveRef.current = true;
    LiveActivity.updateLiveActivity(data).catch((e) => {
      log.warn('pre-boarding LA 갱신 실패', e);
    });
  }, [destination, tripOrigin, lock]);
}
