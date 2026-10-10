# 10. 취침 모드

## 책임
사용자가 잠든 상태에서도 알람을 받을 수 있되, **옆 사람에게는 들리지 않도록** 이어폰 채널로만 출력한다.

## 경계
- 일반 상태의 알람은 [06-alarm.md](./06-alarm.md).
- 알림(정보 전달)은 취침 모드 영향 없음 — [07-notice.md](./07-notice.md).

---

## 기본 동작

- 사용자는 취침 모드를 직접 켜고 끌 수 있다.
- 사용자는 취침 모드와 별개로 **"스피커 출력 허용"(`allowSpeaker`) 설정 토글**을 직접 켜고 끌 수 있다. 기본 ON.
- 사용자는 `allowSpeaker`를 끄면 알람이 **소리 없이 진동·시각 표시만**으로 전달됨을 보장받는다. (사실상 이어폰 착용 시에만 청취 가능)
- 사용자는 `allowSpeaker` ON 상태에서 알람을 OS 오디오 라우팅에 따라 스피커 또는 이어폰으로 들을 수 있다.
- 사용자는 취침 모드 상태가 잠금화면 표시·위젯에 명확히 노출됨을 보장받는다.

## 예외 / 경계 조건

- 사용자는 알람이 아닌 알림(정보성)에는 취침 모드가 적용되지 않음을 보장받는다. (어차피 무음이라 영향 없음)
- 사용자는 이어폰이 trip 중간에 분리되면 그 시점 이후 알람이 스피커로 새지 않음을 보장받는다.
- 사용자는 취침 모드 해제 시 다음 알람부터 즉시 일반 출력으로 복귀됨을 보장받는다.
- 사용자는 블루투스 이어폰 연결 상태도 유선 이어폰과 동일하게 인정받는다.

---

## 횡단 의존

- **알람**: 알람의 출력 채널 정책을 덮어쓴다.
- **오디오 라우팅**: `modules/audio-route/` 네이티브 모듈 연계.

## 코드 진입점

- 취침 모드 store: `src/features/settings/store/useSettingsStore.ts:19-52` `sleepMode` boolean
- 토글 UI: `src/screens/SettingsScreen.tsx:106-118`
- 이어폰 감지 (iOS, 유선+BT A2DP/HFP/LE): `modules/audio-route/ios/AudioRouteModule.swift:8-16`
- 출력 채널 분기 (allowSpeaker): `src/features/alarm/utils/stationNotification.ts:520-540`
- 환승 첫 hop suppress 규칙: `src/features/alarm/utils/shouldSuppressBySleepRule.ts:44-49`
- TTS 게이트: `src/features/alarm/utils/tts.ts:22-32`
- Sleep mode ref capture: `src/features/alarm/hooks/useSleepModeRef.ts:6`

## 알려진 한계

- ⚠️ 자동 이어폰 분리 감지 → 출력 채널 실시간 변경 **미구현**. 우회로로 `allowSpeaker` 명시적 토글을 사용자가 직접 조작하는 구조.
- ⚠️ Android 오디오 라우팅 미구현 (iOS only).
