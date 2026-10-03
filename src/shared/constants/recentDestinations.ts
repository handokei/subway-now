// #1032 — 최근 선택한 목적지 보관 개수 상한.
// useDestinationStore의 `recentDestinations` 리스트가 이 값을 넘으면
// 가장 오래된 항목부터 잘려나간다. UI는 이 리스트를 그대로 매핑해 렌더한다.
export const RECENT_ROUTES_LIMIT = 3;
