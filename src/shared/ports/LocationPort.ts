/**
 * LocationPort — nearest-station 도메인이 외부 위치 인프라(expo-location, native CoreLocation 등)와
 * 대화할 때 사용할 추상 인터페이스.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" — Phase 3/5 (#886).
 *
 * 목적:
 *   nearest-station 도메인 코드(`src/features/nearest-station/`)가 expo-location 같은 특정 인프라에
 *   직접 의존하지 않도록 추상화를 도입한다. 어댑터 구현은 `src/shared/infra/location/`
 *   (ExpoLocationAdapter, FakeLocationAdapter)에 둔다.
 *
 * 점진적 마이그레이션 정책 (Phase 3 시점):
 *   기존 호출부(useNearestStation, useBackgroundLocation, backgroundLocationTask, alarm의
 *   silentPushLocationGate 등)는 여전히 expo-location을 직접 import한다. 이는 PR 크기와
 *   회귀 위험을 줄이기 위한 의도적 선택이다. 신규 호출자는 가능한 한 LocationPort 경유로
 *   작성하고, Phase 5에서 모든 직접 호출을 본 Port + ExpoLocationAdapter로 일괄 전환한다.
 *
 * 본 Port는 인터페이스 선언만 한다 — 구현체는 Adapter가 제공.
 *
 * @see src/shared/infra/location/ExpoLocationAdapter.ts
 * @see src/shared/infra/location/FakeLocationAdapter.ts (E2E mock)
 * @see https://app.notion.com/p/36e30c0194b68148ba29f2bc4554ce8a (ADR 노션)
 */

/** 단일 위치 측정 결과. expo-location의 LocationObject 중 도메인이 쓰는 필드만 노출. */
export interface LocationFix {
  /** 위도 (degrees). */
  latitude: number;
  /** 경도 (degrees). */
  longitude: number;
  /** 수평 정확도 (meters). null 가능. */
  accuracy: number | null;
  /** 속도 (m/s). null 가능. */
  speed: number | null;
  /** 측정 시각 (Unix epoch ms). */
  timestamp: number;
}

/** 권한 요청 결과. */
export interface LocationPermissionResult {
  granted: boolean;
  /** Always vs WhileInUse 구분 (iOS). Android는 false 고정. */
  background: boolean;
}

/**
 * 위치 인프라를 추상화하는 Port.
 *
 * 호출자(nearest-station 도메인)는 expo-location을 직접 알지 않고 이 인터페이스만 의존한다.
 * 어댑터 교체(예: FakeLocationAdapter)로 E2E/테스트/대체 인프라 적용이 가능해진다.
 */
export interface LocationPort {
  /** 단발 위치 측정 (현재 위치 1회). */
  getCurrentPosition(): Promise<LocationFix>;
  /** Foreground 위치 권한 요청. */
  requestForegroundPermissions(): Promise<LocationPermissionResult>;
}
