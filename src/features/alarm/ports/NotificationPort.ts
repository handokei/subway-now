/**
 * NotificationPort — alarm 도메인이 외부 알림 인프라(expo-notifications, Live Activity, APNs 등)와
 * 대화할 때 사용할 추상 인터페이스.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" — Phase 2/5 (#884).
 *
 * 목적:
 *   alarm 도메인 코드(`src/features/alarm/`)가 expo-notifications 같은 특정 인프라에
 *   직접 의존하지 않도록 추상화를 도입한다. 어댑터 구현은 `src/shared/infra/notification/`
 *   (예: ExpoNotificationAdapter)에 둔다.
 *
 * 점진적 마이그레이션 정책 (Phase 2 시점):
 *   기존 호출부(stationNotification, alarmScheduler 등)는 여전히 expo-notifications를
 *   직접 import한다. 이는 PR 크기와 회귀 위험을 줄이기 위한 의도적 선택이다.
 *   신규 호출자는 가능한 한 NotificationPort 경유로 작성하고, Phase 5에서 모든 직접
 *   호출을 본 Port + ExpoNotificationAdapter로 일괄 전환한다.
 *
 * 본 Port는 인터페이스 선언만 한다 — 구현체는 Adapter가 제공.
 *
 * @see src/shared/infra/notification/ExpoNotificationAdapter.ts
 * @see https://app.notion.com/p/36e30c0194b68148ba29f2bc4554ce8a (ADR 노션)
 */

/** 알람 발사 시 어댑터에 전달하는 최소 페이로드. */
export interface NotificationPayload {
  /** 알림 식별자 — 동일 id로 재호출 시 갱신/대체된다. */
  id: string;
  title: string;
  body: string;
  /** iOS: 'critical'/'timeSensitive' 등 interruption level. Android는 channelId로 대체. */
  interruptionLevel?: 'timeSensitive' | 'critical';
  /** Android 채널 id — 채널이 사전 등록되어 있어야 한다. */
  channelId?: string;
  /** 알람 사운드 파일명 또는 false. */
  sound?: string | boolean;
}

/**
 * 알람 인프라를 추상화하는 Port.
 *
 * 호출자(alarm 도메인)는 expo-notifications를 직접 알지 않고 이 인터페이스만 의존한다.
 * 어댑터 교체로 테스트/모킹/대체 인프라 적용이 가능해진다.
 */
export interface NotificationPort {
  /** 단일 알림 발사. 기존 같은 id 알림은 dismiss 후 재예약. */
  scheduleImmediate(payload: NotificationPayload): Promise<void>;
  /** 특정 알림 dismiss. */
  dismiss(id: string): Promise<void>;
  /** 알림 권한 요청 (앱 부팅 시 1회). */
  requestPermissions(): Promise<{ granted: boolean }>;
}
