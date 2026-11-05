import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * KeyValueStorePort — 도메인이 영속 저장소를 다룰 때 의존할 추상 인터페이스.
 *
 * AsyncStorage 직접 호출처(favorites/settings 등)를 Phase 5에서 이 port로
 * 전환해 테스트 시 InMemory 구현으로 교체할 수 있도록 한다.
 */
export interface KeyValueStorePort {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * AsyncStorageAdapter — React Native AsyncStorage 기반 KeyValueStorePort 구현.
 *
 * Phase 4에서는 어댑터만 신설한다. 호출처 전환은 Phase 5.
 */
export class AsyncStorageAdapter implements KeyValueStorePort {
  async getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
  }
}
