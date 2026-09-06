# Plan #1851 — iCloud KV Sync Feasibility Audit

> 폰 교체 시 즐겨찾기·destination·설정이 모두 초기화되는 UX 문제 해결 옵션 정리.
> 본 문서는 **feasibility audit** 이며, 구현은 결정 후 별 PR에서 진행한다.

---

## §1 사용자 가치 매트릭스

| 사용자 상황 | 소실 데이터 | 현재 가치 손실 |
|---|---|---|
| 폰 교체 / 기기 초기화 | 즐겨찾기(home/work 슬롯 포함) | ★★★ 재설정 번거로움 |
| 폰 교체 / 기기 초기화 | recentDestinations (최근 목적지 LRU) | ★★ 목적지 재선택 |
| 폰 교체 / 기기 초기화 | sleepMode · allowSpeaker · accessibilityMode | ★★ 설정 재입력 |
| 앱 재설치 (같은 기기) | 위와 동일 | ★★ (iCloud 없이 해결 불가) |
| 다수 기기 동시 사용 | 실시간 동기화 필요 | ★ (out of scope 1차) |

V/X 매트릭스 매핑 (기존 V1~V9 확장 불필요 — 신규 사용자 가치 카테고리):

- **V-retain-favorites**: 폰 바꿔도 즐겨찾기(home/work) 복원 ≤10초
- **V-retain-destination**: recentDestinations LRU 복원
- **V-retain-settings**: sleepMode·allowSpeaker·accessibilityMode 복원
- **X-no-apple-id-lock**: Apple ID 없는 Android/신규 사용자가 기능 미작동으로 blocked되지 않음
- **X-no-cloud-overwrite**: 신규 기기가 구형 cloud 데이터로 현재 데이터를 덮어쓰지 않음

---

## §2 현재 State 영속 메커니즘

### 영속 키 목록 (sync 대상 후보)

| 상수 키 | 스토어 | 데이터 크기 | 비고 |
|---|---|---|---|
| `FAVORITES_KEY` | `useFavoritesStore` | ~수 KB (역 JSON 배열) | home/work 슬롯 포함 |
| `DESTINATION_KEY` | `useDestinationStore` | ~수 KB (Station JSON) | 현재 목적지 |
| `RECENT_DESTINATIONS_KEY` | `useDestinationStore` | ~수십 KB (LRU 20개) | 최근 목적지 목록 |
| `SLEEP_MODE_KEY` | `useSettingsStore` | 수 바이트 | boolean |
| `ALLOW_SPEAKER_KEY` | `useSettingsStore` | 수 바이트 | boolean |
| `ACCESSIBILITY_MODE_KEY` | `useSettingsStore` | 수 바이트 | boolean |
| `LOCALE_PREFERENCE_KEY` | (설정 화면) | 수 바이트 | 언어 선택 |

### sync 제외 대상 (runtime/session 상태)

다음 키들은 trip runtime 상태이므로 기기 간 sync 시 오작동 유발. sync 제외 필수.

`ACTIVE_TRIP_KEY`, `BOARDING_LOCK_KEY`, `TRIP_CORR_ID_KEY`, `RAW_SIGNAL_BUFFER_KEY`,
`BACKEND_SSOT_MIRROR_KEY`, `BG_LAST_FIX_KEY`, `BG_LAST_STATION_KEY`,
`FIRING_PUSH_IDS_KEY`, `TRIP_ENDED_BY_BACKEND_AT_KEY`, `LA_DISMISSED_AT_KEY` 등.

### 현재 스토리지 추상화

`src/shared/infra/storage/AsyncStorageAdapter.ts` 에 `KeyValueStorePort` 추상 인터페이스가 이미 존재한다:

```ts
export interface KeyValueStorePort {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
```

각 store(`useFavoritesStore`, `useSettingsStore`, `useDestinationStore`)는 현재 `AsyncStorage`를
직접 호출한다. Port 전환은 Phase 5 후속 작업으로 표시만 돼 있고 미구현.

---

## §3 옵션 3+ (false binary 차단)

### 옵션 A: iCloud NSUbiquitousKeyValueStore (native module 신규)

Apple의 기기 간 KV sync API. 512 key / 1 MB 총합 제한.

**장점**:
- Apple ID 있으면 자동 sync, 사용자 별도 로그인 불필요
- iOS + macOS 동작

