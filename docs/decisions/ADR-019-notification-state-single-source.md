# ADR-019: 알림 상태 단일 출처 도입 — Foreground/Background dedup 통합

## 상태

채택됨 — PR #243 (2026-05-12), 이슈 #242. 후속으로 Android `timeInterval` 옵션화, GPS 게이트 임계값 재조정, FG↔BG 통합 테스트 큐.

## 배경

사용자의 백그라운드 알림 신뢰성 질문("백그라운드에서도 매역마다 알림 잘 들어오는지")을 계기로 코드 감사 수행 결과, "마지막으로 알림을 보낸 역(`lastNotifiedStationId`)"이 **두 채널로 분리되어** 추적되고 있었음.

- **Foreground**: `useStationAlarm.ts`의 `useRef<string | null>` — 메모리 전용
- **Background**: `backgroundLocationTask.ts`의 `LAST_NOTIFIED_STATION_KEY` — AsyncStorage

두 채널은 서로의 변경을 모르므로 이상 동작 발생:

1. Foreground에서 강남역 통과 → `useRef`만 갱신, AsyncStorage 미반영
2. 사용자가 앱을 백그라운드로 전환
3. 같은 강남역 부근에서 GPS 업데이트 → Background task가 AsyncStorage에서 이전 값을 읽음 → **중복 알림**
4. 컴포넌트 언마운트/리마운트 시 `useRef`는 초기화 → 앱 복귀 직후 동일 역에 또 알림

근본 원인: **"메모리 상태와 영속 상태가 둘 다 진실의 후보"라는 이중화 구조 자체**.

## 옵션 비교

| 옵션 | 장점 | 단점 | 판정 |
|---|---|---|---|
| **A. 얇은 저장소 모듈 (AsyncStorage 래퍼)** | 백그라운드 친화, hydration race 없음, 키 캡슐화, generic helper로 확장성 | 비동기 호출, 포그라운드 자동 리렌더 없음 | **채택** |
| B. Zustand persist store | 포그라운드 자동 리렌더, 프로젝트 패턴 일관성 | persist는 "메모리=진실, 스토리지=스냅샷" — 문제 재발 | 거부 |
| C. 인라인 AsyncStorage (모듈화 없음) | 최소 변경 | 키가 호출지점에 흩어짐, 보일러플레이트 반복 | 거부 |

### A 채택 이유

1. **문제의 근본을 제거**: AsyncStorage를 유일한 출처로 만들어 메모리/스토리지 이중화 자체를 폐기
2. **백그라운드 친화**: TaskManager 콜백은 React 라이프사이클 밖이라 hooks/persist 사용 불가. 순수 함수는 양쪽에서 동일하게 호출
3. **확장성**: 향후 다른 알림 상태(예: `lastAlarmPhase`) 추가 시 generic helper 위에 thin wrapper만 추가

## 결정

### `src/utils/notificationState.ts` (신규)

```typescript
async function safeGetItem(key: string): Promise<string | null> { ... }
async function safeSetItem(key: string, value: string): Promise<void> { ... }
async function safeRemoveItem(key: string): Promise<void> { ... }

export const getLastNotifiedStationId = () => safeGetItem(LAST_NOTIFIED_STATION_KEY);
export const setLastNotifiedStationId = (id: string) => safeSetItem(LAST_NOTIFIED_STATION_KEY, id);
export const clearLastNotifiedStationId = () => safeRemoveItem(LAST_NOTIFIED_STATION_KEY);
```

Generic helper(`safeGetItem` 등)에 try/catch + logger 보일러플레이트를 캡슐화. 향후 상태 키가 늘어도 한 줄 wrapper로 확장 가능.

### useStationAlarm cleanup 기반 cancellation

- `lastNotifiedStationIdRef` 제거
- useEffect 내부에서 async IIFE로 `getLastNotifiedStationId` → 비교 → `sendStationPassedNotification` → `setLastNotifiedStationId`
- `let cancelled = false` + `return () => { cancelled = true; }` 패턴. A→B→A 빠른 변동 시 stale IIFE가 cancelled 체크에서 early return

### 알림 발송 후에만 storage write

**변경 전**: `setLastNotifiedStationId(id)` → `sendStationPassedNotification(...)` 순서. 알림 발송 실패 시에도 storage는 이미 갱신 → 해당 역 알림을 영구히 놓침.

**변경 후**: `sendStationPassedNotification(...)` 성공 시에만 `setLastNotifiedStationId(id)` 호출. 발송 실패 시 다음 폴링에서 자연스러운 재시도.

## 결과

### 긍정

- Foreground/Background 단일 출처 보장 → 중복 알림 차단
- 컴포넌트 언마운트/리마운트 시에도 알림 상태 유지
- 알림 발송 실패 시 재시도 가능 (이전 구현은 영구 누락)
- `notificationState` 모듈은 향후 `lastAlarmPhase`, `lastNotifiedRouteId` 등 다른 알림 상태로 확장 시 thin wrapper만 추가
- 커버리지 100% 유지 (747 tests, 53 suites)

### 부정

- AsyncStorage read가 매 effect re-fire마다 발생 (실측 영향 미미, 30s 폴링 수준)
- async IIFE 도입으로 동기 흐름이던 ref 비교가 비동기 흐름으로 전환

## Lessons Learned

- **"메모리 + 스토리지 이중화"는 동기화 버그의 표준 패턴**. 단일 출처를 먼저 정의하고, 다른 채널은 캐시/뷰로 명시할 것.
- **Zustand persist는 양방향 동기화 도구가 아니다**. React 외부(TaskManager, BackgroundFetch)에서 쓰면 hydration race가 곧바로 발생.
- **확장성은 함수명에서 결정된다**. "두 번째 키를 추가하는 비용"이 진짜 확장성 척도.
- **race 방어는 in-flight ref가 아니라 cleanup cancellation**. cancel 플래그가 충분하면 ref는 dead code.
- **알림 발송과 storage write 순서는 사용자 영향이 크다**. 외부 사이드 이펙트가 있는 단계는 그 성공 여부로 상태 전이를 게이트할 것.

## References

- Issue #242, PR #243
- Notion: https://app.notion.com/p/35d30c0194b6811f8e7bcfd3b4473d76
- 관련 ADR: ADR-020 (GPS 신뢰성 게이트)
