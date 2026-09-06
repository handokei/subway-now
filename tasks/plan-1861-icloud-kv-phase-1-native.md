# Plan #1861 — iCloud KV Phase 1: Swift Native 실 구현 + Entitlement

> PoC skeleton(#1856)을 실제 NSUbiquitousKeyValueStore RPC로 전환.
> Phase 2(store 연동) 이전 단계. adapter + native만 완성.

---

## §1 사용자 가치

| Phase 1 완료 시 얻는 것 |
|---|
| 이후 Phase 2/3에서 useFavoritesStore + useSettingsStore를 ICloudKVAdapter로 전환하면 폰 교체 시 즐겨찾기·설정 자동 복원 가능 |
| native RPC가 완성돼 있어야 Phase 2 단독 PR로 store 연동 가능 (Phase 1 미완 시 Phase 2 불가) |

---

## §2 변경 파일 목록

| 파일 | 변경 유형 | 설명 |
|---|---|---|
| `modules/icloud-kv/ios/ICloudKVModule.swift` | 수정 | stub 주석 해제 → 실 구현 |
| `plugins/with-icloud-kv.js` | 신규 | entitlements 자동 주입 config plugin |
| `app.config.js` | 수정 | plugins 배열에 with-icloud-kv 추가 |
| `src/shared/infra/storage/__tests__/ICloudKVAdapter.test.ts` | 확인 | 기존 테스트로 100% 커버. 추가 불필요 |

---

## §3 Swift 구현 설계 (ICloudKVModule.swift)

### RPC 목록

| 함수 | Swift 타입 | 설명 |
|---|---|---|
| `getItem(key: String)` | `AsyncFunction → String?` | `NSUbiquitousKeyValueStore.default.string(forKey:)` |
| `setItem(key: String, value: String)` | `AsyncFunction → Void` | `set(_:forKey:)` + `synchronize()` |
| `removeItem(key: String)` | `AsyncFunction → Void` | `removeObject(forKey:)` + `synchronize()` |
| `isAvailable()` | `Function → Bool` | `FileManager.default.ubiquityIdentityToken != nil` |

### synchronize() 정책

Apple 문서: "synchronize() returns false if the iCloud KV store is not available."
- `setItem`/`removeItem` 후 `synchronize()` 호출 — 즉시 flush 시도
- 실패 시 OS가 나중에 자동 sync. JS 측에 error throw 하지 않음 (best-effort flush)

### isAvailable 판정

`FileManager.default.ubiquityIdentityToken` — Apple ID 로그인 + iCloud 사용 가능 시 non-nil.
- 가장 단순하고 신뢰도 높은 방법 (CloudKit container 없이 작동)
- NSUbiquitousKeyValueStore.default.synchronize()를 availability check로 쓰지 않음 (side-effect 있음)

---

## §4 Entitlement 주입 전략

### App Store Connect 수동 설정 (사용자 책임)

1. App Store Connect → Certificates, Identifiers & Profiles → `com.subwaynow.app`
2. iCloud Capability 활성화
3. KV Store identifier: `$(CFBundleIdentifier)` (= `com.subwaynow.app`)

### config plugin: `plugins/with-icloud-kv.js`

`withEntitlementsPlist`로 `com.apple.developer.ubiquity-kvstore-identifier` 주입.

식별자 값: `$(CFBundleIdentifier)` — Apple 권장 방식.

live-activity plugin(`withEntitlementsPlist` 사용)과 동형 패턴.

### app.config.js 적용

`plugins` 배열에 `'./plugins/with-icloud-kv'` 추가.

---

## §5 Fallback 설계 (기존 유지)

`modules/icloud-kv/index.ts`의 `requireOptionalNativeModule` 패턴이 이미 fallback 처리:
- 모듈 미구현 → null → `isICloudAvailable()` false → `ICloudKVAdapter` 모든 메서드 graceful no-op
- Android → `Platform.OS !== 'ios'` → null → 동일

Phase 1에서 변경 없음. 기존 코드 그대로 유지.

---

## §6 테스트 전략

기존 `ICloudKVAdapter.test.ts` 8개 케이스가 JS bridge 100% 커버:

| 시나리오 | 테스트 |
|---|---|
| iCloud 가용 + getItem | ✅ 기존 |
| iCloud 가용 + getItem null | ✅ 기존 |
| iCloud 가용 + setItem | ✅ 기존 |
| iCloud 가용 + removeItem | ✅ 기존 |
| iCloud 미가용 + getItem → null + 미호출 | ✅ 기존 |
| iCloud 미가용 + setItem → no-op | ✅ 기존 |
| iCloud 미가용 + removeItem → no-op | ✅ 기존 |

Swift native 측 테스트는 실기기 검증 (CI에서 불가). Phase 4 XCTest로 보완 예정.

---

## §7 Wire-completion 5단 자가 점검

1. **Orphan 없음**: `ICloudKVAdapter`가 test에서 import. `modules/icloud-kv/index.ts`는 `IGNORE_PATTERN`에 이미 있거나 추가. 확인 필요.
2. **V/X dashboard**: Phase 1 — store 연동 없으므로 observable 신호 없음. N/A.
3. **의존 PR**: #1856 (PoC skeleton) 머지됨.
4. **측정 plan**: Phase 4 후 1주 (즐겨찾기 sync 사용자 비율 관측).
5. **Device verify**: entitlement 빌드 후 실기기 iCloud 가용 환경 확인 필요 (사용자 책임).

---

## §8 구현 순서

1. `ICloudKVModule.swift` 주석 해제 → 실 구현 완성
2. `plugins/with-icloud-kv.js` 신규 작성
3. `app.config.js` plugin 등록
4. orphan check 스크립트 확인 + IGNORE_PATTERN 점검
5. `npm test` 100% + `npm run type-check` pass
6. commit + PR

---

## §9 관련 결정 / 메모리

- plan-1851: §6 결정 = 옵션 A (iCloud KV). Phase 1 = §10 PR A.
- lesson L15: `expo prebuild` 재실행 필요 — entitlement 추가 시 필수. PR 본문에 명시.
- `withEntitlementsPlist` 패턴: `modules/live-activity/app.plugin.js` 참고.