**단점**:
- **native module 신규 개발 필요** — `modules/icloud-kv/` Swift 브릿지 + JS 바인딩
- `expo-modules-core`로 wrapping 필요 (live-activity 모듈과 동형)
- `com.apple.developer.ubiquity-kvstore-identifier` entitlement + iCloud capability 활성화 필요
- App Store Connect에서 iCloud Capability 수동 추가 필요
- **1 MB 총합 제한** — `RAW_SIGNAL_BUFFER_KEY`(최대 120 entry × ~500B = ~60KB) 등은 제외해야 함
- sync 지연 ~5분 (Apple 문서 기준 "typically seconds to minutes")
- `NSUbiquitousKeyValueStoreDidChangeExternallyNotification` 구독 + conflict resolution 필요
- **Android 미지원** — 안드로이드 사용자는 혜택 없음
- `expo prebuild` 재실행 필요 (L15 Lesson 적용)

**기존 패턴 참고**: `modules/live-activity/` 구조와 동형으로 구현 가능
- `expo-module.config.json`, `package.json`, Swift class 파일, TypeScript index

**시장 라이브러리**: `react-native-icloudstore` (GitHub star ~200)
- 마지막 업데이트 2022년 — **유지보수 중단 상태**
- Expo Modules Core 미지원 → 직접 구현이 신뢰성 우위

### 옵션 B: CloudKit Private Database (CKRecord)

Apple CloudKit record-based storage. 사용자당 25 GB.

**장점**:
- 1 MB 제한 없음, record-based 구조화 가능
- 대용량·복잡한 데이터 모델 지원

**단점**:
- 네이티브 API 복잡도 A 대비 3~5배 — async fetch/save, conflict resolution, subscription notification
- Expo SDK에 공식 래퍼 없음 → **순수 Swift + 직접 JS 브릿지**
- 개발 비용 A 대비 2~3주 추가
- Android 미지원 (A와 동일)
- iCloud 계정 필요

**결론**: 현재 저장 데이터 크기(favorites + settings ≤ 수십 KB)가 A의 1 MB 한도 내 수용 가능. B는 오버엔지니어링. 데이터 모델이 복잡해지면 재검토.

### 옵션 C: Expo SecureStore + QR / Share Sheet 내보내기·가져오기

로컬에 JSON으로 export → QR 또는 share sheet → 신규 기기에서 import.

**장점**:
- **완전 device-self-contained** — iCloud/Apple ID 의존 없음
- Android·iOS 모두 동작
- native 추가 개발 없음 (Expo APIs만 사용)
- 민감 데이터(APNS token 등)는 자연 제외

**단점**:
- 사용자가 직접 export/import 액션 필요 — 수동 UX
- QR은 추가 UI 개발(카메라 스캔)
- Share Sheet는 share대상(파일) 개발 필요
- "자동 복원" 경험 아님 — 기대와 다를 수 있음

**구현 범위**: `src/features/settings/` 하위에 export/import hook + UI 추가.
`KeyValueStorePort` 전환 없이도 가능.

### 옵션 D: Supabase Auth + remote storage

이슈 #79 OAuth 기반. 별도 계정 시스템.

**장점**:
- iOS·Android·Web 모두
- 실시간 sync 가능

**단점**:
- **이슈 #79 epic 선행 필요** — 현재 auth 인프라 없음
- 계정 생성/로그인 UX 마찰 (Apple ID 없이 별도 계정)
- backend infra 추가 (서버 비용)
- 개발 비용 최대

**결론**: 단기 구현 현실적으로 불가. #79 epic 완료 후 재검토.

### 옵션 E: 현재 유지 (AsyncStorage 기기-로컬, 변경 없음)

**장점**:
- 개발 비용 0
- iCloud 의존 없음

**단점**:
- 폰 교체 시 즐겨찾기·설정 100% 소실

---

## §4 트레이드오프 표

