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
import type { Station } from '../types/station';
import type { Route } from '../utils/stationRoute';
import { routeSignature, getStationById } from '../utils/stationRoute';
import { registerActiveTrip, clearActiveTrip, type AlarmBoardingLock } from '../api/alarmBackend';
import { routeToWaypoints } from '../utils/routeWaypoints';
import { buildBoardingLockMeta } from '../utils/buildBoardingLockMeta';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../constants/storageKeys';
import { createLogger } from '../utils/logger';
import { resolveApnsEnv } from '../utils/apnsEnv';
import type { BoardingLock } from '../types/boardingLock';

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
  /** 같은 trip 세션 동안 고정되는 epoch ms. backend `isSameSession` 판정 키(#589). */
  createdAt: number;
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
  });
}

export function useApnsTripRegistration({
  route,
  destination,
  nextStationEtaSeconds,
  currentStation = null,
  boardingLock = null,
}: UseApnsTripRegistrationInputs): void {
  // route 객체 reference가 categorized recompute로 자주 바뀌므로 내용 기반 signature로
  // 메모화 — register useEffect deps에 사용해 동일 경로 재등록(POST /trips 폭주) 방지.
  const routeSig = useMemo(() => routeSignature(route), [route]);
  // boardingLock도 reference가 아닌 내용 기반 key로 deps — 상위가 매 렌더 새 객체를 내려도 안전.
  // alarmBackend dedup hash와 동일 필드 사용 (trainCode + line + boardedAt).
  const boardingLockSig = boardingLock
    ? `${boardingLock.trainCode}|${boardingLock.boardingLine}|${boardingLock.boardedAt}`
    : null;
  // 최신 트립 입력을 ref에 보관 — pushTokenListener가 갱신 시 재등록에 사용한다.
  const latestInputsRef = useRef({ route, destination, nextStationEtaSeconds, currentStation, boardingLock });
  useEffect(() => {
    latestInputsRef.current = { route, destination, nextStationEtaSeconds, currentStation, boardingLock };
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
          createdAt: resolveTripCreatedAt(sessionKey),
        });
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

    (async () => {
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
        createdAt: resolveTripCreatedAt(sessionKey),
      });
      // #669: cancelled 가드 밖에서 setItem — backend register 성공이면 UI cleanup 여부와 무관하게
      // ACTIVE_TRIP_KEY를 동기화. 가드 안에 두면 nextStationEtaSeconds·currentStation 변경으로
      // useEffect cleanup이 자주 일어나 setItem이 skip되고 DebugModal activeTrip이 (none)으로 표시됨.
      if (result.ok) {
        await AsyncStorage.setItem(ACTIVE_TRIP_KEY, token);
      }
    })();

    return () => {
      cancelled = true;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSig, destination?.id, boardingLockSig]);
}
