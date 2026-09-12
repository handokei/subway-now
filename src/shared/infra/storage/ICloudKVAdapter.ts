import { getCloudItem, isICloudAvailable, removeCloudItem, setCloudItem } from 'icloud-kv';
import { type KeyValueStorePort } from './AsyncStorageAdapter';

/**
 * ICloudKVAdapter — NSUbiquitousKeyValueStore 기반 KeyValueStorePort 구현 (PoC skeleton, #1851).
 *
 * iCloud 미가용(Android / Apple ID 미로그인 / 모듈 미구현) 시 모든 메서드가 graceful no-op.
 * 실제 write-through 연동(useFavoritesStore 등)은 별 PR에서 진행한다.
 *
 * 사용 대상 키 (sync 대상):
 *  - FAVORITES_KEY, DESTINATION_KEY, RECENT_DESTINATIONS_KEY
 *  - SLEEP_MODE_KEY, ALLOW_SPEAKER_KEY, ACCESSIBILITY_MODE_KEY, LOCALE_PREFERENCE_KEY
 *
 * 제외 키 (runtime/session 상태 — sync 금지):
 *  - ACTIVE_TRIP_KEY, BOARDING_LOCK_KEY, TRIP_CORR_ID_KEY, RAW_SIGNAL_BUFFER_KEY 등
 */
export class ICloudKVAdapter implements KeyValueStorePort {
  async getItem(key: string): Promise<string | null> {
    if (!isICloudAvailable()) {
      return null;
    }
    return getCloudItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    if (!isICloudAvailable()) {
      return;
    }
    return setCloudItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    if (!isICloudAvailable()) {
      return;
    }
    return removeCloudItem(key);
  }
}
