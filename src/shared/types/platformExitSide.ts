// 승강장 구조 기반 하차문 방향.
//
// 사용자 통찰 — 하차문 방향은 승강장 구조로 결정되는 고정 정보:
//   상대식 → right (선로 양쪽에 승강장)
//   섬식   → left  (선로 한가운데 승강장)
//   복합식/단선/시종착역 → both (분기/회차로 방향 가변)
//
// 이 SSOT는 진행 방향(up/down)과 무관한 정적 데이터다.
// 방향별 fine-grained 정보는 src/data/exitSide.json (사용자 검수형) 참조.
export type PlatformExitSide = 'left' | 'right' | 'both';

// station id → exit side 맵. 매핑이 없는 역은 키 자체가 없다 (helper가 null 반환).
export type PlatformExitSideMap = Record<string, PlatformExitSide>;
