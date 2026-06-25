// ICloudKVModule.swift — NSUbiquitousKeyValueStore 래핑 (#1861 Phase 1).
//
// Phase 1 구현 내용:
//  - NSUbiquitousKeyValueStore RPC: getItem / setItem / removeItem / isAvailable
//  - synchronize() — setItem/removeItem 후 즉시 flush 시도 (best-effort)
//  - isAvailable — FileManager.default.ubiquityIdentityToken 으로 Apple ID 로그인 판정
//
// 실기기 사전 준비 (사용자 책임):
//  1. App Store Connect → Identifiers → com.subwaynow.app → iCloud Capability 활성화
//  2. KV Store identifier: $(CFBundleIdentifier)
//  3. expo prebuild 재실행 (entitlement 변경 반영, L15 Lesson 적용)

import ExpoModulesCore
import Foundation

public class ICloudKVModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ICloudKVModule")

    // iCloud KV에서 문자열 값을 읽는다.
    // Apple ID 미로그인 / 키 없음 시 nil 반환.
    AsyncFunction("getItem") { (key: String) -> String? in
      return NSUbiquitousKeyValueStore.default.string(forKey: key)
    }

    // iCloud KV에 문자열 값을 저장한다.
    // synchronize()는 OS에 즉시 flush를 요청 (best-effort — 실패해도 JS에 throw X).
    AsyncFunction("setItem") { (key: String, value: String) in
      NSUbiquitousKeyValueStore.default.set(value, forKey: key)
      NSUbiquitousKeyValueStore.default.synchronize()
    }

    // iCloud KV에서 키를 삭제한다.
    AsyncFunction("removeItem") { (key: String) in
      NSUbiquitousKeyValueStore.default.removeObject(forKey: key)
      NSUbiquitousKeyValueStore.default.synchronize()
    }

    // Apple ID 로그인 + iCloud KV 사용 가능 여부.
    // FileManager.ubiquityIdentityToken — non-nil = Apple ID 로그인 상태.
    // NSUbiquitousKeyValueStore.synchronize()를 availability check로 쓰지 않음 (side-effect).
    Function("isAvailable") { () -> Bool in
      return FileManager.default.ubiquityIdentityToken != nil
    }
  }
}
