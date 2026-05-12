import {
  OFFSET_BY_UPDN,
  TRAIN_MARKER_OFFSET_DEG,
  UPDN_DOWN_OUTER,
  UPDN_UP_INNER,
  getMarkerOffset,
} from '../trainMarkerOffset';

describe('trainMarkerOffset', () => {
  it('상수가 스펙과 일치 (0:상행/내선, 1:하행/외선)', () => {
    expect(UPDN_UP_INNER).toBe(0);
    expect(UPDN_DOWN_OUTER).toBe(1);
  });

  it('OFFSET_BY_UPDN: 상행은 서쪽(-), 하행은 동쪽(+), 위도 변화 없음', () => {
    expect(OFFSET_BY_UPDN[UPDN_UP_INNER]).toEqual({ dLat: 0, dLng: -TRAIN_MARKER_OFFSET_DEG });
    expect(OFFSET_BY_UPDN[UPDN_DOWN_OUTER]).toEqual({ dLat: 0, dLng: TRAIN_MARKER_OFFSET_DEG });
  });

  it('getMarkerOffset: 매핑된 값을 그대로 반환', () => {
    expect(getMarkerOffset(UPDN_UP_INNER)).toEqual({ dLat: 0, dLng: -TRAIN_MARKER_OFFSET_DEG });
    expect(getMarkerOffset(UPDN_DOWN_OUTER)).toEqual({ dLat: 0, dLng: TRAIN_MARKER_OFFSET_DEG });
  });

  it('getMarkerOffset: 미지 값(2, -1)은 0 오프셋', () => {
    expect(getMarkerOffset(2)).toEqual({ dLat: 0, dLng: 0 });
    expect(getMarkerOffset(-1)).toEqual({ dLat: 0, dLng: 0 });
  });
});
