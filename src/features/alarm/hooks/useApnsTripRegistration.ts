/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * APNs token 발급 → alarm-worker(#338)에 활성 트립 등록.
 *
 * 1. 마운트 시 `Notifications.getDevicePushTokenAsync()`로 device token 발급
 * 2. `addPushTokenListener`로 토큰 갱신 감지 → 활성 트립 있으면 재등록
 * 3. route + destination 변경 시 register, 둘 다 비면 clear
 *
 * 권한 거부/토큰 실패 시 graceful skip — 사전 예약(#334)만으로 baseline 동작.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import i18next from 'i18next';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { routeSignature, getStationById } from '../../../shared/utils/stationRoute';
import { registerActiveTrip, clearActiveTrip, type AlarmBoardingLock } from '../api/alarmBackend';
import { routeToWaypoints } from '../../route/utils/routeWaypoints';
import { buildBoardingLockMeta } from '../utils/buildBoardingLockMeta';
import { cancelAllSafetyNetAlarms } from '../utils/safetyNetScheduler';
import { clearBackendSsotMirror } from '../utils/backendSsotMirror';
import { logCrossTripMirrorSkip } from '../utils/alarmLog';
import {
  buildBoardingPromptContext,
  type BoardingPromptContext,
  type GpsFix,
} from '../utils/boardingPromptContext';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import {
  BOARDING_LOCK_RELEASE_DEBOUNCE_MS,
  CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION,
  CONTEXT_HEAL_TIER2_DELAY_MS,
  REGISTER_RETRY_BACKOFF_MS,
  REGISTER_RETRY_HEAL_BUSY_MAX_RESCHEDULES,
  REGISTER_RETRY_HEAL_BUSY_RECHECK_MS,
} from '../../../shared/constants/boardingLock';
import { createLogger } from '../../../shared/utils/logger';
import { getRegisteringApnsEnv, warmupConfirmedApnsEnv } from '../../../shared/utils/apnsEnv';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';

/**
 * #1895 — i18next.language를 backend가 인식하는 SupportedLocale로 정규화.
 * SUPPORTED_LANGUAGES (`src/shared/i18n/types.ts`)와 1:1 매핑. 미지원/undefined는 backend가
 * ko fallback 처리하므로 송신 자체를 skip해 트래픽 절약 (graceful — payload 미포함).
 */
function resolveLocaleForBackend(): 'ko' | 'en' | 'ja' | 'zh' | undefined {
  const lang = i18next.language;
  if (lang === 'ko' || lang === 'en' || lang === 'ja' || lang === 'zh') return lang;
  return undefined;
}

const logger = createLogger('ApnsTripRegistration');

export interface UseApnsTripRegistrationInputs {
  route: Route;
  destination: Station | null;
  /** 첫 도착역까지 ETA(초). null이면 alarm scheduler와 동일하게 static fallback이 백엔드에서 진행. */
  nextStationEtaSeconds: number | null;
  /** 현재 추정 출발역. 중간역(intermediate) 펼침에 사용 (#416). 미제공 또는 null이면 legacy 모드. */
  currentStation?: Station | null;
  /**
   * 활성 BoardingLock (#622). 사용자가 탑승 열차를 확정하면 backend가 trainCode 단위로 추적·
   * reschedule할 수 있게 schema 변환 후 register payload에 포함한다. null이면 backend는 기존
   * anchor waypoint 폴링으로 fallback.
   */
  boardingLock?: BoardingLock | null;
  /**
   * #903 (Seam G) — 기압계 dP/dt가 지하 진입을 시사하는가. true면 backend로 함께 전달되어
   * consecutiveEtaMissing threshold를 5→10으로 늘려 일시 GPS/arrival 누락에 더 인내한다.
   * 미설정/false면 기존 threshold(5) 유지 — 기압계 미지원 환경 graceful.
   */
  subsurface?: boolean;
  /**
   * #1923 — 사용자 명시 의향 토글 (boardingPrompt [탑승] 응답 / BoardingTrainList
   * 직접 탭 중 하나라도 행하면 true; "C 토글"이라는 별도 UI는 존재하지 않는다,
   * #1961 정정). `useUserIntentStore`에서 읽어 전달. backend가 lockless
   * intermediate station-passed silent push 발사 분기에 사용
   * (`trip.infoModeEnabled && waypoint.kind === 'intermediate'`). admin kill
   * switch(#1967)로 이 게이트 자체를 backend deploy 없이 우회 가능.
   * 미지정/false: 기존 동작 그대로 — boardingLock 부재 시 `lockMissing` skip.
   */
  infoModeEnabled?: boolean;
  /**
   * #2032 (Issue D) — 등록 시점 device 취침모드 상태. **monitoring 전용 (ADR-023)**.
   * `useSettingsStore.sleepMode`를 그대로 전달. backend는 이 값으로 push 발사 결정을
   * 바꾸지 않으며(오로지 저장/로그), skip 원인 자동 분류 + evidence 재구성에만 사용한다.
   * ADR-023 §"Backend 발사 경로 5개 (모두 sleep 무관)" 유지.
   * 미지정/false: 필드 미송신 (graceful) — backend 저장값 undefined 유지.
   */
  sleepMode?: boolean;
  /**
   * #2130 (B-2) — 등록 시점 GPS fix (lat/lng + accuracy). boarding-prompt 근접 게이트
   * (backend B-backend, 별도 PR)의 입력으로 promptGeoContext에 동봉된다. GPS fix가 아예
   * 없으면(GPS 미해소/권한 거절) 필드 자체를 생략 — backend는 부재를 관대하게(지하/구 클라
   * 호환) 통과시킨다.
   */
  gpsFix?: GpsFix | null;
  /**
   * #2130 (B-1 Tier 2) — 등록 후 60초 내 `currentStation`이 여전히 미해소(지하 dead zone
   * 등)이고 subsurface 판정일 때 fallback으로 사용할 route 출발역. 사용자가 역사 안에서
   * route를 잡았다는 가정 — GPS 무관 persist 값(예: `useDestinationStore.tripOrigin`)을
   * 그대로 전달한다.
   */
  routeOriginStation?: Station | null;
}

/**
 * `nextStationEtaSeconds`로부터 알람 발사 예상 epoch ms를 산출한다.
 * 백엔드의 5분 윈도우 진입 판정용 — 정확하지 않아도 reschedule으로 보정된다.
 */
function deriveAlarmAtEpochMs(nextStationEtaSeconds: number | null, now: number): number {
  if (nextStationEtaSeconds != null && nextStationEtaSeconds > 0) {
    return now + nextStationEtaSeconds * 1000;
  }
  // 알 수 없으면 즉시 — 백엔드는 첫 폴링에서 윈도우 진입으로 판단.
  return now;
}

interface RegisterCallInputs {
  token: string;
  route: NonNullable<Route>;
  destination: Station;
  nextStationEtaSeconds: number | null;
  currentStation: Station | null;
  boardingLock: BoardingLock | null;
  /** #903 (Seam G) — 기압계 subsurface 신호. true면 backend threshold 5→10. */
  subsurface: boolean;
  /** #1923 — 사용자 명시 의향 토글. true면 backend lockless intermediate gate 활성. */
  infoModeEnabled: boolean;
  /** #2032 (Issue D) — device 취침모드 상태. backend monitoring 전용 (ADR-023 결정 gate 미사용). */
  sleepMode: boolean;
  /** 같은 trip 세션 동안 고정되는 epoch ms. backend `isSameSession` 판정 키(#589). */
  createdAt: number;
  /**
   * #1284 — 직전 사이클에서 성공적으로 빌드된 boarding-prompt 컨텍스트 캐시.
   * currentStation이 BG GPS 누락으로 일시 null이 됐을 때 fallback으로 사용해
   * backend cron 진입 시점에 컨텍스트가 반드시 존재하도록 보장한다.
   */
  cachedPromptContext: BoardingPromptContext | null;
  /**
   * #2130 (B-1 Tier 2) — 미리 빌드된 context를 그대로 사용(currentStation 기반 fresh 빌드
   * 및 cache fallback을 모두 건너뜀). `undefined`면 기존 fresh-build 경로, `null`이면
   * "빌드 실패로 이번 사이클은 context 없음"을 명시.
   */
  promptContextOverride?: BoardingPromptContext | null;
  /** #2130 (B-2) — 등록 시점 GPS fix. promptGeoContext 근접 스탬프 입력. */
  gpsFix?: GpsFix | null;
}

/**
 * BoardingLock의 내용 기반 dedup signature. main effect의 deps key와 token-refresh 경로의
 * `lastSentLockSigRef` 갱신에 동일 포맷을 사용해야 #767 release 판정이 일관 — 한 곳에서 빌드.
 */
function lockSig(lock: BoardingLock | null): string | null {
  return lock ? `${lock.trainCode}|${lock.boardingLine}|${lock.boardedAt}` : null;
}

/**
 * #1366 Layer 2 — route ↔ lock line 일치 검증.
 *
 * 환승 hop 진입 시 frontend store 업데이트 race로 새 leg의 trainCode를 가진 lock이
 * 이전 leg의 route 상태에서 effect를 trigger할 수 있다. callRegister가 stale route로
 * boardingLock metadata를 빌드하면 trainCode(새 leg) + segmentStations(이전 leg) 조합이
 * backend로 전송되어 cron "trainCode not found in arrivals" 회귀 → trip auto-end로 이어진다.
 *
 * route의 첫 leg line을 추출해 lock.boardingLine과 비교:
 *  - 일치 → consistent (정상 진행)
 *  - 불일치 → route 업데이트 전 lock 변경. 본 effect 사이클에서는 lock 미전송 — 다음
 *    route 업데이트 시 일관 상태로 재시도.
 *
 * lock 또는 route 가 null이면 검증 대상 없음(true).
 */
export function isLockConsistentWithRoute(lock: BoardingLock | null, route: Route): boolean {
  if (!lock || !route) return true;
  let firstLegLine: string | null = null;
  if (route.type === 'direct') firstLegLine = route.line;
  else if (route.type === 'transfer') firstLegLine = route.fromLine;
  else if (route.type === 'multi-transfer' && route.transfers.length > 0)
    firstLegLine = route.transfers[0].fromLine;
  if (firstLegLine === null) return true;
  return firstLegLine === lock.boardingLine;
}

/** 두 호출처(token refresh / main effect)의 register 페이로드 빌드를 단일화. */
async function callRegister(
  input: RegisterCallInputs,
): Promise<
  Awaited<ReturnType<typeof registerActiveTrip>> & {
    hadPromptContext: boolean;
    /** #2130 (B-1) — 실제로 송신된 context(있으면). 호출자가 캐시(`lastPromptContextRef`)에
     * 반영해 Tier 1/Tier 2 heal 결과가 이후 register에도 이어지도록 한다. */
    promptContext: BoardingPromptContext | null;
  }
> {
  // #622: BoardingLock metadata 빌드. lock의 boardingStationId로 station name 조회 후 schema 변환.
  // 조회/추론 실패 시 null → backend는 anchor waypoint 폴링으로 fallback (기존 동작).
  //
  // #1366 Layer 2 — route ↔ lock line 일치 검증. 환승 hop 진입 시 store 업데이트 race로
  // route는 아직 이전 leg, lock은 새 leg인 transient 상태가 관측된다. 이 상태에서 metadata를
  // 빌드하면 trainCode(새) + segmentStations(이전) stale 결합이 backend로 송신돼 cron
  // "trainCode not found" 회귀(item 4)를 유발한다. 불일치면 본 사이클에서 lock metadata 없이
  // POST → 다음 effect 사이클이 일관 상태에서 정확한 lock을 전송한다 (trip 본체는 정상 진행).
  let boardingLockMeta: AlarmBoardingLock | null = null;
  if (input.boardingLock && isLockConsistentWithRoute(input.boardingLock, input.route)) {
    const boardingStation = getStationById(input.boardingLock.boardingStationId);
    if (boardingStation) {
      boardingLockMeta = buildBoardingLockMeta({
        lock: input.boardingLock,
        route: input.route,
        destinationName: input.destination.name,
        boardingStationName: boardingStation.name,
      });
    }
  } else if (input.boardingLock) {
    logger.info('boarding-lock: skip metadata (route ↔ lock line mismatch, transient transfer state)');
  }

  // #1028 / #1284: boarding-prompt 평가 컨텍스트 (#819). 둘 다 있어야 backend가 9단 게이트를
  // 돌리므로 항상 함께 송신. currentStation이 BG GPS 누락으로 일시 null이면 캐시된 컨텍스트를
  // fallback으로 사용 — backend cron 진입 전 최소 한 번은 컨텍스트가 stamped되도록 보장.
  //
  // #1921 — lock 활성 시 lock.boardingLine + currentStation 우선 stamp. cross-trip 자동 전환에서
  // route 원본 line이 현재 leg와 어긋나도 stale stamp 회귀 차단.
  // #2130 (B-1 Tier 2) — 미리 빌드된 override가 있으면 fresh 빌드/cache fallback을 모두
  // 건너뛰고 그대로 사용 (route 출발역 기준 heal — GPS 스탬프 없이 송신).
  let promptContext: BoardingPromptContext | null;
  if (input.promptContextOverride !== undefined) {
    promptContext = input.promptContextOverride;
  } else {
    const freshContext = buildBoardingPromptContext({
      route: input.route,
      currentStation: input.currentStation,
      destination: input.destination,
      lock: input.boardingLock,
      gpsFix: input.gpsFix,
    });
    promptContext = freshContext ?? input.cachedPromptContext;
  }

  // #1895 — i18next.language를 backend가 인식하는 SupportedLocale로 정규화.
  // backend는 미송신 시 ko fallback이므로 비지원 locale은 송신 자체 skip.
  const locale = resolveLocaleForBackend();

  // #1897 (RC-5) — 마지막으로 backend가 confirm한 apnsEnv stamp 우선 사용. 부재 시 build env
  // (`resolveApnsEnv()`)로 자연 fallback. self-heal 발동 횟수를 0에 수렴시키는 핵심 wire.
  const apnsEnv = await getRegisteringApnsEnv();

  const result = await registerActiveTrip({
    token: input.token,
    route: input.route,
    destination: input.destination.id,
    waypoints: routeToWaypoints(input.route, input.destination.name, input.currentStation),
    alarmAtEpochMs: deriveAlarmAtEpochMs(input.nextStationEtaSeconds, Date.now()),
    apnsEnv,
    createdAt: input.createdAt,
    // #2120 — trip 인스턴스 corrId. null 허용 — sync cache 미수화 시점에도 register 자체는 진행.
    corrId: getCurrentTripCorrIdSync(),
    ...(boardingLockMeta ? { boardingLock: boardingLockMeta } : {}),
    // #819 / #1028 — boarding-prompt 평가/표시 컨텍스트. 짝으로만 송신.
    ...(promptContext
      ? {
          promptGeoContext: promptContext.promptGeoContext,
          promptDisplay: promptContext.promptDisplay,
        }
      : {}),
    // #903 (Seam G) — 기압계 subsurface ON일 때만 송신. OFF/false는 필드 누락(graceful).
    ...(input.subsurface ? { subsurface: true } : {}),
    // #1895 — device locale (boarding-prompt push 본문 4언어 분기용). 미지원 locale은 송신 skip.
    ...(locale ? { locale } : {}),
    // #1923 — 사용자 명시 의향 토글 ON일 때만 송신. false/미설정은 필드 누락(graceful, backend는 false default).
    ...(input.infoModeEnabled ? { infoModeEnabled: true } : {}),
    // #2032 (Issue D) — device 취침모드 상태. ON일 때만 송신. backend는 monitoring 전용으로 저장(ADR-023).
    // false/미설정은 필드 누락(graceful) — backend Trip.sleepModeEnabled=undefined 유지.
    ...(input.sleepMode ? { sleepModeEnabled: true } : {}),
  });
  // #2130 (B-1) — 이번 register가 실제로 promptContext를 포함했는지 + 그 내용을 호출자에게 노출.
  // Tier 1 heal 판정의 SSoT이자, 캐시(`lastPromptContextRef`) 갱신 입력.
  return { ...result, hadPromptContext: promptContext != null, promptContext };
}

export function useApnsTripRegistration({
  route,
  destination,
  nextStationEtaSeconds,
  currentStation = null,
  boardingLock = null,
  subsurface = false,
  infoModeEnabled = false,
  sleepMode = false,
  gpsFix = null,
  routeOriginStation = null,
}: UseApnsTripRegistrationInputs): void {
  // route 객체 reference가 categorized recompute로 자주 바뀌므로 내용 기반 signature로
  // 메모화 — register useEffect deps에 사용해 동일 경로 재등록(POST /trips 폭주) 방지.
  const routeSig = useMemo(() => routeSignature(route), [route]);
  // boardingLock도 reference가 아닌 내용 기반 key로 deps — 상위가 매 렌더 새 객체를 내려도 안전.
  // alarmBackend dedup hash와 동일 필드 사용 (trainCode + line + boardedAt).
  const boardingLockSig = lockSig(boardingLock);
  // 최신 트립 입력을 ref에 보관 — pushTokenListener가 갱신 시 재등록에 사용한다.
  const latestInputsRef = useRef({
    route,
    destination,
    nextStationEtaSeconds,
    currentStation,
    boardingLock,
    subsurface,
    infoModeEnabled,
    sleepMode,
    gpsFix,
    routeOriginStation,
  });
  useEffect(() => {
    latestInputsRef.current = {
      route,
      destination,
      nextStationEtaSeconds,
      currentStation,
      boardingLock,
      subsurface,
      infoModeEnabled,
      sleepMode,
      gpsFix,
      routeOriginStation,
    };
  });

  // #589 — backend `isSameSession`(token+createdAt) 판정용. 같은 trip(같은
  // token+routeSig+destinationId)이 register를 여러 번 호출해도 동일 createdAt을
  // 전달해야 backend의 waypoint advance 보존(#578)이 실제 가동된다.
  const lastSessionKeyRef = useRef<string | null>(null);
  const tripCreatedAtRef = useRef<number>(0);
  const resolveTripCreatedAt = (sessionKey: string): number => {
    if (lastSessionKeyRef.current !== sessionKey) {
      lastSessionKeyRef.current = sessionKey;
      tripCreatedAtRef.current = Date.now();
    }
    return tripCreatedAtRef.current;
  };

  // #767 — 직전 effect cycle이 backend로 송신한 boardingLockSig. lock 해제 race
  // (non-null → null → 새 lock 3 POST) 판정에 사용. 첫 register 시 null로 시작.
  const lastSentLockSigRef = useRef<string | null>(null);

  // #1284 — 직전 사이클에서 성공적으로 빌드된 boarding-prompt 컨텍스트 캐시.
  // destination이 변경(null→non-null 포함)되면 useEffect deps(destination?.id)가 재실행되어
  // 자동으로 최신 컨텍스트로 덮어쓰인다. destination이 같은 trip 안에서 일시 null이 되는 경우는
  // 없으므로 stale context를 잘못된 destination에 stamp할 위험이 없다.
  const lastPromptContextRef = useRef<BoardingPromptContext | null>(null);

  // #1264 (N3) — 직전 effect cycle의 routeSig. routeSig가 전환되면 이전 trip의 사전 예약된
  // `tba:` 알람을 cancel — backend가 보낸 정정 silent push가 stale identifier에 매칭되어
  // 50분간 `revalidate-route-sig-mismatch`로 누락되는 회귀(2026-06-12 user trip)를 차단한다.
  // 첫 setDestination(이전 sig 없음)에는 cancel 호출 X — 불필요한 OS 호출 방지.
  const lastRouteSigRef = useRef<string | null>(null);

  // #1704 (d) — 직전 effect cycle의 destination.id / boardingLockSig. routeSig는 같지만
  // destination 또는 lock 내용이 바뀌면 (예: 같은 line·hop 수의 다른 destination) routeSig
  // 단독 게이트가 전환을 감지 못해 stale tba: 사전 예약이 OS queue에 잔존한다. 2026-06-23
  // 사용자 trip evidence: 14:18 2차 trip 등록 직후 1차 trip의 공덕/군자 stale fire.
  // 첫 register(이전 값 없음)에는 cancel 호출 X — 신규 trip은 cancel할 대상 없음.
  const lastDestinationIdRef = useRef<string | null>(null);
  const lastBoardingLockSigRef = useRef<string | null>(null);

  // #2130 (B-1) — 직전 register가 promptContext 없이 나갔는지 여부. Tier 1 heal 트리거의
  // SSoT — registerFromLatestInputs가 매 호출마다 callRegister의 실제 결과로 갱신한다.
  const lastRegisterMissingContextRef = useRef(false);
  // #2130 (B-1) / #2164 — heal에 **성공**(context가 backend에 실제로 전달)한 세션
  // key(`routeSig:destinationId`). Tier 1/Tier 2가 공유. #2164 이전에는 heal **시도**만으로
  // (성공 여부 무관) 이 값을 세팅해, 실패한 시도가 세션을 영구 잠가 이후 진짜 탑승역 전환에도
  // heal이 재발동하지 않는 회귀가 있었다 — 반드시 성공했을 때만 세팅한다.
  const healedSessionKeyRef = useRef<string | null>(null);
  // #2164 — 세션당 heal POST 시도가 in-flight 중인지 추적. build 성공 후 register 완료까지의
  // 짧은 창에서 같은 세션에 대해 Tier 1(currentStation 전환)과 Tier 2(60s 타이머)가 동시에
  // 중복 발사하는 것을 막는다(healedSessionKeyRef는 완료 후에만 세팅되므로 그 사이엔 무방비).
  const healInFlightSessionKeyRef = useRef<string | null>(null);
  // #2164 — 세션당 heal POST 발사 횟수 백스톱. build는 성공했지만 POST 네트워크가 계속
  // 실패하는 상황에서 station이 반복 전환돼도 무한 재시도로 backend rate limit(10/10min)을
  // 위협하지 않도록 상한(`CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION`)을 둔다.
  const healAttemptRef = useRef<{ sessionKey: string | null; count: number }>({
    sessionKey: null,
    count: 0,
  });
  // #2130 (B-1 Tier 1) — 직전 렌더의 currentStation.id. null→non-null 전환 감지에 사용.
  // lazy init으로 mount 시점 값을 그대로 캡처 — 이미 non-null로 시작한 trip은 전환 대상이 아니다.
  const prevCurrentStationIdRef = useRef<string | null>(currentStation?.id ?? null);
  // #2130 (B-1 Tier 2) — 지하 fallback 타이머 핸들.
  const tier2TimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // #1960 (2026-08-04 RCA 보강) — register 실패/token 미가용 skip 재시도 상태. sessionKey는
  // `${routeSig}:${destination.id}` — trip 전환/종료 시 무효화되도록 attempt 시점에 재검증한다.
  const registerRetryRef = useRef<{
    sessionKey: string | null;
    attempt: number;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ sessionKey: null, attempt: 0, timer: null });
  // #2167 — register-retry(#1960)의 실제 네트워크 호출이 진행 중인 세션. registerRetryRef의
  // timer는 backoff 타이머가 발화하는 순간 즉시 null로 비워지므로(그 시점부터 실제 POST가 끝날
  // 때까지의 창), "타이머 대기 중" 여부만으로는 이 창을 감지할 수 없다 — 별도 플래그로 추적한다.
  const registerRetryInFlightSessionKeyRef = useRef<string | null>(null);
  // #2167 (P2-1, PR #2169 리뷰) — register-retry가 heal-busy로 인해 recheck 목적으로 재예약한
  // 횟수. `registerRetryRef.current.attempt`(실제 backoff 예산)와 분리해 추적한다 — heal이 잠깐
  // in-flight라 건너뛴 것은 실제 register 실패가 아니므로 attempt 예산을 소모하면 안 된다.
  const registerRetryHealBusyRef = useRef<{ sessionKey: string | null; count: number }>({
    sessionKey: null,
    count: 0,
  });

  /**
   * #2167 — context-heal(Tier 1/2)과 register-retry(#1960)는 같은 원인("register가 backend에
   * context를 전달하지 못함")에 반응하는 독립 루프다. 서로의 in-flight를 모르면 재시도가
   * 대기/진행 중인 세션에 heal이 겹쳐 거의 동일한 payload로 POST가 두 번 나간다(합산 시
   * backend rate limit(10/10min) 여유 소진 — 이슈 #2167 배경).
   *
   * 스케줄러 단일화 대신 상호 in-flight 체크를 택했다: 이미 3개(main effect / Tier 1 / Tier 2)로
   * 나뉜 register 트리거 경로를 하나의 스케줄러로 합치면 각 트리거의 고유 조건(라우트 전환,
   * currentStation 결과 상태, subsurface fallback 지연)을 모두 흡수하는 범용 스케줄러가 필요해
   * diff가 커지고 재시도 루프 sprawl을 오히려 늘린다(fire-path 통합 lesson과 충돌). 반면 in-flight
   * 체크는 기존 세 루프의 구조를 그대로 두고 "발사 직전 한 줄 가드"만 추가하면 된다 — 더 작고
   * 안전한 diff.
   *
   * register-retry가 세션에 대해 대기(backoff 타이머 armed) 또는 실행 중이면 heal은 스스로
   * POST하지 않고 skip한다: 재시도가 실제 발화할 때 `registerFromLatestInputs`가 그 시점의
   * 최신 `currentStation`(이미 heal이 해소하려던 값)을 그대로 사용해 context를 함께 실어
   * 보내므로, 재시도 1건이 재시도 목적과 heal 목적을 동시에 달성한다.
   */
  const isRegisterRetryBusy = (sessionKey: string): boolean =>
    registerRetryInFlightSessionKeyRef.current === sessionKey ||
    (registerRetryRef.current.sessionKey === sessionKey && registerRetryRef.current.timer !== null);

  /**
   * #2129 — 두 register 경로(main effect / token-refresh listener)가 거의 동시에 실행돼도
   * 동일 입력에서 동일 payload를 만들도록 `latestInputsRef` 단일 출처에서 register하는 helper.
   *
   * 이전에는 main effect가 closure로 캡처한 route/currentStation 등을 직접 callRegister에 넘기고,
   * token-refresh listener만 `latestInputsRef.current`를 읽어 두 경로가 서로 다른 입력 snapshot을
   * 쓸 수 있었다. `latestInputsRef`는 매 렌더 후 동기 effect로 갱신되므로 두 경로 모두 "그 순간의
   * 최신 상태"라는 같은 소스를 읽게 만들면, 시점 차이로 다른 waypoints(#918 매역 확장 분기가
   * currentStation null 여부로 갈림)를 만들어 backend register dedup hash가 어긋나고 두 건의
   * POST /trips가 모두 통과해버리는 회귀(2026-08-04 실탑승 evidence — 유령 trip 2개, waypoints
   * 5개 vs 2개)를 구조적으로 차단한다.
   */
  const registerFromLatestInputs = async (
    token: string,
    options?: { promptContextOverride?: BoardingPromptContext | null },
  ): Promise<Awaited<ReturnType<typeof callRegister>> | null> => {
    const {
      route: r,
      destination: d,
      nextStationEtaSeconds: eta,
      currentStation: cs,
      boardingLock: bl,
      subsurface: sub,
      infoModeEnabled: ime,
      sleepMode: sm,
      gpsFix: gf,
    } = latestInputsRef.current;
    if (!r || !d) return null;
    const sessionKey = `${token}:${routeSignature(r)}:${d.id}`;
    const result = await callRegister({
      token,
      route: r,
      destination: d,
      nextStationEtaSeconds: eta,
      currentStation: cs,
      boardingLock: bl,
      subsurface: sub,
      infoModeEnabled: ime,
      sleepMode: sm,
      createdAt: resolveTripCreatedAt(sessionKey),
      cachedPromptContext: lastPromptContextRef.current,
      promptContextOverride: options?.promptContextOverride,
      gpsFix: gf,
    });
    // #767 — 두 경로 모두 동일 기준으로 lock sig를 추적해야 다음 cycle의 release 판정 정확도 유지.
    lastSentLockSigRef.current = lockSig(bl);
    // #2130 (B-1) / #2164 — 이번 register가 실제로 context를 backend에 성공적으로 전달했는지
    // 기록. 다음 currentStation 전환 시 Tier 1 heal이 필요한지 판정하는 SSoT. "성공"은 context
    // build 성공(hadPromptContext) **+** POST 네트워크 성공(ok) 둘 다를 요구 — build만 성공하고
    // 네트워크가 실패하면 backend는 여전히 context가 없으므로 다음 전환에서 재시도가 필요하다.
    lastRegisterMissingContextRef.current = !(result.hadPromptContext && result.ok);
    // #2130 (B-1) — 성공한 context(fresh/override 무관)를 캐시에 반영. Tier 2 heal의 route-origin
    // 근사 context도 이 캐시를 통해 이후 정상 register(currentStation 여전히 null)에 이어져
    // "heal 직후 다음 register가 다시 결손"되는 회귀를 막는다.
    if (result.promptContext) lastPromptContextRef.current = result.promptContext;
    return result;
  };

  /**
   * #2167 (P1, PR #2169 리뷰) — Tier 2 지하 fallback 발동 조건(currentStation 미해소 +
   * subsurface + route 출발역 가용 + 세션 미heal)을 확인하고, 충족하면 override context를
   * 빌드해 반환한다. Tier 2 자신의 setTimeout 콜백(`runTier2Heal`)뿐 아니라
   * register-retry(#1960, `attemptRegisterRetry`)가 성공적으로 register를 완료하는 시점에도
   * 이 조건을 함께 확인해야 한다 — Tier 2 타이머는 오직 main effect `run()`의 register가
   * **직접** 성공했을 때만 arm되므로, 세션의 첫 register가 (실패 후) retry를 통해서만 성공하면
   * Tier 2가 애초에 armed될 기회가 없어 지하 dead-zone 세션이 영구히 context 결손 상태로
   * 고착되는 회귀가 있었다.
   */
  const buildTier2FallbackOverride = (sessionKey: string): BoardingPromptContext | null => {
    const { route: r, destination: d, currentStation: cs, subsurface: sub, boardingLock: bl, routeOriginStation: origin } =
      latestInputsRef.current;
    /* istanbul ignore next -- route/destination이 null로 바뀌는 모든 경로(deps: routeSig,
     * destination?.id)는 main register effect의 cleanup이 트립 종료 시점에 tier2TimerRef를
     * 이미 clearTimeout하므로, Tier 2 콜백 경로에서 이 지점에 trip 종료 상태로 도달할 경로가
     * 없다. register-retry(#1960) 경로(attemptRegisterRetry)는 자체적으로 route/destination
     * null을 이미 상위에서 검증하고 리턴하므로 여기까지 오지 않는다. 향후 리팩터로 그 보장이
     * 깨질 경우를 대비한 방어적 가드. */
    if (!r || !d) return null; // trip 종료됨
    if (cs != null) return null; // 이미 GPS로 해소됨 — Tier 2 대상 아님
    if (!sub) return null; // 지하 판정 아님
    if (origin == null) return null; // fallback 대상 route 출발역 없음
    if (healedSessionKeyRef.current === sessionKey) return null; // 이미 heal 성공(Tier 1 포함)
    return buildBoardingPromptContext({
      route: r,
      currentStation: origin,
      destination: d,
      lock: bl,
      // gpsFix 미전달 — Tier 2 fallback은 스탬프 없이 송신(currentStation 자체가 GPS 미해소 상태).
    });
  };

  /**
   * #2130 (B-1 Tier 2) — 지하 fallback heal. 등록 후 `CONTEXT_HEAL_TIER2_DELAY_MS` 시점에
   * currentStation이 여전히 미해소 + subsurface 판정이면 route 출발역(`routeOriginStation`)
   * 기준으로 promptContext를 빌드해 스탬프 없이 재등록한다.
   *
   * 발동 조건이 모두 충족되지 않으면 조용히 skip(graceful) — trip 종료, GPS 정상 해소, 지상
   * 판정, 사용자가 route 미확정(routeOriginStation 없음) 등은 모두 정상 상태다.
   */
  const runTier2Heal = async (token: string, sessionKey: string): Promise<void> => {
    /* istanbul ignore next -- Tier 1은 currentStation이 non-null로 전환될 때만 in-flight를
     * 세팅하는데, buildTier2FallbackOverride의 `cs != null` 가드가 이미 그 경우를 걸러낸다
     * (이 지점 도달 시 cs는 항상 null). 또한 Tier 1의 effect cleanup은 currentStation.id가
     * 바뀌는 매 렌더마다 동기적으로 in-flight를 지우므로, cs가 null로 유지되는 한 Tier 1의
     * in-flight가 이 시점까지 살아남는 경로가 현재 코드에 없다. 향후 리팩터로 그 보장이 깨질
     * 경우를 대비한 방어적 가드(#2164 폭주 방지 belt-and-suspenders). */
    if (healInFlightSessionKeyRef.current === sessionKey) return;
    /* istanbul ignore next -- #2167: Tier 2 fallback 타이머는 main effect의 직전 register가
     * **성공**(ok:true)했을 때만 arm되고(buildTier2FallbackOverride 주석 참조), main effect가
     * 재실행될 때마다(deps 변경) 그 cleanup이 무조건 tier2TimerRef를 clearTimeout한다.
     * register-retry(#1960)는 오직 main effect 자신의 register가 **실패**할 때만 예약되므로,
     * "이 세션의 Tier 2 타이머가 여전히 armed 상태"와 "이 세션에 재시도가 대기/진행 중"이
     * 동시에 참인 경로가 현재 코드에 없다(재시도를 만든 실행이 반드시 Tier 2 타이머를 먼저
     * 지운다). register-retry(#1960) ↔ context-heal(Tier 1)의 실제 회귀 재현은 위 Tier 1
     * 가드(및 그 반대 방향, attemptRegisterRetry의 healInFlightSessionKeyRef 체크)로 커버된다
     * — 이 체크는 향후 Tier 2 스케줄링이 독립화될 경우를 대비한 belt-and-suspenders. */
    // #2167 — register-retry(#1960)가 이 세션에 대해 대기/진행 중이면 Tier 2도 자체 POST를
    // 쏘지 않는다. 재시도가 발화하면 buildTier2FallbackOverride를 자체적으로 확인해(P1) 같은
    // context를 함께 실어 보낸다.
    if (isRegisterRetryBusy(sessionKey)) return;
    const overrideContext = buildTier2FallbackOverride(sessionKey);
    if (overrideContext == null) return; // 조건 미충족 또는 route 구조상 빌드 실패 — graceful skip
    healedSessionKeyRef.current = sessionKey;
    // #2167 — Tier 1과 동일하게 in-flight를 표시해야 register-retry(#1960)의 반대 방향 가드
    // (attemptRegisterRetry의 healInFlightSessionKeyRef 체크)가 Tier 2의 진행 중 POST도 감지해
    // 겹쳐 쏘지 않는다.
    healInFlightSessionKeyRef.current = sessionKey;
    try {
      await registerFromLatestInputs(token, { promptContextOverride: overrideContext });
    } finally {
      /* istanbul ignore else -- Tier 2는 세션당 1회만 실행되고(healedSessionKeyRef 가드) 이
       * 함수 안에서 sessionKey를 다른 값으로 바꿔치기하는 경로가 없어, 이 finally 시점엔 항상
       * 자신이 세팅한 sessionKey 그대로다. 다른 트립의 Tier 1이 그 사이 다른 sessionKey로 이
       * ref를 덮어쓰는 극단적 교차 시나리오를 대비한 방어적 mismatch 분기. */
      if (healInFlightSessionKeyRef.current === sessionKey) {
        healInFlightSessionKeyRef.current = null;
      }
    }
  };

  /** #1960 — 대기 중인 register 재시도 타이머/상태를 모두 초기화. */
  const clearRegisterRetry = (): void => {
    if (registerRetryRef.current.timer !== null) {
      clearTimeout(registerRetryRef.current.timer);
    }
    registerRetryRef.current = { sessionKey: null, attempt: 0, timer: null };
  };

  /**
   * #1960 — `sessionKey`(activeTrip 세션) 기준으로 다음 backoff 시점에 재시도를 예약한다.
   * 상한(`REGISTER_RETRY_BACKOFF_MS.length`) 도달 시 조용히 중단 — 다음 정상 effect cycle
   * (route/destination/lock 변경)이 처리한다.
   */
  const scheduleRegisterRetry = (sessionKey: string): void => {
    if (registerRetryRef.current.sessionKey !== sessionKey) {
      // 다른 세션(트립 전환)으로 갈아탈 때 옛 세션의 대기 타이머가 살아남아 나중에 무의미하게
      // 발화하지 않도록 명시적으로 clear — tier2TimerRef와 동일한 위생.
      if (registerRetryRef.current.timer !== null) {
        clearTimeout(registerRetryRef.current.timer);
      }
      registerRetryRef.current = { sessionKey, attempt: 0, timer: null };
    }
    const { attempt } = registerRetryRef.current;
    if (attempt >= REGISTER_RETRY_BACKOFF_MS.length) {
      logger.info(`register retry: 상한(${REGISTER_RETRY_BACKOFF_MS.length}) 도달 — 중단`, sessionKey);
      return;
    }
    if (registerRetryRef.current.timer !== null) {
      clearTimeout(registerRetryRef.current.timer);
    }
    const delay = REGISTER_RETRY_BACKOFF_MS[attempt];
    registerRetryRef.current.attempt = attempt + 1;
    registerRetryRef.current.timer = setTimeout(() => {
      registerRetryRef.current.timer = null;
      void attemptRegisterRetry(sessionKey);
    }, delay);
  };

  /**
   * #2167 (P2-1, PR #2169 리뷰) — register-retry가 같은 세션의 context-heal(Tier 1/2) POST와
   * in-flight로 겹쳐 이번 backoff를 건너뛸 때 전용 recheck 예약. `scheduleRegisterRetry`(실제
   * register 실패 전용, attempt 예산 소모)와 분리해 attempt를 소모하지 않는다 — heal-busy는
   * register가 실패한 게 아니라 "잠깐 다른 루프가 같은 목적으로 이미 POST 중"이라는 신호일
   * 뿐이라 backoff 예산을 태우면 안 된다(P2-1). heal이 비정상적으로 오래 걸리는 상황에 대비해
   * 재예약 횟수 자체엔 별도 상한(`REGISTER_RETRY_HEAL_BUSY_MAX_RESCHEDULES`)을 둔다 — 상한
   * 도달 시엔 일반 backoff(`scheduleRegisterRetry`, attempt 소모)로 전환해 무한 대기를 막는다.
   */
  const rescheduleRegisterRetryForHealBusy = (sessionKey: string): void => {
    if (registerRetryHealBusyRef.current.sessionKey !== sessionKey) {
      registerRetryHealBusyRef.current = { sessionKey, count: 0 };
    }
    if (registerRetryHealBusyRef.current.count >= REGISTER_RETRY_HEAL_BUSY_MAX_RESCHEDULES) {
      logger.info(
        `register retry: heal-busy 재예약 상한(${REGISTER_RETRY_HEAL_BUSY_MAX_RESCHEDULES}) 도달 — 일반 backoff로 전환`,
        sessionKey,
      );
      scheduleRegisterRetry(sessionKey);
      return;
    }
    registerRetryHealBusyRef.current.count += 1;
    /* istanbul ignore next -- 이 함수는 attemptRegisterRetry 내부에서만 호출되고,
     * attemptRegisterRetry는 오직 scheduleRegisterRetry 또는 이 함수 자신의 setTimeout
     * 콜백을 통해서만 실행된다 — 두 콜백 모두 `attemptRegisterRetry` 호출 직전에 동기적으로
     * `registerRetryRef.current.timer = null`을 세팅하므로, 이 지점에 도달했을 때 timer가
     * non-null인 경로가 현재 코드에 없다. scheduleRegisterRetry의 동일 성격 가드와 같은
     * 방어적 처리(향후 호출 경로가 늘어날 경우를 대비). */
    if (registerRetryRef.current.timer !== null) {
      clearTimeout(registerRetryRef.current.timer);
    }
    // sessionKey/attempt는 건드리지 않는다 — 이 재예약은 attempt 예산과 무관한 recheck다.
    registerRetryRef.current.sessionKey = sessionKey;
    registerRetryRef.current.timer = setTimeout(() => {
      registerRetryRef.current.timer = null;
      void attemptRegisterRetry(sessionKey);
    }, REGISTER_RETRY_HEAL_BUSY_RECHECK_MS);
  };

  /**
   * #1960 — 예약된 재시도 실행. 활성 trip이 여전히 같은 세션인지 재검증(trip 전환/종료 시
   * self-cancel) 후 token을 다시 조회해 register를 재시도한다. 성공(`ok:true`, dedup skip
   * 포함)하면 재시도 상태를 초기화, 실패하면 다음 backoff를 예약한다.
   */
  const attemptRegisterRetry = async (sessionKey: string): Promise<void> => {
    const { route: r, destination: d } = latestInputsRef.current;
    /* istanbul ignore next -- trip 종료 경로("트립 없음" 분기, mount-once cleanup)와 trip 전환
     * 경로(scheduleRegisterRetry의 세션 교체 분기) 모두 이 타이머 콜백이 실행되기 전에
     * 대기 타이머를 동기적으로 clear하므로, 이 콜백 자체가 route/destination null 또는 세션
     * 불일치 상태로 진입할 도달 경로가 현재 코드에 없다. Tier 2 heal의 동일 성격 가드
     * (위 runTier2Heal)와 같은 방어적 처리. */
    if (!r || !d || `${routeSignature(r)}:${d.id}` !== sessionKey) return; // trip 종료/전환됨 — 재시도 대상 아님

    // #2167 — 같은 세션에 대해 context-heal(Tier 1/2) POST가 이미 in-flight면 이번 backoff는
    // 건너뛰고 recheck를 예약한다(P2-1 — attempt 예산은 소모하지 않는다). heal의 결과(성공 시
    // context 확보 + lastRegisterMissingContextRef 갱신)를 본 뒤 재시도하면 heal과 동일
    // payload를 겹쳐 쏘지 않는다.
    if (healInFlightSessionKeyRef.current === sessionKey) {
      rescheduleRegisterRetryForHealBusy(sessionKey);
      return;
    }
    // heal-busy 대기가 끝나고 정상 진행하는 경로 — 이 세션의 recheck 카운터를 리셋해, 나중에
    // 별개의 heal-busy 에피소드가 다시 생겨도 이전 에피소드의 재예약 횟수와 합산되지 않게 한다.
    if (registerRetryHealBusyRef.current.sessionKey === sessionKey) {
      registerRetryHealBusyRef.current = { sessionKey: null, count: 0 };
    }

    const token = await AsyncStorage.getItem(APNS_TOKEN_KEY);
    if (!token) {
      // 토큰 여전히 미가용 — 다음 backoff 예약.
      scheduleRegisterRetry(sessionKey);
      return;
    }
    registerRetryInFlightSessionKeyRef.current = sessionKey;
    try {
      // #2167 (P1) — Tier 2 지하 fallback 조건이 충족되면 override를 함께 실어 보낸다. 세션의
      // 첫 register가 (Tier 2를 arm하는) main effect run()이 아니라 이 retry로만 성공하면
      // Tier 2 자체가 armed될 기회가 없어 지하 dead-zone 세션이 영구히 context 결손 상태로
      // 고착되는 회귀를 막는다 — buildTier2FallbackOverride가 조건 미충족/이미 heal 시 null을
      // 반환하므로 해당 없는 세션에는 영향 없다.
      const tier2Override = buildTier2FallbackOverride(sessionKey);
      const result = await registerFromLatestInputs(
        token,
        tier2Override != null ? { promptContextOverride: tier2Override } : undefined,
      );
      // #2167 (P1, 재검증 리뷰) — 세션 잠금은 override가 **실제로 backend에 전달됐을 때만**
      // 건다(Tier 1/Tier 2와 동일한 성공 기준). attempt(시도) 기준으로 await 이전에 잠그면,
      // backend 장애로 register-retry 예산(3회)이 전부 network 실패로 소진될 때 세션이
      // 잠긴 채 context는 한 번도 전달되지 못하고 retry도 끝나버려 — 이후 지상 재진입으로
      // currentStation이 다시 잡혀도 Tier 1이 이 잠금에 막혀 영구 결손이 재발한다(#2166이
      // Tier 1에서 이미 고친 것과 동일 클래스의 회귀). 실패 시에는 잠그지 않아 다음 재시도/
      // Tier 1 전환에서 다시 시도할 수 있게 둔다.
      if (tier2Override != null && result?.ok && result.hadPromptContext) {
        healedSessionKeyRef.current = sessionKey;
      }
      if (result?.ok) {
        clearRegisterRetry();
        await AsyncStorage.setItem(ACTIVE_TRIP_KEY, token);
      } else {
        scheduleRegisterRetry(sessionKey);
      }
    } finally {
      if (registerRetryInFlightSessionKeyRef.current === sessionKey) {
        registerRetryInFlightSessionKeyRef.current = null;
      }
    }
  };

  // ── 토큰 발급 + 리스너 등록 (mount-once) ──
  useEffect(() => {
    let cancelled = false;
    let subscription: { remove: () => void } | null = null;

    // #1931 — cold start race window 차단. token 발급보다 먼저 AsyncStorage stamp read를
    // priming해 첫 register 시점에는 cache가 이미 해소된 상태가 되도록 한다. fire-and-forget —
    // 실패해도 `getRegisteringApnsEnv()`가 build env로 graceful fallback.
    void warmupConfirmedApnsEnv();

    (async () => {
      try {
        const tokenResp = await Notifications.getDevicePushTokenAsync();
        if (cancelled) return;
        const token = tokenResp.data;
        if (!token || typeof token !== 'string') {
          logger.info('device push token unavailable — skip');
          return;
        }
        await AsyncStorage.setItem(APNS_TOKEN_KEY, token);
        logger.info('apns token cached');
      } catch (e) {
        logger.warn('getDevicePushTokenAsync failed:', e);
      }
    })();

    subscription = Notifications.addPushTokenListener((event) => {
      const token = event?.data;
      if (!token || typeof token !== 'string') return;
      void (async () => {
        try {
          await AsyncStorage.setItem(APNS_TOKEN_KEY, token);
        } catch (e) {
          logger.warn('persist refreshed token failed:', e);
        }
        // #2129 — 활성 트립이 있으면 latestInputsRef 단일 출처로 재등록 (main effect와 payload
        // 빌드 경로 통일 — registerFromLatestInputs 내부에서 lock sig 추적까지 함께 처리).
        await registerFromLatestInputs(token);
      })();
    });

    return () => {
      cancelled = true;
      subscription?.remove();
      // #1960 — 컴포넌트 unmount 시 대기 중인 register 재시도 타이머 정리(메모리 누수/좀비 POST 방지).
      clearRegisterRetry();
    };
  }, []);

  // ── 활성 트립 register / clear ──
  useEffect(() => {
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // 실제 register/clear 작업 — debounce 분기와 즉시 분기에서 공유.
    const run = async () => {
      const token = await AsyncStorage.getItem(APNS_TOKEN_KEY);
      if (cancelled) return;

      // 트립 없음 → 이전에 등록된 토큰이 있다면 clear.
      if (!route || !destination) {
        const prevTokenRaw = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
        if (cancelled) return;
        if (prevTokenRaw) {
          await clearActiveTrip(prevTokenRaw);
          await AsyncStorage.removeItem(ACTIVE_TRIP_KEY);
        }
        // 트립 없음 분기에서도 lock 시그를 reset — 다음 trip이 새로 등록될 때 첫 cycle은
        // 즉시 발사(debounce 미적용) 보장.
        lastSentLockSigRef.current = null;
        // #1264 (N3) + #1704 (d): trip 종료 시 routeSig / destination.id / boardingLockSig 추적
        // 모두 reset — 다음 trip 시작 시 첫 register는 신규로 취급되어 cancel skip(불필요한 OS 호출 방지).
        lastRouteSigRef.current = null;
        lastDestinationIdRef.current = null;
        lastBoardingLockSigRef.current = null;
        // #1284: trip 종료 시 prompt context 캐시 reset — 다음 trip이 이전 trip의
        // 출발역 컨텍스트를 stamp하는 오염 방지.
        lastPromptContextRef.current = null;
        // #2130 (B-1): trip 종료 시 context-heal tracking 전부 reset — 다음 trip이 새로
        // heal 1회 기회를 갖도록. (Tier 2 타이머는 이 effect의 cleanup이 이미 이전 execution
        // 시점에 cancel했다 — 여기서 다시 clear할 필요 없음.)
        lastRegisterMissingContextRef.current = false;
        healedSessionKeyRef.current = null;
        // #2164 — trip 종료 시 heal in-flight/attempt 상한 추적도 초기화 — 다음 trip이 새로
        // 세션당 상한(CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION) 전체를 갖는다.
        healInFlightSessionKeyRef.current = null;
        healAttemptRef.current = { sessionKey: null, count: 0 };
        prevCurrentStationIdRef.current = null;
        // #1960: trip 종료 시 register 재시도 상태도 초기화 — 다음 trip이 새로 재시도 3회 기회를 갖는다.
        clearRegisterRetry();
        // #2167 (P2-2, PR #2169 리뷰) — healInFlightSessionKeyRef와 대칭으로 register-retry의
        // in-flight/heal-busy 추적도 초기화. 초기화하지 않으면 이 trip의 retry가 여전히
        // in-flight인 채로 trip이 종료되고, 곧바로 동일 sessionKey(같은 route+destination)로
        // 새 trip이 시작될 때 stale in-flight 플래그가 `isRegisterRetryBusy`를 통해 새 trip의
        // context-heal(Tier 1/2)을 영구히 차단하는 회귀가 있었다.
        registerRetryInFlightSessionKeyRef.current = null;
        registerRetryHealBusyRef.current = { sessionKey: null, count: 0 };
        return;
      }

      // #1264 (N3) + #1704 (d) → #2089 — routeSig / destination.id / boardingLockSig 어느
      // 하나라도 전환되면 이전 trip의 안전망(safetyNetScheduler) 알람 cancel. backend 정정
      // silent push가 stale identifier에 매칭 실패하는 회귀 차단 + 같은 routeSig에서
      // destination/lock만 바뀐 cross-trip 잔재(2026-06-23 trip evidence) 차단.
      // 첫 register(이전 값 모두 null)에는 호출 X — 신규 trip은 cancel할 대상 없음.
      // cancel 실패해도 후속 register는 진행 (graceful) — runTripBoundCleanups + useSafetyNetScheduler
      // 가 별경로로 동일 cleanup을 시도하므로 본 호출은 belt-and-suspenders.
      const hasPrevTrip =
        lastRouteSigRef.current !== null ||
        lastDestinationIdRef.current !== null ||
        lastBoardingLockSigRef.current !== null;
      const tripSwitched =
        hasPrevTrip &&
        (lastRouteSigRef.current !== routeSig ||
          lastDestinationIdRef.current !== destination.id ||
          lastBoardingLockSigRef.current !== boardingLockSig);
      if (tripSwitched) {
        try {
          const prevActiveTripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
          if (prevActiveTripToken) {
            await cancelAllSafetyNetAlarms(prevActiveTripToken);
          }
        } catch (e) {
          logger.warn('cancelAllSafetyNetAlarms (trip switch) 실패:', e);
        }
        if (cancelled) return;
      }

      // 트립 있음 → 토큰 없으면 graceful skip.
      if (!token) {
        logger.info('apns token not yet available — skip register');
        // #1960 — deps(routeSig/destination.id/boardingLockSig 등) 불변이면 다음 재기회가
        // 없으므로, 활성 trip 한정으로 token 재발급을 기다리며 재시도 예약.
        scheduleRegisterRetry(`${routeSig}:${destination.id}`);
        return;
      }

      // #1284 — buildBoardingPromptContext가 성공하면 캐시 갱신. 이후 currentStation이
      // 일시 null이 돼도 cachedPromptContext로 fallback하여 backend 9단 게이트가 계속 진입 가능.
      // #1921 — lock 동봉. cross-trip 자동 전환 시 stale stamp 차단(callRegister 분기와 동일 입력).
      const freshCtx = buildBoardingPromptContext({
        route,
        currentStation,
        destination,
        lock: boardingLock,
        gpsFix: latestInputsRef.current.gpsFix,
      });
      if (freshCtx) lastPromptContextRef.current = freshCtx;
      // R11-a (#1612): trip register 직전 backend SSoT mirror 강제 clean.
      // 스펙 docs/requirements/15-trip-alarm-notification.md:89 명시 요구사항 — "trip 등록(new)
      // → 이전 SSoT mirror 강제 clear". 본 호출이 register API보다 먼저여야 race A
      // (cleanup 후 OLD trip 지연 push로 mirror 부활) 차단의 1단계로 작동한다.
      // 호출은 멱등 (clearBackendSsotMirror 키 부재 시 graceful no-op).
      await clearBackendSsotMirror();
      // #1628 — R11-a 차단 1건 측정. burst dedup으로 같은 site 반복은 첫 1건만 적재.
      logCrossTripMirrorSkip('register');
      // #2129 — token-refresh listener와 동일한 latestInputsRef 단일 출처로 register. 이 시점의
      // ref는 이미 이번 render의 최신 값으로 동기화돼 있어(ref-sync effect가 이 effect보다 먼저
      // 실행) closure의 route/currentStation을 직접 쓰는 것과 결과가 같지만, 두 register 경로가
      // 구조적으로 같은 소스를 읽게 만들어 payload divergence를 원천 차단한다.
      const result = await registerFromLatestInputs(token);
      // #1264 (N3) + #1704 (d) — POST 발사 직후 송신된 routeSig / destination.id / boardingLockSig
      // 를 기록. 다음 cycle이 trip 전환(어느 하나라도 변경) 시 cancel 트리거.
      lastRouteSigRef.current = routeSig;
      lastDestinationIdRef.current = destination.id;
      lastBoardingLockSigRef.current = boardingLockSig;
      // #669: cancelled 가드 밖에서 setItem — backend register 성공이면 UI cleanup 여부와 무관하게
      // ACTIVE_TRIP_KEY를 동기화. 가드 안에 두면 nextStationEtaSeconds·currentStation 변경으로
      // useEffect cleanup이 자주 일어나 setItem이 skip되고 DebugModal activeTrip이 (none)으로 표시됨.
      if (result?.ok) {
        await AsyncStorage.setItem(ACTIVE_TRIP_KEY, token);
        // #1960 — 성공(dedup skip 포함, ok:true)했으면 이 세션에 대한 대기 재시도가 있다면 정리.
        clearRegisterRetry();
      } else {
        // #1960 — register 실패({ok:false}) — deps 불변이면 재기회가 없으므로 활성 trip 한정 재시도.
        scheduleRegisterRetry(`${routeSig}:${destination.id}`);
      }
      // #2130 (B-1 Tier 2) — 이번 register가 성공했으면 60초 타이머를 arm. 이 effect의
      // cleanup이 매 re-execution 전에 이전 타이머를 이미 cancel하므로(아래), 여기 도달한
      // 시점엔 tier2TimerRef가 항상 비어 있다 — "가장 최근 성공 register로부터 60초"가 기준.
      if (result?.ok) {
        // #2130 (B-1) — Tier 1과 동일한 `${routeSig}:${destination.id}` 포맷을 써야
        // `healedSessionKeyRef` 가드가 두 tier에 걸쳐 세션당 1회를 정확히 보장한다(토큰은
        // refresh로 바뀔 수 있어 세션 정체성에 포함하지 않는다).
        const healSessionKey = `${routeSig}:${destination.id}`;
        tier2TimerRef.current = setTimeout(() => {
          tier2TimerRef.current = null;
          void runTier2Heal(token, healSessionKey);
        }, CONTEXT_HEAL_TIER2_DELAY_MS);
      }
    };

    // #767 — lock 해제(non-null → null) 전환만 debounce. 다음 cycle이 새 lock을 들고 오면
    // cleanup이 timer를 clearTimeout으로 cancel해 발사 자체를 차단. 다른 전환(route/destination
    // 변경, lock 신규 부여, lock 내용 갱신, 트립 종료)은 즉시 발사 — 기존 동작 보존.
    // 안전: 만약 cleanup의 clearTimeout이 race로 늦어 timer가 발사돼도 run() 내부 cancelled
    // 가드가 AsyncStorage.getItem 직후 추가 작업을 차단한다 (이중 방어).
    const isLockReleaseTransition =
      lastSentLockSigRef.current !== null && boardingLockSig === null && route !== null && destination !== null;
    if (isLockReleaseTransition) {
      debounceTimer = setTimeout(() => {
        void run();
      }, BOARDING_LOCK_RELEASE_DEBOUNCE_MS);
    } else {
      void run();
    }

    return () => {
      cancelled = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      // #2130 (B-1 Tier 2) — 이 effect cycle이 재실행(route/destination/lock 등 전환)되거나
      // unmount되면 stale 세션 기준으로 예약된 타이머를 취소. 새 cycle의 run()이 필요 시 재arm.
      if (tier2TimerRef.current !== null) {
        clearTimeout(tier2TimerRef.current);
        tier2TimerRef.current = null;
      }
    };
    // route는 routeSig(내용 기반)로 비교 — 동일 경로 재등록으로 백엔드 trip
    // state(waypoints shift)가 reset되거나 워커 POST /trips가 분당 폭주하는 것을 방지.
    // route 자체는 closure 안에서만 사용되므로 deps에 넣지 않는다.
    // boardingLock은 boardingLockSig(내용 기반)로 deps — 상위 컴포넌트가 새 object reference를
    // 내려도 같은 lock 내용이면 재등록 안 함. closure 안 actual boardingLock object 사용.
    // #703: nextStationEtaSeconds / currentStation은 30s GPS·arrival polling으로 매번 바뀌므로
    // deps에서 제외한다. 첫 register 후 backend cron(#704/#705)이 자체 progress KV로
    // station-by-station advance를 영속화하므로 client 재등록이 불필요하다. latestInputsRef로
    // token-refresh 경로는 여전히 최신값을 사용한다.
    // #903 (Seam G): subsurface 변화 시 backend threshold(5→10)를 빨리 갱신해 지하 진입 직후
    // 일시 GPS/arrival 누락에 인내. useBarometer의 60s 윈도우 평가가 토글 폭주를 자체 흡수하므로
    // deps churn 위험 낮음. alarmBackend의 dedup hash가 subsurface 미변화 사이클은 POST를 skip.
    // #1923: infoModeEnabled 변화 시 backend lockless intermediate gate를 즉시 활성화해 다음 cron
    // cycle부터 station-passed silent push 발사가 가능. 토글 빈도는 사용자 명시 의향 표명/trip 종료
    // 시점만이므로 deps churn 위험 낮음. alarmBackend dedup hash가 미변화 사이클은 POST를 skip.
    // #2032 (Issue D): sleepMode 변화 시 backend 저장값이 즉시 갱신되어 이후 log/skip 원인 분류가
    // 정확해진다. **backend 발사 결정은 미영향 (ADR-023)** — device의 `shouldSuppressBySleepRule`만
    // suppress 판정. 토글 빈도는 사용자 명시 설정 시점만이므로 deps churn 위험 낮음.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSig, destination?.id, boardingLockSig, subsurface, infoModeEnabled, sleepMode]);

  // ── #2130 (B-1 Tier 1) — context-heal on currentStation 전환 (#2150: 결과 상태 기준) ──
  //
  // 위 main register effect는 #703 의도(POST 폭주 방지)로 currentStation을 deps에서 제외한다.
  // 그 결과 cold-start register가 currentStation=null(또는 route 밖 역)로 나가면(promptContext
  // 결손) 이후 GPS/fusion이 station을 해소해도 재등록 트리거가 없어 결손이 trip 내내 지속된다
  // (#2130 근본 원인). 이 effect는 currentStation만을 deps로 갖는 별도 effect로 그 트리거를
  // 신설한다 — main effect의 raw-deps 정책 자체는 건드리지 않는다.
  //
  // #2150 — 최초 조건은 "null→non-null 전환"만 대상이었으나, 최초 등록 시 currentStation이
  // route 밖 역(집 근처역 등, non-null이지만 context 빌드 실패)이면 이후 실제 탑승역(route 위,
  // non-null)으로 전환돼도 non-null→non-null이라 heal이 영구히 미발동했다. 트리거를 "전환 종류"가
  // 아니라 **결과 상태**(직전 register에 context 없었음 + currentStation이 바뀌어 non-null) 기준으로
  // 재정의한다.
  //
  // 조건: 활성 trip + currentStation.id가 실제로 바뀜 + 새 값이 non-null + 직전 register가
  // context를 backend에 성공적으로 전달하지 못함(build 실패 또는 POST 네트워크 실패) + 세션
  // 미성공 + 세션당 POST 상한 미도달.
  //
  // #2164 — register 발사는 **context build가 성공할 때만**. build 실패(off-route 역 등)면
  // POST 자체를 내지 않고 세션도 잠그지 않아 다음 전환에서 재시도를 허용한다(성공 기준 가드).
  // 다만 build 성공 후 POST가 반복 실패하는 상황을 대비해 세션당 POST 발사 횟수에 상한을 둔다.
  useEffect(() => {
    const prevStationId = prevCurrentStationIdRef.current;
    prevCurrentStationIdRef.current = currentStation?.id ?? null;

    if (!route || !destination) return; // trip 없음 — heal 대상 아님(trip-end 분기가 별도 reset).
    if (currentStation == null) return; // 결과가 non-null인 전환만 대상.
    if (prevStationId === currentStation.id) return; // 실질적 전환 없음(mount 시 lazy init 포함).
    if (!lastRegisterMissingContextRef.current) return; // 직전 register가 이미 context 전달 성공.

    const sessionKey = `${routeSig}:${destination.id}`;
    if (healedSessionKeyRef.current === sessionKey) return; // 세션 이미 heal 성공.
    /* istanbul ignore next -- currentStation.id가 바뀌어야만 이 effect가 재실행되는데, React는
     * deps 변경 시 이전 effect의 cleanup(이 함수 하단, in-flight를 항상 지움)을 새 effect
     * body보다 먼저 동기 실행한다. 따라서 이 effect 스스로 인해 in-flight가 살아있는 채로 다시
     * 진입하는 경로가 현재 코드에 없다(Tier 2의 in-flight 체크와 동일 성격의 방어적 가드). */
    if (healInFlightSessionKeyRef.current === sessionKey) return; // 동일 세션 heal 진행 중.
    // #2167 — register-retry(#1960)가 이 세션에 대해 대기(backoff armed) 또는 진행 중이면
    // heal은 자체 POST를 쏘지 않고 skip한다. 재시도가 발화하면 이 시점의 최신 currentStation
    // (지금 heal이 해소하려는 값)을 latestInputsRef를 통해 그대로 실어 보내 재시도 1건이 재시도
    // 목적과 heal 목적을 함께 달성한다 — 두 루프가 겹쳐 거의 동일 payload를 두 번 POST하는
    // 회귀(#2167 배경) 차단.
    if (isRegisterRetryBusy(sessionKey)) return;

    // #2164 — build 성공 여부를 먼저 확인 — 실패하면 POST 자체를 내지 않는다(세션 미잠금,
    // 상한도 소비하지 않음 — 다음 전환에서 다시 시도).
    const healContext = buildBoardingPromptContext({
      route,
      currentStation,
      destination,
      lock: boardingLock,
      gpsFix: latestInputsRef.current.gpsFix,
    });
    if (healContext == null) return; // build 실패 — graceful skip.

    // #2164 — 세션당 POST 상한 백스톱(backend rate limit 보호).
    if (healAttemptRef.current.sessionKey !== sessionKey) {
      healAttemptRef.current = { sessionKey, count: 0 };
    }
    if (healAttemptRef.current.count >= CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION) {
      logger.info(
        `context-heal: 세션당 POST 상한(${CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION}) 도달 — 중단`,
        sessionKey,
      );
      return;
    }

    let cancelled = false;
    healInFlightSessionKeyRef.current = sessionKey;
    void (async () => {
      const token = await AsyncStorage.getItem(APNS_TOKEN_KEY);
      if (cancelled) return;
      if (!token) {
        healInFlightSessionKeyRef.current = null;
        return;
      }
      healAttemptRef.current.count += 1;
      const result = await registerFromLatestInputs(token, { promptContextOverride: healContext });
      if (cancelled) return;
      healInFlightSessionKeyRef.current = null;
      // #2164 — heal이 실제로 성공(context build + POST 네트워크 모두 성공)했을 때만 세션 잠금.
      // 실패하면 잠그지 않아 다음 전환에서 재시도(상한까지) 허용.
      if (result?.ok && result.hadPromptContext) {
        healedSessionKeyRef.current = sessionKey;
      }
    })();
    return () => {
      cancelled = true;
      // #2164 — in-flight 도중 같은 세션의 다음 station 전환이 도착해 이 effect가 재실행/
      // unmount되면, 아직 완료되지 않은 이번 시도의 in-flight 표시를 지워 다음 시도가 영구히
      // 막히지 않게 한다(다른 세션으로 이미 갈아탄 값이면 조건 불일치로 건드리지 않음).
      if (healInFlightSessionKeyRef.current === sessionKey) {
        healInFlightSessionKeyRef.current = null;
      }
    };
    // currentStation.id 전환만이 이 effect의 트리거 — route/destination 등은 closure로 최신값
    // 참조(gate 조건 평가용)하되 deps에는 넣지 않는다: 위 main effect가 이미 그 변경들을
    // 처리하므로 이 effect까지 반응하면 heal 판정이 중복 실행된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStation?.id]);
}
