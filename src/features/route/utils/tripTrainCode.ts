/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TRIP_TRAIN_CODE_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('TripTrainCode');

/**
 * #2767 — 저장/캡처 API(setTripTrainCode/captureTripTrainCodeIfAbsent/getStoredTripTrainCode)는
 * 프로덕션 writer가 0건이라 useStationAlarm.ts의 API-imminent 경로와 함께 제거됐다
 * (audit-2026-09-20-gate-census-device.md §1-C). trip 종료 시 잔여 키를 정리하는
 * clearTripTrainCode만 tripBoundCleanups.ts 소비자가 남아 있어 유지한다.
 */
export async function clearTripTrainCode(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRIP_TRAIN_CODE_KEY);
  } catch (e) {
    logger.warn('삭제 실패:', e);
  }
}
