// #456: DebugModal을 release 빌드에서도 접근 가능하게 하는 single source of truth.
// dev 빌드(__DEV__)는 항상 활성. release 빌드는 EXPO_PUBLIC_DEBUG_MODAL=true일 때만 활성 —
// 일반 배포 빌드는 flag 없음 → 자동 비활성. 모달 마운트·트리거 양쪽이 같은 함수를 본다.
//
// const로 캡쳐하면 jest의 __DEV__ override가 반영되지 않아 함수로 노출.
// EXPO_PUBLIC_* 는 Expo가 빌드 타임에 인라인하므로 매 호출 평가에 비용 거의 없음.
export function isDebugModalEnabled(): boolean {
  return __DEV__ || process.env.EXPO_PUBLIC_DEBUG_MODAL === 'true';
}

/** 설정 탭 버전 7탭 트리거. Android 개발자 옵션 컨벤션. */
export const DEBUG_MODAL_TRIGGER_TAP_COUNT = 7;
/** 탭 간격이 이 시간을 넘으면 카운트 reset — 우발적 누적 트리거 방지. */
export const DEBUG_MODAL_TRIGGER_RESET_MS = 1500;

// #2379 (Phase 2-device 복원, #2067 되돌리기) — BG pipeline(stationPipeline.ts)이 device 로컬
// visible 알림을 직접 발사하게 하는 빌드타임 플래그. OFF(기본)면 기존 동작(backend push 단일
// 의존) 완전 불변 — 회귀 0. ON이면 잠금 화면에서도 발사되도록 로컬 발사 경로 + 과억제 게이트
// (movement) 우회가 활성화된다. isDebugModalEnabled와 동일 패턴 — __DEV__ 자동 활성 없이
// env 값만으로 게이트(의도적 opt-in, 실기기 dogfood 빌드 전용).
export function isMinimalAlarmEnabled(): boolean {
  return process.env.EXPO_PUBLIC_MINIMAL_ALARM === 'true';
}
