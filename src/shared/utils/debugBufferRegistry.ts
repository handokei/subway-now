/**
 * #1348 — DebugModal "Share dump" SSOT registry.
 *
 * 배경:
 *   기존 `buildDumpText`는 alarm log만 enumerate. fusionDebugBuffer / estimatorDebugBuffer
 *   등 in-memory ring buffer는 UI 섹션에는 표시되지만 share 출력에는 누락 — sticky cascade
 *   같은 발열 root cause를 single-source(alarm log)로는 못 잡았던 사고가 발단.
 *
 *   대안 1: buildDumpText에 buffer마다 매개변수를 추가 — 새 buffer가 늘 때마다 share 함수
 *           서명 + 호출자 + 본문을 동시에 손대야 한다. 정확히 이번 사고의 재발 패턴.
 *   대안 2(채택): buffer 측이 module-eager에 registry에 dump callable을 등록. share는 registry를
 *           순회만 한다. 새 buffer 추가 시 한 줄(`registerDebugBuffer`)이면 share에 자동 포함.
 *
 * 책임 분리:
 *   - registry는 `{ key, dump }` 쌍의 ordered 모음(등록 순서 보존)만 관리.
 *   - 포맷은 share 호출자(buildDumpText)가 결정 — 본 파일은 "어떤 buffer가 dump 가능한가"에만 관여.
 */

export interface DebugBufferSource {
  /** dump 섹션 제목 (예: 'Fusion log', 'Estimator State'). */
  readonly key: string;
  /**
   * 섹션 본문을 줄별로 반환. 빈 배열이면 호출자가 "(empty)" 같은 placeholder로 처리.
   * 본 함수 내부에서 throw하지 않을 것 — registry 순회 도중 한 source 실패가
   * 다른 source를 막지 않아야 한다. 호출자에서 추가 가드 없이 신뢰하도록 계약.
   */
  dumpLines(): readonly string[];
}

/**
 * Module-eager singleton — buffer 모듈이 import만 되면 자동으로 등록된다.
 * insertion order(=등록 순서)를 보존하기 위해 Map 사용. 같은 key 재등록 시 마지막 등록이 우선.
 */
const registry = new Map<string, DebugBufferSource>();

/**
 * buffer source 등록. 모듈 top-level에서 호출해 import 시점에 자동 등록되게 한다.
 *
 * 동일 key 재등록은 마지막 등록이 우선 — 테스트에서 mock dump 주입 시 유용.
 */
export function registerDebugBuffer(source: DebugBufferSource): void {
  registry.set(source.key, source);
}

/**
 * 등록된 모든 buffer source를 등록 순서대로 반환. 호출자가 enumerate해 share dump 구성.
 */
export function getRegisteredDebugBuffers(): readonly DebugBufferSource[] {
  return [...registry.values()];
}

/**
 * 테스트 전용 — registry를 초기화. production code에서는 호출 금지.
 */
export function __resetDebugBufferRegistryForTests(): void {
  registry.clear();
}
