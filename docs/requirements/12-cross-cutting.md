# 12. 횡단 관심사

도메인 하나에 속하지 않고 **앱 전체**에 걸쳐 일관되게 보장돼야 하는 항목.

---

## 접근성 (Accessibility)

목표 수준: **WCAG AA**

- 사용자는 모든 인터랙티브 요소에 `accessibilityLabel`이 부여된 것을 보장받는다.
- 사용자는 OS 글자 크기 설정(`allowFontScaling`)에 따라 텍스트가 확대됨을 보장받는다.
- 사용자는 텍스트/배경 대비 **4.5:1 이상**을 보장받는다.
- 사용자는 터치 영역이 최소 **44×44pt** 이상임을 보장받는다.
- 사용자는 알람·알림 메시지가 명확하고 완결된 문장(예: "2호선 잠실역에서 8호선으로 환승하세요")으로 제공됨을 보장받는다.
- 사용자는 VoiceOver/TalkBack을 켠 상태에서 모든 핵심 동선(진입→경로 설정→탑승→알람→하차)을 완수할 수 있다.

⚠️ 현재 상태: `accessibilityLabel`이 5개 화면(DestinationPicker/HomeScreen/MapScreen/SettingsScreen/LanguageScreen)에만 부여됨. `accessibilityRole`/`Hint`·`allowFontScaling`·대비·터치 영역 정책 모두 미구현. **접근성 모드 토글**(`storageKeys.ts:17` `ACCESSIBILITY_MODE_KEY`)은 저장소·store 토글만 있고 UI 실제 적용 없음 — 반쪽 구현.

---

## 개인정보

원칙: **최소 수집·최소 보관**

- 사용자는 위치 좌표가 backend에 60초 ring buffer 이상으로 영속 저장되지 않음을 보장받는다.
- 사용자는 backend 식별자가 **APNs token** 외에 사용되지 않음을 보장받는다. (이메일/계정 미수집)
- 사용자는 위치 좌표가 로그(콘솔)에 남지만 외부 전송되지 않음을 보장받는다.
- 사용자는 AsyncStorage에 저장된 즐겨찾기·경로 히스토리가 기기 외부로 전송되지 않음을 보장받는다.
- 사용자는 데이터 정책을 설정 화면에서 한 줄 요약으로 확인할 수 있다.

✅ 현재 정책 (코드 일치): `src/features/alarm/api/positionUpload.ts:180-197` → `POST /position`로 `{token, lat, lng, accuracy, ts, motion, [accelSummary, mapMatchedLine, mapMatchedArcM, nearestStationDistanceM]}` 전송. KV 60초 ring buffer만, 영속 X. APNs token이 유일 식별자 (이메일/계정 미수집). 로그(`logger.ts`)는 콘솔만, 외부 전송 없음.

---

## 오프라인

원칙: **stale 허용, 명시적 차단 없음**

- 사용자는 인터넷이 끊긴 상태에서도 마지막으로 받은 시간표·도착·경로 정보로 trip이 진행됨을 보장받는다.
- 사용자는 위치 신호(GPS)는 인터넷과 무관하게 계속 동작함을 보장받는다.
- 사용자는 데이터가 30초 이상 갱신되지 않으면 **stale 표시**("방금 전" → "1분 전" → "5분 전")를 받을 수 있다.
- 사용자는 5분 이상 끊긴 경우에만 명시적 오프라인 표시를 받는다.
- 사용자는 인터넷 복구 시 즉시 fresh 데이터로 정정됨을 보장받는다.

---

## 에너지/배터리

원칙: **정확도 우선, 측정 후 최적화**

- 사용자는 trip이 활성화된 동안만 위치 폴링이 동작함을 보장받는다.
- 사용자는 정지 상태(5분 미이동)에서 폴링이 슬립됨을 보장받을 수 있다. ⚠️ 미구현
- 사용자는 다음 역 임박 시 arrival API가 5초 주기로, 멀 때 15~30초 주기로 동적 조절됨을 보장받을 수 있다. ⚠️ 미구현
- 사용자는 1시간 사용 시 배터리 소모량이 측정·공개됨을 보장받는다. ⚠️ 측정 인프라 필요

