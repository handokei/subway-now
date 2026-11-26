// #3371 — 노선도 모드 렌더 상수. 확대 단계는 Android 버튼 scale, iOS는 min/max를 네이티브 pinch 범위로 쓴다.
export const SCHEMATIC_ZOOM_STEPS = [0.5, 1, 2, 3] as const;
export const SCHEMATIC_DEFAULT_ZOOM_INDEX = 1;
export const SCHEMATIC_LINE_THICKNESS = 5;
export const SCHEMATIC_NODE_SIZE = 12;
export const SCHEMATIC_TRANSFER_NODE_SIZE = 20;
export const SCHEMATIC_NODE_BORDER = 2;
export const SCHEMATIC_NODE_HIT_SLOP = 10;
export const SCHEMATIC_LABEL_WIDTH = 96;
export const SCHEMATIC_LABEL_HEIGHT = 14;
export const SCHEMATIC_LABEL_FONT_SIZE = 10;
export const SCHEMATIC_HIGHLIGHT_NEAREST_SIZE = 38;
export const SCHEMATIC_HIGHLIGHT_SELECTED_SIZE = 32;
export const SCHEMATIC_FOCUS_HIGHLIGHT_MS = 3000;
