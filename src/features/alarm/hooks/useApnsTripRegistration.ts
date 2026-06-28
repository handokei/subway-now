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
import { cancelTripBoundAlarms } from '../utils/tripBoundScheduler';
import { clearBackendSsotMirror } from '../utils/backendSsotMirror';
import { logCrossTripMirrorSkip } from '../utils/alarmLog';
import { buildBoardingPromptContext, type BoardingPromptContext } from '../utils/boardingPromptContext';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { BOARDING_LOCK_RELEASE_DEBOUNCE_MS } from '../../../shared/constants/boardingLock';
import { createLogger } from '../../../shared/utils/logger';
import { getRegisteringApnsEnv, warmupConfirmedApnsEnv } from '../../../shared/utils/apnsEnv';
import type { BoardingLock } from '../../../shared/types/boardingLock';

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
   * #1923 — 사용자 명시 의향 토글 (C 토글 ON / boardingPrompt [탑승] 응답 /
   * BoardingTrainList 직접 탭 중 하나라도 행하면 true). `useUserIntentStore`에서
   * 읽어 전달. backend가 lockless intermediate station-passed silent push 발사
   * 분기에 사용 (`trip.infoModeEnabled && waypoint.kind === 'intermediate'`).
   * 미지정/false: 기존 동작 그대로 — boardingLock 부재 시 `lockMissing` skip.
   */
  infoModeEnabled?: boolean;
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
  /** 같은 trip 세션 동안 고정되는 epoch ms. backend `isSameSession` 판정 키(#589). */
  createdAt: number;
  /**
   * #1284 — 직전 사이클에서 성공적으로 빌드된 boarding-prompt 컨텍스트 캐시.
   * currentStation이 BG GPS 누락으로 일시 null이 됐을 때 fallback으로 사용해
   * backend cron 진입 시점에 컨텍스트가 반드시 존재하도록 보장한다.
   */
  cachedPromptContext: BoardingPromptContext | null;
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
async function callRegister(input: RegisterCallInputs) {
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
  const freshContext = buildBoardingPromptContext({
    route: input.route,
    currentStation: input.currentStation,
    destination: input.destination,
    lock: input.boardingLock,
  });
  const promptContext = freshContext ?? input.cachedPromptContext;

  // #1895 — i18next.language를 backend가 인식하는 SupportedLocale로 정규화.
  // backend는 미송신 시 ko fallback이므로 비지원 locale은 송신 자체 skip.
  const locale = resolveLocaleForBackend();

  // #1897 (RC-5) — 마지막으로 backend가 confirm한 apnsEnv stamp 우선 사용. 부재 시 build env
  // (`resolveApnsEnv()`)로 자연 fallback. self-heal 발동 횟수를 0에 수렴시키는 핵심 wire.
  const apnsEnv = await getRegisteringApnsEnv();

  return registerActiveTrip({
    token: input.token,
    route: input.route,
    destination: input.destination.id,
    waypoints: routeToWaypoints(input.route, input.destination.name, input.currentStation),
    alarmAtEpochMs: deriveAlarmAtEpochMs(input.nextStationEtaSeconds, Date.now()),
    apnsEnv,
    createdAt: input.createdAt,
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
  });
}

