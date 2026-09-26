# 05. 실시간 진행

## 책임
탑승 확정 이후 trip이 진행되는 동안 매 역마다 사용자의 현재 위치·다음 역·잔여 정거장·예상 도착 시간을 갱신한다.

## 경계
- 정보 갱신 트리거는 이 도메인. 알람 발사는 [06-alarm.md](./06-alarm.md).
- 잠금화면/Live Activity 표시는 [09-lockscreen.md](./09-lockscreen.md).

---

## 기본 동작

- 사용자는 trip 진행 중 **매 역마다** 현재 역·다음 역·잔여 정거장 수가 갱신됨을 보장받는다.
- 사용자는 매 역 통과 시 도착 예상 시간(ETA)이 갱신될 수 있다.
- 사용자는 환승역 도착 시 다음 leg의 첫 역·소요 시간을 받을 수 있다.
- 사용자는 BG/FG 상태와 무관하게 동일한 진행 정보를 받을 수 있다.
- 사용자는 경로 타임라인에서 **각 환승역의 도어 번호와 시설(계단·엘리베이터) 정보**를 볼 수 있다. (거동불편자 모드 대응)
- 사용자는 도착 직전 알람에서 **열차 내 어느 쪽 문(왼쪽/오른쪽)으로 내려야 환승·하차가 빠른지** 안내받을 수 있다. ⚠️ 코드·i18n은 준비됐으나 `src/data/exitSide.json`이 빈 객체(`{}`)라 미작동. 528개 역 × 노선별 × 방향별 좌/우 문 매핑 데이터 수집 필요(개발 0, 데이터 작업).

## 예외 / 경계 조건

- 사용자는 GPS·위치 신호가 일시 끊겨도 **마지막 갱신값을 유지**받는다. (stale 표시 동반)
- 사용자는 인터넷이 끊긴 상태에서는 마지막 시간표/도착 정보 캐시로 진행이 계속됨을 보장받는다.
- 사용자는 열차가 정차 중일 때 잔여 정거장 수가 깜빡이지 않고 안정되게 표시됨을 보장받는다.
- 사용자는 trip 종료(하차) 후에는 진행 정보 갱신이 즉시 중단됨을 보장받는다.

---

## 횡단 의존

- **현재 역 인식**: 현재 역 결정에 의존. → [02-current-station.md](./02-current-station.md)
- **에너지**: 신호 폴링 주기는 에너지 정책 따름. → [11-background.md](./11-background.md)

## 코드 진입점

- arrival 정보 + 폴링 (5s): `src/features/arrival/hooks/useArrivalInfo.ts:9`
- 진행 상태 추정 (4단 전략): `src/features/route/utils/stationProgressEstimator.ts:16-249` — LivePosition → ArrivalEta → ReanchoredHop → DefaultHop
- ETA 계산 (3단): `src/shared/utils/stationRoute.ts:865-993`
- 환승 leg 전환: `stationRoute.ts:245-348` `updateRouteFromPosition()`
- 환승역별 실측 대기 시간: `stationRoute.ts:636-643` `getTransferSeconds()`
- 도보 속도 상수: `src/shared/constants/eta.ts:3` `WALKING_SPEED_M_PER_S = 1.2`
- 도보 분 계산: `src/shared/utils/stationRoute.ts:796-804` `calculateWalkingMinutes()`
- Sticky Station (깜빡임 방지): `src/features/nearest-station/hooks/useStickyStation.ts`
- 도어 번호 + 시설(quickExit): `src/features/route/utils/quickExit.ts:42-63` `resolveQuickExit()`, 데이터 `src/data/quickExit.json` (254KB)
- 환승역 특화 도어(transferExit): `src/data/transferExit.json`
- 좌/우 문(exitSide): `src/features/route/utils/exitSide.ts:14-21`, 데이터 `src/data/exitSide.json` (현재 비어있음)
- 도어 UI: `src/features/arrival/components/EditorialTimeline.tsx:38-69`

## 알려진 한계

- ✅ Sticky Station 깜빡임 방지 구현됨 — UI 통합 상태 일부 진행 중.
- ✅ ADR-008 StationProgressEstimator Stage 3 완료 (#779 실측 운행 시간 통합).
- ⚠️ #622 transfer leg backend 동기화 회귀 추적 중.
- ⚠️ **좌/우 문 안내(`exitSide.json`) 데이터 미수집** — 알람 본문 i18n 키(`alarms.exitSideLeft/Right/Both`)는 준비됐으나 데이터 비어 미작동. 도어 번호(quickExit)는 정상 작동 중.
- ⚠️ **exitSide 데이터 출처 미정** — 서울 공공데이터 광장에 해당 API가 있는지 미확인. 서울교통공사 공식 배포 여부 미확인. 후보(공공API / 차량 도면 / 상용 앱 사례 / 크라우드소싱) 모두 별도 조사 필요. 현재는 데이터 수집 자체를 보류.