⚠️ 현재 상태: arrival 5초 고정 폴링, BG GPS 30초/20m 고정, 슬립/적응형 정책 없음.

---

## 다국어 (i18n)

지원 언어: 한국어 / 영어 / 일본어 / 중국어

- 사용자는 OS 언어 설정에 따라 자동으로 언어가 적용됨을 보장받는다.
- 사용자는 4개 언어 모두에서 동등한 UI·알람 메시지 품질을 받는다.
- 사용자는 역명·노선명이 해당 언어 표기 기준에 맞게 표시됨을 보장받는다.
- 사용자는 알람·알림 메시지가 누락된 번역 없이 제공됨을 보장받는다.

---

## 테마

- 사용자는 OS 다크/라이트 모드 설정에 따라 자동 전환됨을 보장받는다.
- 사용자는 동적 색상(`useTheme()`)이 모든 컴포넌트에서 일관되게 적용됨을 보장받는다.
- 사용자는 라이트(Editorial Light B)·다크(C·Focus) 두 테마에서 동일 기능을 사용할 수 있다.

---

## 사용자 피드백 / 운영

원칙: **사용자가 문제를 겪었을 때 우리가 알 수 있어야 한다.**

### 버그 신고 (사용자 명시 입력 → 자체 backend)

- 사용자는 앱 내 설정에서 **버그 신고 / 기능 제안** 화면에 진입할 수 있다. ⚠️ 미구현
- 사용자는 신고 시 자동으로 첨부되는 컨텍스트(앱 버전·OS·언어·현재 trip 상태)를 미리 확인하고 동의할 수 있다. ⚠️ 미구현
- 사용자는 신고 내용이 자체 backend(Cloudflare Worker)로 전달되어 운영자가 확인할 수 있음을 보장받는다. ⚠️ 미구현
- 결정된 저장 방안: **Cloudflare KV `FEEDBACK` namespace 신규 추가** + `POST /feedback` endpoint. 이유: 자유 텍스트 + 메타 저장에 최적, TTL로 자연 폐기, 스키마 진화 불필요. (D1·R2 비추 — 정규화/blob 필요 없음.)

### 자동 에러·크래시 모니터링 (자동 수집 → 외부 SaaS)

- 사용자는 앱이 비정상 종료된 경우 자동으로 크래시 리포트가 운영자에게 전송됨을 보장받는다. ⚠️ 미구현
- 사용자는 진단 데이터 자동 수집을 **옵트인 토글**로 켜고 끌 수 있다. ⚠️ 미구현
- 결정된 솔루션: **Sentry (옵션 A)**. 이유: React Native 1급 지원 + iOS native crash 자체로 잡기 어려움 + 무료 티어(5K events/mo)로 시작 가능. 도입 30분.
- 개인정보 정책에 "Sentry로 진단 데이터 전송 (옵트인 시)" 명시 필요.

⚠️ 현재 상태: `package.json`에 외부 에러 모니터링 의존성 없음. `logger.ts`는 console.log/warn/error만 호출하며 외부 전송 없음. React Error Boundary 미구현. 사용자 피드백 채널 부재.

---

## 코드 진입점

- i18n: `src/shared/i18n/`, 자동 감지: `detectDeviceLanguage()` (expo-localization), 검증 테스트: `i18n.test.ts:22-56`
- 로케일 파일: `locales/{ko,en,ja,zh}.json`
- 테마: `src/shared/theme/`, `useTheme()` 32개 컴포넌트 사용
- 로깅 (콘솔만, 외부 X): `src/shared/utils/logger.ts`
- 개인정보 전송: `src/features/alarm/api/positionUpload.ts:180-197`
- 오프라인 캐시 (TTL): `src/shared/utils/ttlCache.ts`, arrival 30s TTL `useArrivalInfo.ts:10`
- 접근성 모드 토글 (반쪽): `src/shared/constants/storageKeys.ts:17` `ACCESSIBILITY_MODE_KEY`
