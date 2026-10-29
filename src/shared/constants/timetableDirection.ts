import type { LineNumber } from '../types/station';

/**
 * 시간표 JSON의 up/down 극성이 `directionOnLine`(up/down)과 어긋나는 노선 (#1480 PR-C §9-3).
 *
 * 인접역 쌍마다 "A 출발 후 6분 안에 B가 따라오는" 시간표 열을 대조한 다수결 결과이며,
 * `timetableDirectionPolarity.test.ts`가 실데이터로 이 목록을 매번 재도출해 어긋나면 실패한다.
 * 여기 있는 노선의 환승 대기는 시간표(방향 뒤집힘 → 반대 방향 열차를 고르는 오류) 대신
 * 배차간격/2(U3)로 추정한다. 시간표 극성을 고치는 것은 별도 작업이다.
 */
export const TIMETABLE_DIRECTION_MISMATCH_LINES: readonly LineNumber[] = ['9'];
