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
import { pickNextArrival, type StationArrival } from '../../arrival/utils/nextArrivalPick';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('TripTrainCode');

/**
 * 한 트립 내내 추종할 열차 고유번호(btrainNo)를 destination id에 묶어 저장한다.
 *
 * 저장 형태: `${destinationId}:${trainCode}` — `:`로 1회 split해 구분.
 * destinationId에 `:`가 들어와도 trainCode 쪽으로 흡수되어 매치는 영향받지 않는다.
 *
 * 라이프사이클:
 *   - lock-in: 트립 시작 후 첫 valid arrival에서 사용자 방향 첫 trainCode를 destination과
 *     함께 저장. 캡처는 active/background 상관없이 진행한다 — FG에서도 캡처되어야
 *     PoC 측정 가치가 있음.
 *   - 사용: get할 때 destinationId를 같이 넘기고, 저장된 destinationId가 일치할 때만
 *     trainCode를 돌려준다. 다른 트립의 잔여 코드는 자동으로 무시된다.
 *   - 클리어: destination 변경/제거 시, 또는 활성 트립 자체가 사라졌을 때.
 */

const SEPARATOR = ':';

export async function getStoredTripTrainCode(
  destinationId: string,
): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(TRIP_TRAIN_CODE_KEY);
    if (!raw) return null;
    const sepIdx = raw.indexOf(SEPARATOR);
    if (sepIdx <= 0) return null;
    const storedDest = raw.slice(0, sepIdx);
    if (storedDest !== destinationId) return null;
    const code = raw.slice(sepIdx + 1);
    return code || null;
  } catch (e) {
    logger.warn('읽기 실패:', e);
    return null;
  }
}

export async function setTripTrainCode(
  destinationId: string,
  code: string,
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      TRIP_TRAIN_CODE_KEY,
      `${destinationId}${SEPARATOR}${code}`,
    );
  } catch (e) {
    logger.warn('저장 실패:', e);
  }
}

export async function clearTripTrainCode(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRIP_TRAIN_CODE_KEY);
  } catch (e) {
    logger.warn('삭제 실패:', e);
  }
}

/**
 * destination에 저장된 trainCode가 있으면 그대로 반환. 없으면 현재 arrival에서 사용자 방향
 * min-ETA 열차의 trainCode를 캡처해 저장한 뒤 반환. 캡처 후보가 없으면 null.
 *
 * useScheduledAlarms / alarmRefreshTask 양쪽이 같은 캡처 사이클을 공유한다.
 */
export async function captureTripTrainCodeIfAbsent(
  destinationId: string,
  arrival: StationArrival | null,
  direction: 'up' | 'down' | null,
): Promise<string | null> {
  const existing = await getStoredTripTrainCode(destinationId);
  if (existing) return existing;
  const candidate = pickNextArrival(arrival, direction).trainCode;
  if (!candidate) return null;
  await setTripTrainCode(destinationId, candidate);
  return candidate;
}
