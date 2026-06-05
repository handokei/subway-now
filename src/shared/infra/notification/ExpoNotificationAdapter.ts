/**
 * ExpoNotificationAdapter — NotificationPort의 expo-notifications 구현체.
 *
 * ADR Roadmap — Feature-based + Ports & Adapters Phase 2/5 (#884).
 *
 * 위치 정책:
 *   본 어댑터는 `shared/infra/`에 있다. 이유는 다른 도메인(arrival의 silent push,
 *   향후 generic notification 등)도 같은 expo-notifications 인스턴스를 공유하기 위함.
 *   alarm features가 shared infra를 사용하는 방향은 정상 (features → shared).
 *
 * 현재 상태 (Phase 2):
 *   본 어댑터는 NotificationPort 구현의 thin entrypoint만 제공한다.
 *   alarm 도메인 내부의 기존 expo-notifications 직접 호출은 의도적으로 유지되며
 *   (PR 크기/회귀 위험 관리), Phase 5에서 일괄 본 어댑터 경유로 전환한다.
 *
 * 신규 호출자(향후 추가되는 알람/통지 경로)는 가능한 한 본 어댑터를 통해 호출하라.
 *
 * @see src/features/alarm/ports/NotificationPort.ts — 인터페이스 명세
 */

import * as Notifications from 'expo-notifications';
// NOTE: ESLint 경계 룰("shared/는 features/를 import 할 수 없다") 명목상 위반.
// 본 import는 'features/alarm/ports/NotificationPort'의 **타입만** 참조하는 컴파일타임 의존이며,
// 런타임 의존 방향은 여전히 features → shared (alarm 도메인이 본 어댑터를 호출)이다.
// Phase 5에서 NotificationPort를 features/alarm/ports/에 둘지 shared/ports/로 옮길지
// 도메인 단일성을 다시 판단 후 룰을 enforce(error)로 승격한다.
import type { NotificationPort, NotificationPayload } from '../../ports/NotificationPort';

async function scheduleImmediate(payload: NotificationPayload): Promise<void> {
  // 기존 알림 dismiss는 실패해도 무시 — 알림이 없을 수도 있음.
  try {
    await Notifications.dismissNotificationAsync(payload.id);
  } catch {
    // 기존 알림 없거나 dismiss 실패 → 무시
  }
  await Notifications.scheduleNotificationAsync({
    identifier: payload.id,
    content: {
      title: payload.title,
      body: payload.body,
      sound: payload.sound,
      ...(payload.interruptionLevel && { interruptionLevel: payload.interruptionLevel }),
      ...(payload.channelId && { channelId: payload.channelId }),
    },
    trigger: null,
  });
}

async function dismiss(id: string): Promise<void> {
  await Notifications.dismissNotificationAsync(id);
}

async function requestPermissions(): Promise<{ granted: boolean }> {
  const { status } = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowSound: true,
      allowCriticalAlerts: true,
    },
  });
  return { granted: status === 'granted' };
}

/**
 * NotificationPort 싱글톤 — 앱 부팅 시 DI 지점에서 alarm 도메인에 주입한다.
 * 현재는 import-time 노출만 제공. Phase 5에서 명시적 DI 컨테이너로 전환 예정.
 */
export const expoNotificationAdapter: NotificationPort = {
  scheduleImmediate,
  dismiss,
  requestPermissions,
};
