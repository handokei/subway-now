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
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { routeSignature, getStationById } from '../../../shared/utils/stationRoute';
import { registerActiveTrip, clearActiveTrip, type AlarmBoardingLock } from '../api/alarmBackend';
import { routeToWaypoints } from '../../route/utils/routeWaypoints';
import { buildBoardingLockMeta } from '../utils/buildBoardingLockMeta';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { BOARDING_LOCK_RELEASE_DEBOUNCE_MS } from '../../../shared/constants/boardingLock';
import { createLogger } from '../../../shared/utils/logger';
import { resolveApnsEnv } from '../../../shared/utils/apnsEnv';
import type { BoardingLock } from '../../../shared/types/boardingLock';

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
   * #816 C — 사용자 명시 opt-in. BoardingLock 없는 trip에서 station-passed 알림 발사 허용 여부.
   * true면 backend가 lock 부재 trip에서도 intermediate waypoint 통과 시 silent push 발사한다.
   * 미설정/false면 기존 #640 게이트 그대로 (lock 없으면 push 0건).
   */
  locklessStationPassed?: boolean;
  /**
   * #903 (Seam G) — 기압계 dP/dt가 지하 진입을 시사하는가. true면 backend로 함께 전달되어
   * consecutiveEtaMissing threshold를 5→10으로 늘려 일시 GPS/arrival 누락에 더 인내한다.
   * 미설정/false면 기존 threshold(5) 유지 — 기압계 미지원 환경 graceful.
   */
  subsurface?: boolean;
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
  locklessStationPassed: boolean;
  /** #903 (Seam G) — 기압계 subsurface 신호. true면 backend threshold 5→10. */
  subsurface: boolean;
  /** 같은 trip 세션 동안 고정되는 epoch ms. backend `isSameSession` 판정 키(#589). */
  createdAt: number;
}

/**
 * BoardingLock의 내용 기반 dedup signature. main effect의 deps key와 token-refresh 경로의
 * `lastSentLockSigRef` 갱신에 동일 포맷을 사용해야 #767 release 판정이 일관 — 한 곳에서 빌드.
 */
function lockSig(lock: BoardingLock | null): string | null {
  return lock ? `${lock.trainCode}|${lock.boardingLine}|${lock.boardedAt}` : null;
}

/** 두 호출처(token refresh / main effect)의 register 페이로드 빌드를 단일화. */
async function callRegister(input: RegisterCallInputs) {
  // #622: BoardingLock metadata 빌드. lock의 boardingStationId로 station name 조회 후 schema 변환.
  // 조회/추론 실패 시 null → backend는 anchor waypoint 폴링으로 fallback (기존 동작).
  let boardingLockMeta: AlarmBoardingLock | null = null;
  if (input.boardingLock) {
    const boardingStation = getStationById(input.boardingLock.boardingStationId);
    if (boardingStation) {
      boardingLockMeta = buildBoardingLockMeta({
        lock: input.boardingLock,
        route: input.route,
        destinationName: input.destination.name,
        boardingStationName: boardingStation.name,
      });
    }
  }

  return registerActiveTrip({
    token: input.token,
    route: input.route,
    destination: input.destination.id,
    waypoints: routeToWaypoints(input.route, input.destination.name, input.currentStation),
    alarmAtEpochMs: deriveAlarmAtEpochMs(input.nextStationEtaSeconds, Date.now()),
    apnsEnv: resolveApnsEnv(),
    createdAt: input.createdAt,
    ...(boardingLockMeta ? { boardingLock: boardingLockMeta } : {}),
    // #816 C — 토글 ON이면 backend에 lockless station-passed opt-in 명시. OFF면 필드 누락.
    ...(input.locklessStationPassed ? { locklessStationPassed: true } : {}),
    // #903 (Seam G) — 기압계 subsurface ON일 때만 송신. OFF/false는 필드 누락(graceful).
    ...(input.subsurface ? { subsurface: true } : {}),
  });
}

export function useApnsTripRegistration({
  route,
  destination,
  nextStationEtaSeconds,
  currentStation = null,
  boardingLock = null,
  locklessStationPassed = false,
  subsurface = false,
}: UseApnsTripRegistrationInputs): void {
  // route 객체 reference가 categorized recompute로 자주 바뀌므로 내용 기반 signature로
  // 메모화 — register useEffect deps에 사용해 동일 경로 재등록(POST /trips 폭주) 방지.
  const routeSig = useMemo(() => routeSignature(route), [route]);
  // boardingLock도 reference가 아닌 내용 기반 key로 deps — 상위가 매 렌더 새 객체를 내려도 안전.
  // alarmBackend dedup hash와 동일 필드 사용 (trainCode + line + boardedAt).
  const boardingLockSig = lockSig(boardingLock);
  // 최신 트립 입력을 ref에 보관 — pushTokenListener가 갱신 시 재등록에 사용한다.
  const latestInputsRef = useRef({ route, destination, nextStationEtaSeconds, currentStation, boardingLock, locklessStationPassed, subsurface });
  useEffect(() => {
    latestInputsRef.current = { route, destination, nextStationEtaSeconds, currentStation, boardingLock, locklessStationPassed, subsurface };
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

  // ── 토큰 발급 + 리스너 등록 (mount-once) ──
  useEffect(() => {
    let cancelled = false;
    let subscription: { remove: () => void } | null = null;

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
          locklessStationPassed: lsp,
          subsurface: sub,
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
          locklessStationPassed: lsp,
          subsurface: sub,
          createdAt: resolveTripCreatedAt(sessionKey),
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
        return;
      }

      // 트립 있음 → 토큰 없으면 graceful skip.
      if (!token) {
        logger.info('apns token not yet available — skip register');
        return;
      }

      const sessionKey = `${token}:${routeSig}:${destination.id}`;
      const result = await callRegister({
        token,
        route,
        destination,
        nextStationEtaSeconds,
        currentStation,
        boardingLock,
        locklessStationPassed,
        subsurface,
        createdAt: resolveTripCreatedAt(sessionKey),
      });
      // POST 발사 직후(성공/실패 무관) 송신된 lock sig를 기록 — 다음 cycle이 "직전 송신 = lock,
      // 신규 = null" 패턴인지 판정해 race 차단.
      lastSentLockSigRef.current = boardingLockSig;
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
    // #816 C: 토글 변경 시 즉시 backend에 반영해야 하므로 deps에 포함. 사용자가 ON/OFF 전환하면
    // 한 cycle만에 register payload가 갱신된다.
    // #903 (Seam G): subsurface 변화 시 backend threshold(5→10)를 빨리 갱신해 지하 진입 직후
    // 일시 GPS/arrival 누락에 인내. useBarometer의 60s 윈도우 평가가 토글 폭주를 자체 흡수하므로
    // deps churn 위험 낮음. alarmBackend의 dedup hash가 subsurface 미변화 사이클은 POST를 skip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSig, destination?.id, boardingLockSig, locklessStationPassed, subsurface]);
}