export function useApnsTripRegistration({
  route,
  destination,
  nextStationEtaSeconds,
  currentStation = null,
  boardingLock = null,
  subsurface = false,
  infoModeEnabled = false,
}: UseApnsTripRegistrationInputs): void {
  // route 객체 reference가 categorized recompute로 자주 바뀌므로 내용 기반 signature로
  // 메모화 — register useEffect deps에 사용해 동일 경로 재등록(POST /trips 폭주) 방지.
  const routeSig = useMemo(() => routeSignature(route), [route]);
  // boardingLock도 reference가 아닌 내용 기반 key로 deps — 상위가 매 렌더 새 객체를 내려도 안전.
  // alarmBackend dedup hash와 동일 필드 사용 (trainCode + line + boardedAt).
  const boardingLockSig = lockSig(boardingLock);
  // 최신 트립 입력을 ref에 보관 — pushTokenListener가 갱신 시 재등록에 사용한다.
  const latestInputsRef = useRef({ route, destination, nextStationEtaSeconds, currentStation, boardingLock, subsurface, infoModeEnabled });
  useEffect(() => {
    latestInputsRef.current = { route, destination, nextStationEtaSeconds, currentStation, boardingLock, subsurface, infoModeEnabled };
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
        // 활성 트립이 있으면 새 토큰으로 재등록한다.
        const {
          route: r,
          destination: d,
          nextStationEtaSeconds: eta,
          currentStation: cs,
          boardingLock: bl,
          subsurface: sub,
          infoModeEnabled: ime,
        } = latestInputsRef.current;
        if (!r || !d) return;
        const sessionKey = `${token}:${routeSignature(r)}:${d.id}`;
        await callRegister({
          token,
          route: r,
          destination: d,
          nextStationEtaSeconds: eta,
          currentStation: cs,
          boardingLock: bl,
          subsurface: sub,
          infoModeEnabled: ime,
          createdAt: resolveTripCreatedAt(sessionKey),
          cachedPromptContext: lastPromptContextRef.current,
        });
        // #767 — main effect와 동일 기준으로 lock sig를 추적해야 다음 cycle의 release 판정 정확도
        // 유지. token-refresh는 deps cycle을 거치지 않는 별경로지만 backend엔 동일 POST를 보내므로.
        lastSentLockSigRef.current = lockSig(bl);
      })();
    });

    return () => {
      cancelled = true;
      subscription?.remove();
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
        return;
      }

      // #1264 (N3) + #1704 (d) — routeSig / destination.id / boardingLockSig 어느 하나라도
      // 전환되면 사전 예약된 `tba:` 알람 cancel. backend 정정 silent push가 stale identifier에
      // 매칭 실패하는 회귀 차단 + 같은 routeSig에서 destination/lock만 바뀐 cross-trip 잔재
      // (2026-06-23 trip evidence: 14:18 2차 trip 등록 직후 1차 trip 공덕/군자 stale fire) 차단.
      // 첫 register(이전 값 모두 null)에는 호출 X — 신규 trip은 cancel할 대상 없음.
      // cancel 실패해도 후속 register는 진행 (graceful) — runTripBoundCleanups + useTripBoundAlarmScheduler
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
          await cancelTripBoundAlarms();
        } catch (e) {
          logger.warn('cancelTripBoundAlarms (trip switch) 실패:', e);
        }
        if (cancelled) return;
      }

      // 트립 있음 → 토큰 없으면 graceful skip.
      if (!token) {
        logger.info('apns token not yet available — skip register');
        return;
      }

      const sessionKey = `${token}:${routeSig}:${destination.id}`;
      // #1284 — buildBoardingPromptContext가 성공하면 캐시 갱신. 이후 currentStation이
      // 일시 null이 돼도 cachedPromptContext로 fallback하여 backend 9단 게이트가 계속 진입 가능.
      // #1921 — lock 동봉. cross-trip 자동 전환 시 stale stamp 차단(callRegister 분기와 동일 입력).
      const freshCtx = buildBoardingPromptContext({ route, currentStation, destination, lock: boardingLock });
      if (freshCtx) lastPromptContextRef.current = freshCtx;
      // R11-a (#1612): trip register 직전 backend SSoT mirror 강제 clean.
      // 스펙 docs/requirements/15-trip-alarm-notification.md:89 명시 요구사항 — "trip 등록(new)
      // → 이전 SSoT mirror 강제 clear". 본 호출이 register API보다 먼저여야 race A
      // (cleanup 후 OLD trip 지연 push로 mirror 부활) 차단의 1단계로 작동한다.
      // 호출은 멱등 (clearBackendSsotMirror 키 부재 시 graceful no-op).
      await clearBackendSsotMirror();
      // #1628 — R11-a 차단 1건 측정. burst dedup으로 같은 site 반복은 첫 1건만 적재.
      logCrossTripMirrorSkip('register');
      const result = await callRegister({
        token,
        route,
        destination,
        nextStationEtaSeconds,
        currentStation,
        boardingLock,
        subsurface,
        infoModeEnabled,
        createdAt: resolveTripCreatedAt(sessionKey),
        cachedPromptContext: lastPromptContextRef.current,
      });
      // POST 발사 직후(성공/실패 무관) 송신된 lock sig를 기록 — 다음 cycle이 "직전 송신 = lock,
      // 신규 = null" 패턴인지 판정해 race 차단.
      lastSentLockSigRef.current = boardingLockSig;
      // #1264 (N3) + #1704 (d) — POST 발사 직후 송신된 routeSig / destination.id / boardingLockSig
      // 를 기록. 다음 cycle이 trip 전환(어느 하나라도 변경) 시 cancel 트리거.
      lastRouteSigRef.current = routeSig;
      lastDestinationIdRef.current = destination.id;
      lastBoardingLockSigRef.current = boardingLockSig;
      // #669: cancelled 가드 밖에서 setItem — backend register 성공이면 UI cleanup 여부와 무관하게
      // ACTIVE_TRIP_KEY를 동기화. 가드 안에 두면 nextStationEtaSeconds·currentStation 변경으로
      // useEffect cleanup이 자주 일어나 setItem이 skip되고 DebugModal activeTrip이 (none)으로 표시됨.
      if (result.ok) {
        await AsyncStorage.setItem(ACTIVE_TRIP_KEY, token);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSig, destination?.id, boardingLockSig, subsurface, infoModeEnabled]);
}
