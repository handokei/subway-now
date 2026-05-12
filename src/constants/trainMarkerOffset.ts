/**
 * 같은 역에 상행+하행 트레인이 동시에 매칭되면 마커가 픽셀 단위로 완전히 겹쳐
 * 시각적으로 구분되지 않는다. `updnLine` 기준으로 위경도를 ±N도 만큼 오프셋해
 * 좌우로 분리한다(카카오/네이버 지도와 동일 패턴).
 *
 * 스펙: scripts/서울시+지하철+실시간+열차+위치정보.xls
 *   - updnLine: 0 = 상행/내선, 1 = 하행/외선
 *
 * 단위: 위도/경도 도(degree). 서울 위도(37.5°) 기준 경도 1° ≈ 88km이므로
 * 0.00018° ≈ 16m. 줌 레벨 5 이상에서 분리되어 보이도록 잡았다.
 */
export const TRAIN_MARKER_OFFSET_DEG = 0.00018;

export const UPDN_UP_INNER = 0;
export const UPDN_DOWN_OUTER = 1;

export interface MarkerOffset {
  dLat: number;
  dLng: number;
}

/**
 * updnLine → 위경도 오프셋. 미지 값(2 이상 또는 음수)은 오프셋 없음.
 *
 * 호선 방향성(N-S vs E-W)에 따라 트랙 수직 방향이 달라지지만, 대부분의 줌 레벨에서
 * 경도 오프셋만으로도 시각적 분리가 충분하다. 호선별 차별화가 필요해지면 별도
 * `OFFSET_BY_LINE` 매핑을 추가해 이 값을 override하는 방식으로 확장한다.
 */
export const OFFSET_BY_UPDN: Record<number, MarkerOffset> = {
  [UPDN_UP_INNER]: { dLat: 0, dLng: -TRAIN_MARKER_OFFSET_DEG },
  [UPDN_DOWN_OUTER]: { dLat: 0, dLng: TRAIN_MARKER_OFFSET_DEG },
};

const ZERO_OFFSET: MarkerOffset = { dLat: 0, dLng: 0 };

export function getMarkerOffset(updnLine: number): MarkerOffset {
  return OFFSET_BY_UPDN[updnLine] ?? ZERO_OFFSET;
}
