/* eslint-disable import/no-restricted-paths --
 * #1575 (T12, ADR-017) — Cross-feature orchestration: notice 슬라이스의 NotificationRouter를
 * widget / live-activity / in-app store surface와 wire한다. notice 슬라이스가 직접 alarm/widget을
 * import하면 sibling 경계 위반이므로 본 alarm 슬라이스의 api/ 모듈에서 wiring을 담당한다.
 *
 * 후속 PR(별도 이슈)에서 orchestration 슬라이스로 이전 예정. 현재는 alarm이 notification 발사
 * 본거지라 alarm/api 안에 두는 것이 가장 자연스럽다.
 */

import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createNotificationRouter,
  type RouterSsotMirror,
  type RouterSurfaceFns,
} from '../../notice/infra/NotificationRouterImpl';
import type { NotificationRouter } from '../../notice/ports/NotificationRouter';
import {
  clearWidgetStation,
  saveStationToWidget,
} from '../../widget/api/widgetStorage';
import { buildWidgetTripContext } from '../../widget/utils/buildTripContext';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { ROUTE_KEY } from '../../../shared/constants/storageKeys';
import type { Route } from '../../../shared/utils/stationRoute';
import { readBackendSsotMirror } from '../utils/backendSsotMirror';
import { useAlarmEventStore } from '../store/useAlarmEventStore';
import type { AlarmEvent } from '../../../shared/types/alarm';
import type { Station } from '../../../shared/types/station';

/**
 * #1929 — notification widget surface(F-W4)에서 ROUTE_KEY storage를 hydrate.
 * router는 store에 route slice가 없어 async storage access가 유일한 경로.
 * 미존재 / parse 실패는 graceful null — buildWidgetTripContext가 route undefined로 처리해
 * nextTransferName undefined로 stamp (trip은 여전히 활성, 환승 정보만 누락).
 */
async function readRouteFromStorage(): Promise<Route | null> {
  try {
    const raw = await AsyncStorage.getItem(ROUTE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Route;
  } catch {
    return null;
  }
}

/**
 * SSoT mirror reader adapter — notice 슬라이스가 alarm의 backendSsotMirror를 직접 못 import하므로
 * 본 wiring 레이어에서 변환해 inject. 미존재 / parse 실패 시 null → router가 검증 skip.
 */
async function readSsotMirrorForRouter(): Promise<RouterSsotMirror | null> {
  const entry = await readBackendSsotMirror();
  if (entry === null) return null;
  return {
    passedStations: entry.passedStations,
    receivedAt: entry.receivedAt,
  };
}

/**
 * 4 surface side-effect fan-out 함수 묶음.
 *
 * - banner: expo-notifications.scheduleNotificationAsync (trigger: null = 즉시 발사).
 * - live-activity: 본 PR 범위 밖 — 후속 PR에서 ensureLiveActivityRegistered / updateLiveActivity 매핑.
 * - widget: req.content.data.station(Station JSON)이 있으면 widget storage update, 없으면 no-op.
 * - in-app: useAlarmEventStore.setAlarmEvent — req.content.data.alarmEvent(AlarmEvent)가 있을 때만.
 *
 * surface 함수는 본 PR 시점에 안전한 default 동작만 정의. 호출자 migration PR에서 점진 확장.
 */
function buildDefaultSurfaces(): RouterSurfaceFns {
  return {
    banner: async (req) => {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: req.content.title,
          body: req.content.body,
          ...(req.content.data ? { data: req.content.data } : {}),
        },
        trigger: null,
      });
    },
    liveActivity: () => {
      // 후속 PR에서 wire — modules/live-activity ensureLiveActivityRegistered / updateLiveActivity
      // signature가 LiveActivityData (trip 컨텍스트 + leg 정보)를 요구해 본 PR의 DeliveryRequest
      // 만으로는 불충분. surface별 migration PR에서 호출자가 직접 req.content.data로 LiveActivityData
      // 를 구성해 전달한다.
    },
    widget: async (req) => {
      const station = req.content.data?.station;
      const distanceKm = req.content.data?.distanceKm;
      if (
        station &&
        typeof station === 'object' &&
        typeof distanceKm === 'number'
      ) {
        // #1929 (F-W4) — tripContext stamp로 SubwayWidget.swift:229 RC-15 expired-gate 활성화.
        // notification surface는 async caller — destination은 store sync access,
        // route는 ROUTE_KEY storage에서 async hydrate. 모두 graceful (실패 시 undefined tripContext).
        const destination = useDestinationStore.getState().destination;
        const route = await readRouteFromStorage();
        const tripContext = buildWidgetTripContext({
          destination,
          currentStation: station as Station,
          route,
        });
        await saveStationToWidget(
          station as Station,
          distanceKm,
          undefined,
          undefined,
          tripContext,
        );
      }
    },
    inApp: (req) => {
      const alarmEvent = req.content.data?.alarmEvent;
      if (alarmEvent && typeof alarmEvent === 'object') {
        useAlarmEventStore.getState().setAlarmEvent(alarmEvent as AlarmEvent);
      }
    },
    clearAll: async () => {
      // trip-bound cleanup: widget station 비우기. banner queue / LA / in-app store는 기존
      // tripBoundCleanups의 다른 항목들이 이미 클리어한다 (ALARM_EVENT_KEY 등). 본 함수는
      // router 진입점 단일화로 인한 추가 cleanup만 담당.
      await clearWidgetStation();
    },
  };
}

let singleton: NotificationRouter | null = null;

/**
 * 앱 어디서든 호출 가능한 router singleton accessor. 첫 호출 시 lazy 생성.
 *
 * production 호출자는 모두 본 함수 경유로 같은 dedup map을 공유한다 (module-level Set).
 * 테스트는 `__resetRouterSingletonForTest()`로 reset 후 자체 surfaces로 createNotificationRouter
 * 직접 호출 (NotificationRouter.test.ts 패턴).
 */
export function getNotificationRouter(): NotificationRouter {
  if (singleton === null) {
    singleton = createNotificationRouter({
      surfaces: buildDefaultSurfaces(),
      readSsotMirror: readSsotMirrorForRouter,
    });
  }
  return singleton;
}

/** 테스트 전용 — singleton reset. production caller 없음. */
export function __resetRouterSingletonForTest(): void {
  singleton = null;
}
