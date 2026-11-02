/**
 * #3036 (O3) — 도보 속도 상수 device/backend 일치 (ADR-029 경계 계약 방식).
 *
 * backend `boardingPrompt.ts`의 `WALKING_SPEED_M_PER_S`는 device `src/shared/constants/eta.ts:3`의 값을 복제한 것이다
 * (backend가 device 상수를 import하지 않는다). 한쪽만 바뀌면 O3 창 시작(등록 시각 + 걷는 시간)이 device ETA 모델과
 * 어긋나므로 값 일치를 CI에서 강제한다.
 */
import { describe, expect, it } from 'vitest';
import { WALKING_SPEED_M_PER_S as DEVICE_WALKING_SPEED_M_PER_S } from '../../../../src/shared/constants/eta';
import { WALKING_SPEED_M_PER_S } from '../boardingPrompt';

describe('WALKING_SPEED_M_PER_S device/backend 동기', () => {
  it('backend 사본 == device 상수', () => {
    expect(WALKING_SPEED_M_PER_S).toBe(DEVICE_WALKING_SPEED_M_PER_S);
  });
});
