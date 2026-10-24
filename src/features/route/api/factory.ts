import type { TimetableProvider } from './TimetableProvider';
import { StaticTimetableProvider } from './StaticTimetableProvider';

/**
 * TimetableProvider 1순위 선택자 (#1480).
 *
 * 본 PR 1차: 항상 정적 JSON Provider 반환 (외부 endpoint stub 미구현 단계).
 *
 * Follow-up sub에서 환경 변수(예: `EXPO_PUBLIC_USE_TRAIN_SCH=true`)로
 * `SeoulTrainSchProvider` / `SeoulOpenApiTimetableProvider` swap.
 */
export function createTimetableProvider(): TimetableProvider {
  return new StaticTimetableProvider();
}