| 기준 | A (iCloud KV) | B (CloudKit) | C (Export/Import) | D (Supabase) | E (현상 유지) |
|---|:---:|:---:|:---:|:---:|:---:|
| 자동 복원 (수동 액션 없음) | ✅ | ✅ | ❌ | ✅ | ❌ |
| Apple ID 의존 | ✅ 필요 | ✅ 필요 | ❌ 불필요 | ❌ 별도 계정 | ❌ |
| Android 지원 | ❌ | ❌ | ✅ | ✅ | ✅ |
| native 신규 개발 | ~2주 | ~4~6주 | 없음 | 없음(#79 의존) | 없음 |
| 데이터 용량 | 1 MB 총합 | 25 GB | 기기 용량 | 서버 용량 | 기기 용량 |
| sync 지연 | 초~분 | 초~분 | 즉시(수동) | <1s | N/A |
| expo prebuild 필요 | ✅ | ✅ | ❌ | ❌ | ❌ |
| conflict resolution | 필요 | 복잡 | 없음(덮어쓰기) | 필요 | N/A |
| 개발 비용 | 중 (~2주) | 높음 (~4~6주) | 낮음 (~1주) | 매우 높음 | 없음 |
| 사용자 가치 | ★★★ | ★★★ | ★★ | ★★★ | ❌ |

---

## §5 시장 Evidence

### Apple NSUbiquitousKeyValueStore

- Apple HIG 권장: "small amounts of data that reflect the app's state" — 즐겨찾기·설정에 적합
- 512 key 제한, 총합 1 MB — 현재 sync 대상 ~6개 키, 예상 최대 ~100 KB (수용 가능)
- sync 시점: 변경 후 "seconds to minutes" (Apple Docs). 앱 포어그라운드 복귀 시 즉시 pull
- conflict resolution: `NSUbiquitousKeyValueStoreServerRecordWins` — 서버 우선 덮어쓰기 정책 (단순)
- entitlement 필요: `com.apple.developer.ubiquity-kvstore-identifier`

### Expo 호환성

- Expo SDK 54 + `expo-modules-core` — `requireOptionalNativeModule` 패턴으로 래핑 가능
- `modules/live-activity/` 가 정확히 동일 패턴 — Swift class + `expo-module.config.json` + TS index
- Expo Go 미지원 (live-activity와 동일), development build 필요

### react-native-icloudstore 평가

- GitHub: [nicktindall/cycjimmy-icloud](https://github.com/nicktindall/cycjimmy-icloud) 계열 다수
- 마지막 커밋: 2022~2023년 — **유지보수 중단**
- New Architecture(Expo 54 기본) 비지원
- **결론**: 직접 구현 권장

### 앱스토어 정책 제약

- NSUbiquitousKeyValueStore 사용 시 App Store Connect에서 iCloud Capability 수동 활성화 필요
- Privacy nutrition label: "Data Used to Track You" — 위치/즐겨찾기를 iCloud로 보내는 행위 선언 필요 (favorites는 역명/좌표, 개인 식별 정보 아님 → "Usage Data" 카테고리로 처리 가능)

---

## §6 결정: 옵션 A (iCloud NSUbiquitousKeyValueStore) 권장

### 권장 근거

1. **Apple ID = iOS 사용자 표준** — subway-now iOS-only 앱. 한국 iOS 사용자 Apple ID 보급률 사실상 100%.
2. **1 MB 한도 수용 가능** — sync 대상 6개 키, 최대 ~100 KB. 충분한 여유.
3. **기존 native module 패턴 존재** — `modules/live-activity/`와 동형. 구조 이해 비용 없음.
4. **KeyValueStorePort 추상화 이미 존재** — `AsyncStorageAdapter`와 동일 인터페이스로 `iCloudKVAdapter`를 구현하면 store 변경 최소화.
5. **자동 복원** — 사용자 수동 액션 없이 로그인만 돼 있으면 복원.

### 비권장 이유

- 옵션 B: 오버엔지니어링, 현재 데이터 모델에 1 MB 충분
- 옵션 C: 수동 UX, "자동 복원" 사용자 기대와 불일치
- 옵션 D: #79 epic 선행 필요, 현실적으로 단기 구현 불가
- 옵션 E: V-retain-favorites 가치 포기

### 주의사항

- **Android 미지원** — Android 사용자는 현재 AsyncStorage만. 향후 D(Supabase)로 통합 가능. 현재는 "iOS 전용 기능"으로 명시.
- conflict resolution 정책: **서버 우선** — 가장 최근 write 우선. 두 기기 동시 수정 시 last-write-wins. 즐겨찾기 특성상 acceptable.
- entitlement + App Store Connect 수동 설정 필요 — 실기기 빌드 전 portal 설정 필요.

---

## §7 PoC Skeleton — 옵션 A

구현 범위: **TypeScript binding + Swift shell만**. 실제 `NSUbiquitousKeyValueStore` 호출은 별 PR에서 진행.

### 신규 파일 목록

```
modules/icloud-kv/
  expo-module.config.json    — Expo native module 선언
  package.json               — module 패키지 메타
  index.ts                   — TypeScript API 공개 인터페이스
  ios/
    ICloudKVModule.swift     — ExpoModule 래핑 (stub only)
```

```
src/shared/infra/storage/
  ICloudKVAdapter.ts         — KeyValueStorePort 구현 (현재 AsyncStorage fall-through)
  ICloudKVAdapter.test.ts    — 단위 테스트
```

### 공개 TypeScript API (index.ts)

```ts
/** iCloud KV get/set/remove — iOS only. Android는 항상 null/no-op. */
export function getCloudItem(key: string): Promise<string | null>;
export function setCloudItem(key: string, value: string): Promise<void>;
export function removeCloudItem(key: string): Promise<void>;
/** iCloud 연결 여부. Apple ID 미로그인 시 false. */
export function isICloudAvailable(): boolean;
```

### ICloudKVAdapter (KeyValueStorePort 구현)

```ts
// src/shared/infra/storage/ICloudKVAdapter.ts
export class ICloudKVAdapter implements KeyValueStorePort {
  async getItem(key: string): Promise<string | null> {
    if (!isICloudAvailable()) return null;
    return getCloudItem(key);
  }
  async setItem(key: string, value: string): Promise<void> {
    if (!isICloudAvailable()) return;
    return setCloudItem(key, value);
  }
  async removeItem(key: string): Promise<void> {
    if (!isICloudAvailable()) return;
    return removeCloudItem(key);
  }
}
```

### useAppStore에 sync hook 자리 (별 PR에서 구현)

```ts
// useFavoritesStore.ts — 실제 sync는 별 PR
// iCloudSync(FAVORITES_KEY, updated); // TODO: #1851 follow-up
```

### 연동 전략 (별 PR)

1. `loadFavorites()` 시 로컬 AsyncStorage + iCloud KV 모두 읽어 merge (iCloud 우선).
2. `addFavorite / removeFavorite / setSlotFavorite / setFavoriteLabel` write 시 두 곳에 동시 write.
3. iCloud unavailable 시 AsyncStorage fallback — degraded-graceful.

### 제외 (본 PR 아님)

- 실제 `NSUbiquitousKeyValueStore` Swift 구현
- store 전환 (`useFavoritesStore` 등을 ICloudKVAdapter로 변경)
- conflict resolution 로직
- entitlement 변경 (`app.config.js` 수정)

---

## §8 Acceptance + Wire-completion 5단

### Acceptance (feasibility PR)

- [ ] plan doc §1~§9 완성
- [ ] 옵션 3+ 비교 표 작성
- [ ] 결정 1택 + 근거 명시
- [ ] PoC skeleton TypeScript 타입 정의 (stub)
- [ ] `npm test` 100% + `npm run type-check` pass

### Wire-completion 5단

1. **Orphan 없음**: `ICloudKVAdapter`는 test에서만 호출 (entry-point). `modules/icloud-kv/index.ts`는 향후 구현 PR의 entry-point이므로 ignore 패턴 추가 필요 (별 PR에서).
   - 본 PR에서 신규 export가 orphan이 되지 않도록 test에서 import.
2. **V/X dashboard**: feasibility doc — dashboard 불필요. N/A.
3. **의존 PR**: N/A. 독립 feasibility doc.
4. **측정 plan**: 구현 PR에서. 본 PR은 분석 단계.
5. **Device verify**: N/A — type+unit only. 실 구현 PR에서 실기기 Apple ID 로그인 테스트 필요.

---

## §9 관련 메모리 / 결정

- `memory/feedback_device_self_contained_fusion.md` — device-self-contained 철학과 충돌 X (즐겨찾기 sync는 위치/trip 로직과 무관)
- `memory/reference_branch_ruleset.md` — dev 브랜치 base, PR 머지 사용자 전담
- `memory/feedback_decision_no_false_binary.md` — §3에서 5가지 옵션 제시로 준수
- `tasks/lessons.md` L1: false binary 차단 — §3에서 5개 옵션 제시 ✅
- `tasks/lessons.md` L15: expo prebuild drift — 옵션 A 선택 시 entitlement 추가 후 prebuild 필수 명시 ✅

## §10 구현 이슈 로드맵 (feasibility 후속)

결정이 A로 확정되면:

1. **PR A**: `modules/icloud-kv/` Swift 구현 + `ICloudKVAdapter` 완성 + entitlement 추가
2. **PR B**: `useFavoritesStore` iCloud write-through 연동
3. **PR C**: `useSettingsStore` + `useDestinationStore` iCloud write-through 연동
4. **PR D**: conflict resolution + merge strategy (서버 우선 + createdAt 비교)

각 PR은 같은 파일 건드리므로 직렬 머지 (L9 적용).
