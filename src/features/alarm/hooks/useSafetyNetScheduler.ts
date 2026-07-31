/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 hook은 destination(route feature) + settings(sleepMode) +
 * safetyNetScheduler(alarm feature)를 묶는 단일 owner orchestrator다. useTripBoundAlarmScheduler /
 * useBoardingLockScheduler(#2089로 통합·제거)와 동일한 옵트인 패턴(file-level disable).
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Route } from '../../../shared/utils/stationRoute';
import { routeSignature } from '../../../shared/utils/stationRoute';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import {
  cancelAllSafetyNetAlarms,
  registerSafetyNetAlarms,
} from '../utils/safetyNetScheduler';
import { getTripStartedAt } from '../utils/tripStartStorage';
import { useSettingsStore } from '../../settings/store/useSettingsStore';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('useSafetyNetScheduler');

export interface UseSafetyNetSchedulerInputs {
  route: Route;
  destinationName: string | null;
}

/**
 * #2089 — OS 예약 스케줄러 3종(alarmScheduler/tripBoundScheduler/boardingLockScheduler)의
 * 단일 후속 owner. `safetyNetScheduler`를 호출해 sleepMode ON인 trip에 한해 안전망 알람을
 * 등록/취소한다.
 *
 * 정책(새 역할 — "취침모드일 때만 등록"):
 * - sleepMode가 꺼져 있으면 항상 cancel-only(등록 없음). 기존 boardingLockScheduler는
 *   sleepMode를 ref로만 캡처해 effect deps에서 제외했지만(#632, "이미 예약된 알람은 sleep
 *   토글에 영향받지 않는 trade-off"), 본 hook은 sleepMode 자체가 전체 게이트이므로 의도적으로
 *   effect dependency에 포함한다 — 토글 즉시 등록/취소가 반영돼야 새 역할과 정합.
 * - tripToken(=ACTIVE_TRIP_KEY, APNs 등록 성공 후 기록)과 tripStart(=trip 시작 시각) 둘 다
 *   있어야 등록 — 어느 하나라도 없으면(예: backend 등록 race) 이번 cycle은 cancel-only.
 * - identity = `${tripToken}|${routeSig}|${destinationName}|sleep:${sleepMode}`. 이전과
 *   동일하면 no-op, 다르면 이전 등록을 cancel한 뒤 새로 등록한다.
 * - 언마운트 시에는 cancel하지 않는다 — trip 종료는 `tripBoundCleanups`가 담당(#1924/#1525
 *   defensive cancel과 동일 소유 경계).
 */
export function useSafetyNetScheduler({ route, destinationName }: UseSafetyNetSchedulerInputs): void {
  const sleepMode = useSettingsStore((s) => s.sleepMode);
  // 마지막으로 성공 등록(또는 명시적으로 cancel-only 처리)한 identity. null이면
  // "현재 큐에 안전망 알람 없음" 상태.
  const registeredIdentityRef = useRef<string | null>(null);
  const registeredTripTokenRef = useRef<string | null>(null);
  // async race 가드 — 이전 effect run이 완료되기 전에 새 effect가 시작되면 stale completion이
  // ref를 잘못 덮어쓰지 않도록 in-flight token으로 차단.
  const inFlightTokenRef = useRef(0);

  useEffect(() => {
    const myToken = ++inFlightTokenRef.current;

    const run = async (): Promise<void> => {
      const routeSig = routeSignature(route);
      const nextIdentityBase = `${routeSig}|${destinationName ?? ''}|sleep:${sleepMode}`;

      if (!sleepMode || route === null || destinationName === null) {
        if (registeredIdentityRef.current !== null && registeredTripTokenRef.current) {
          await cancelAllSafetyNetAlarms(registeredTripTokenRef.current);
        }
        if (myToken !== inFlightTokenRef.current) return;
        registeredIdentityRef.current = null;
        registeredTripTokenRef.current = null;
        return;
      }

      const [tripToken, tripStart] = await Promise.all([
        AsyncStorage.getItem(ACTIVE_TRIP_KEY),
        getTripStartedAt(),
      ]);
      if (myToken !== inFlightTokenRef.current) return;

      if (tripToken === null || tripStart === null) {
        // 등록에 필요한 정보가 아직 준비되지 않음(backend register race 등) — 이번 cycle skip.
        // 직전 등록이 있었다면 그대로 유지 — 정보 부재가 곧 trip 종료를 의미하지 않는다.
        return;
      }

      const nextIdentity = `${tripToken}|${nextIdentityBase}`;
      if (registeredIdentityRef.current === nextIdentity) return;

      if (registeredIdentityRef.current !== null && registeredTripTokenRef.current) {
        await cancelAllSafetyNetAlarms(registeredTripTokenRef.current);
      }
      if (myToken !== inFlightTokenRef.current) return;

      const result = await registerSafetyNetAlarms({
        tripToken,
        route,
        destinationName,
        startTime: tripStart,
      });
      if (myToken !== inFlightTokenRef.current) return;
      registeredIdentityRef.current = nextIdentity;
      registeredTripTokenRef.current = tripToken;
      logger.info(`registered ${result.scheduled} safety-net alarms tripToken=${tripToken.slice(0, 8)}`);
    };

    run().catch((e: unknown) => {
      logger.error('safetyNetScheduler 전환 실패:', e);
    });
  }, [route, destinationName, sleepMode]);
}
