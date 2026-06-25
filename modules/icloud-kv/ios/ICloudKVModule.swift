// ICloudKVModule.swift — NSUbiquitousKeyValueStore 래핑 (PoC placeholder, #1851).
//
// 현재 상태: 모듈 선언만. 실제 NSUbiquitousKeyValueStore 구현은 별 PR에서 진행.
//
// 구현 시 필요 사항:
//  1. App Store Connect → Certificates, Identifiers & Profiles → com.subwaynow.app → iCloud Capability 활성화
//  2. app.config.js entitlements: 'com.apple.developer.ubiquity-kvstore-identifier': 'com.subwaynow.app' 추가
//  3. expo prebuild 재실행 (L15 Lesson 적용)
//  4. NSUbiquitousKeyValueStoreDidChangeExternallyNotification 구독 + JS 이벤트 emit

// 실제 구현 시 아래 주석을 해제하고 ExpoModule 구현체를 완성한다.

/*
import ExpoModulesCore
import Foundation

public class ICloudKVModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ICloudKVModule")

    AsyncFunction("getItem") { (key: String) -> String? in
      return NSUbiquitousKeyValueStore.default.string(forKey: key)
    }

    AsyncFunction("setItem") { (key: String, value: String) in
      NSUbiquitousKeyValueStore.default.set(value, forKey: key)
      NSUbiquitousKeyValueStore.default.synchronize()
    }

    AsyncFunction("removeItem") { (key: String) in
      NSUbiquitousKeyValueStore.default.removeObject(forKey: key)
      NSUbiquitousKeyValueStore.default.synchronize()
    }

    Function("isAvailable") { () -> Bool in
      // Apple ID 로그인 여부는 NSUbiquitousKeyValueStore.default.synchronize() 결과로 간접 판정.
      // 실제 판정 로직은 별 PR에서 FileManager.default.url(forUbiquityContainerIdentifier:) 등 활용.
      return FileManager.default.ubiquityIdentityToken != nil
    }
  }
}
*/
