/**
 * WidgetStoragePort — 홈 위젯에 표시할 역 정보를 외부 저장소에 쓰는 도메인 인터페이스.
 *
 * Ports & Adapters: 도메인은 이 port에만 의존하고, 실제 저장 매체(iOS App Groups,
 * web no-op 등)는 `src/shared/infra/storage/` 어댑터가 구현한다.
 *
 * Phase 4에서는 정의만 제공한다 — 호출처(stationNotification 등)는 여전히
 * `widgetStorage.ts` 함수를 직접 호출한다. Phase 5에서 어댑터 주입으로 전환.
 */
export interface WidgetStoragePort {
  /** 현재 역과 거리(km)를 위젯 저장소에 쓰고 WidgetCenter를 리로드한다. */
  saveStation(stationName: string, lineColor: string, distanceKm: number): Promise<void>;
  /** 위젯에 저장된 역 정보를 초기화한다. */
  clearStation(): Promise<void>;
}
