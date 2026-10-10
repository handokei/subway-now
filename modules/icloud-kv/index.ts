/**
 * icloud-kv — NSUbiquitousKeyValueStore JS 바인딩 (PoC skeleton, #1851).
 *
 * 현재 상태: TypeScript API 정의만. Swift 구현은 별 PR에서 진행.
 * - iOS: requireOptionalNativeModule('ICloudKVModule') — 미구현 시 null 반환 (graceful).
 * - Android / 기타: 모두 no-op / null 반환.
 *
 * 공개 API:
 *  - getCloudItem(key)        → iCloud KV에서 값 조회. 미가용 시 null.
 *  - setCloudItem(key, value) → iCloud KV에 값 저장. 미가용 시 no-op.
 *  - removeCloudItem(key)     → iCloud KV에서 키 삭제. 미가용 시 no-op.
 *  - isICloudAvailable()      → Apple ID 로그인 + iCloud KV 사용 가능 여부.
 *
 * 주의: App Store Connect에서 iCloud Capability 활성화 + entitlement 추가 필수 (별 PR).
 */
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

const ICloudKVModule =
  Platform.OS === 'ios' ? requireOptionalNativeModule('ICloudKVModule') : null;

/**
 * iCloud KV에서 값을 읽는다.
 * iCloud 미가용(Apple ID 미로그인 / 모듈 미구현) 시 null 반환.
 */
export async function getCloudItem(key: string): Promise<string | null> {
  return (ICloudKVModule?.getItem(key) as Promise<string | null> | undefined) ?? null;
}

/**
 * iCloud KV에 값을 저장한다.
 * iCloud 미가용 시 no-op.
 */
export async function setCloudItem(key: string, value: string): Promise<void> {
  await (ICloudKVModule?.setItem(key, value) as Promise<void> | undefined);
}

/**
 * iCloud KV에서 키를 삭제한다.
 * iCloud 미가용 시 no-op.
 */
export async function removeCloudItem(key: string): Promise<void> {
  await (ICloudKVModule?.removeItem(key) as Promise<void> | undefined);
}

/**
 * Apple ID 로그인 상태 + iCloud KV 사용 가능 여부.
 * Android / 모듈 미구현 / Apple ID 미로그인 시 false.
 */
export function isICloudAvailable(): boolean {
  return (ICloudKVModule?.isAvailable() as boolean | undefined) ?? false;
}
