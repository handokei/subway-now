/**
 * #2241 (Epic #1927 G4 Phase 0, ADR-030 §Replay harness backbone P0-2a) — red fixture.
 *
 * 실기기 dump evidence(2026-08-09, F649AAFF9331 세션 15:15:26~16:17:43, 62분 구간)를 그대로
 * 옮긴 raw text — 조작/합성 없음(CLAUDE.md 정직 제약). `## Raw Signal` 섹션만 발췌했고, 이
 * 구간에서 관측된 stationId 9종(3-014/3-015/3-021/5-025/5-034/5-035/6-002/7-015/7-017)은
 * `stations.json` 기준 **전부 canonical `environment: 'underground'`**(불광/녹번/종로3가/
 * 장한평/군자(능동)×2/역촌/용마산) — 지상역은 단 하나도 없다.
 *
 * 그런데 이 구간 내내 `sub=false`(barometer subsurface 미검출)와
 * `cell=NRNSA/surface-weak-nrnsa`(약한 지상 cellular vote)가 지배적이다 — ADR-030 표 증상 1·3
 * ("env surface 94.2% 고착", "subsurface=false 지하 오판")의 근본(`inferEnvironment.ts:87`
 * 우선순위 4 — SSOT 미판정 시 raw `subsurface===false`를 그대로 surface로 신뢰)을 그대로
 * 재현한다.
 *
 * 동시에 이 구간은 같은 cycle 안에서 station이 500m를 크게 초과해 바뀌는 실제 점프도 여러 건
 * 포함한다(예: L83~92 부근 3-021↔5-034↔5-025, 15:44:02~03 사이 6.5km대 왕복) — 증상 5("지하
 * stale GPS over-accept → 유령 점프")의 관측 가능한 부분(replay 불변식 2, off-route jump)이다.
 *
 * 재현 불가 잔여(정직 명시): 증상 5의 "stale GPS fix 재사용"(불변식 3) 자체는 이 실기기 dump로
 * 검증 불가 — GPS 수신 타임스탬프(`fix=`)가 #2241 P0-1 이전 dump에는 없었다(계측 부재). P0-1
 * 배포 후 수집되는 다음 실기기 dump가 이 fixture를 승격시킬 것 — `replay_20260809_g4_stale_gps.ts`
 * (합성 mechanism-demo)가 그 전까지 mechanism만 검증한다.
 */

export const RED_FIXTURE_G4_ENV_LOCK_DUMP_TEXT = `## Raw Signal (208)
16:17:43 | cycle | 6-002 | gps/gps-only | gps(22m/6.5m/s) | walking | sub=false | arvlCd=99 | arc=- | cell=LTE/surface-weak
16:17:41 | cycle | 6-002 | gps/gps-only | gps(22m/5.7m/s) | walking | sub=— | arvlCd=99 | arc=- | cell=LTE/surface-weak
16:17:30 | cycle | 6-002 | gps/gps-only | gps(23m/3.2m/s) | - | sub=— | arvlCd=99 | arc=- | cell=LTE/surface-weak
16:17:30 | cycle | 6-002 | gps/gps-only | gps(23m/3.2m/s) | - | sub=— | arvlCd=- | arc=- | cell=LTE/surface-weak
16:17:30 | cycle | - | gps/gps-only | gps(-/-) | - | sub=— | arvlCd=- | arc=- | cell=LTE/unknown
16:17:28 | cycle | 6-002 | gps/gps-only | gps(23m/2.4m/s) | unknown | sub=false | arvlCd=99 | arc=- | cell=LTE/surface-weak
16:17:23 | cycle | 6-002 | gps/gps-only | gps(105m/-) | unknown | sub=false | arvlCd=99 | arc=- | cell=LTE/surface-weak
16:17:23 | cycle | 6-002 | gps/gps-only | gps(105m/-) | unknown | sub=false | arvlCd=99 | arc=- | cell=LTE/surface-weak
16:17:23 | cycle | 6-002 | gps/gps-only | gps(105m/-) | unknown | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak
16:17:23 | cycle | - | gps/gps-only | gps(-/-) | unknown | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak
16:17:23 | cycle | - | gps/gps-only | gps(-/-) | - | sub=false | arvlCd=- | arc=- | cell=LTE/unknown
16:17:22 | cycle | 3-014 | position/arrival-confirmed | gps(28m/-) | unknown | sub=false | arvlCd=1 | arc=- | cell=LTE/surface-weak
16:03:48 | cycle | 3-014 | position/arrival-confirmed | gps(28m/-) | automotive | sub=false | arvlCd=1 | arc=- | cell=LTE/surface-weak
16:03:19 | cycle | 3-014 | position/arrival-confirmed | gps(28m/-) | unknown | sub=false | arvlCd=1 | arc=- | cell=NRNSA/surface-weak-nrnsa
16:03:17 | cycle | 3-014 | gps/gps-only | gps(28m/-) | unknown | sub=false | arvlCd=1 | arc=- | cell=NRNSA/surface-weak-nrnsa
16:03:17 | cycle | 3-014 | position/arrival-confirmed | gps(28m/-) | unknown | sub=false | arvlCd=1 | arc=- | cell=NRNSA/surface-weak-nrnsa
16:03:14 | cycle | 3-014 | gps/gps-only | gps(28m/-) | unknown | sub=false | arvlCd=1 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa
16:03:14 | cycle | 3-014 | gps/gps-only | gps(28m/-) | unknown | sub=false | arvlCd=- | arc=- | cell=NRNSA/surface-weak-nrnsa
16:03:14 | cycle | - | gps/gps-only | gps(-/-) | unknown | sub=false | arvlCd=- | arc=- | cell=NRNSA/surface-weak-nrnsa
16:03:14 | cycle | - | gps/gps-only | gps(-/-) | - | sub=false | arvlCd=- | arc=- | cell=NRNSA/unknown
16:02:29 | cycle | 3-014 | boarding-lock/boarding-lock | gps(97m/-) | walking | sub=false | arvlCd=1 | arc=- | cell=-/unknown
16:02:29 | cycle | 3-014 | position-train/position-train | gps(97m/-) | walking | sub=false | arvlCd=1 | arc=- | cell=-/unknown
16:02:29 | cycle | 3-014 | position/arrival-confirmed | gps(97m/-) | walking | sub=false | arvlCd=1 | arc=- | cell=-/unknown
16:02:29 | cycle | 3-014 | position/arrival-arriving | gps(97m/-) | walking | sub=false | arvlCd=99 | arc=- | cell=-/unknown
16:02:29 | enter | 3-014 | position/arrival-arriving | gps(97m/-) | walking | sub=false | arvlCd=99 | arc=- | cell=-/unknown
16:02:29 | exit | 3-015 | -/- | gps(97m/-) | walking | sub=false | arvlCd=99 | arc=- | cell=-/unknown
16:02:21 | cycle | 3-015 | arrival/arrival-arriving | gps(30m/-) | walking | sub=true | arvlCd=99 | arc=- | cell=-/unknown
16:02:21 | cycle | 3-015 | gps/gps-only-underground | gps(30m/-) | walking | sub=true | arvlCd=- | arc=- | cell=-/unknown
16:02:21 | cycle | 3-015 | arrival/arrival-arriving | gps(30m/-) | walking | sub=true | arvlCd=5 | arc=- | cell=-/unknown
16:02:11 | cycle | - | gps/gps-only-underground | gps(70m/-) | walking | sub=true | arvlCd=- | arc=- | cell=-/unknown
16:01:44 | cycle | - | gps/gps-only-underground | gps(70m/-) | walking | sub=true | arvlCd=- | arc=- | cell=-/unknown
16:01:09 | cycle | - | gps/gps-only | gps(70m/-) | walking | sub=false | arvlCd=- | arc=- | cell=-/unknown
16:00:52 | cycle | - | gps/gps-only | gps(70m/-) | walking | sub=false | arvlCd=- | arc=- | cell=-/unknown
16:00:47 | cycle | - | gps/gps-only | gps(70m/-) | walking | sub=false | arvlCd=- | arc=- | cell=-/unknown
16:00:42 | cycle | - | gps/gps-only | gps(70m/-) | walking | sub=false | arvlCd=- | arc=- | cell=-/unknown
16:00:32 | cycle | - | gps/gps-only | gps(70m/-) | walking | sub=false | arvlCd=- | arc=- | cell=-/unknown
15:59:58 | cycle | - | gps/gps-only-underground | gps(70m/-) | unknown | sub=true | arvlCd=- | arc=- | cell=-/unknown
15:59:13 | cycle | - | gps/gps-only | gps(70m/-) | unknown | sub=false | arvlCd=- | arc=- | cell=-/unknown
15:58:38 | cycle | - | gps/gps-only-underground | gps(70m/-) | unknown | sub=true | arvlCd=- | arc=- | cell=-/unknown
15:58:11 | cycle | - | gps/gps-only | gps(70m/-) | unknown | sub=false | arvlCd=- | arc=- | cell=-/unknown
15:58:03 | cycle | - | gps/gps-only | gps(70m/-) | unknown | sub=false | arvlCd=- | arc=- | cell=-/unknown
15:57:43 | cycle | - | gps/gps-only | gps(70m/-) | unknown | sub=false | arvlCd=- | arc=- | cell=-/unknown
15:57:30 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=true | arvlCd=1 | arc=- | cell=-/surface-weak-nrnsa
15:57:29 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=true | arvlCd=1 | arc=- | cell=NRNSA/surface-weak-nrnsa
15:56:57 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | - | sub=— | arvlCd=1 | arc=- | cell=NRNSA/surface-weak-nrnsa
15:56:56 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | unknown | sub=false | arvlCd=1 | arc=- | cell=NRNSA/surface-weak-nrnsa
15:56:56 | cycle | 3-021 | arrival/arrival-arriving | gps(70m/-) | unknown | sub=false | arvlCd=1 | arc=- | cell=NRNSA/surface-weak-nrnsa
15:56:56 | cycle | 3-021 | arrival/arrival-arriving | gps(70m/-) | - | sub=— | arvlCd=1 | arc=- | cell=NRNSA/surface-weak-nrnsa
15:56:53 | cycle | - | gps/gps-only | gps(-/-) | unknown | sub=false | arvlCd=- | arc=- | cell=NRNSA/surface-weak-nrnsa
15:56:53 | cycle | - | gps/gps-only | gps(-/-) | - | sub=— | arvlCd=- | arc=- | cell=NRNSA/unknown
15:56:53 | cycle | - | gps/gps-only | gps(-/-) | - | sub=false | arvlCd=- | arc=- | cell=NRNSA/unknown
15:56:02 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=0 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:55:56 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=0 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:52:12 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | automotive | sub=false | arvlCd=0 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:52:09 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | automotive | sub=false | arvlCd=0 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:51:45 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | automotive | sub=— | arvlCd=0 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:51:44 | cycle | 3-021 | arrival/arrival-arriving | gps(70m/-) | automotive | sub=— | arvlCd=3 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:51:43 | cycle | - | gps/gps-only | gps(-/-) | - | sub=— | arvlCd=- | arc=- | cell=NRNSA/unknown
15:51:41 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | automotive | sub=false | arvlCd=3 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:51:38 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=3 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:51:34 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=3 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:51:32 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:51:28 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:50:13 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:50:10 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:49:36 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:49:30 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:47:46 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | automotive | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:47:43 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | automotive | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:47:09 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | automotive | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:47:03 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:46:48 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:46:34 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:45:56 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:45:42 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:45:19 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | automotive | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:44:51 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | automotive | sub=false | arvlCd=99 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa
15:44:07 | cycle | 3-021 | arrival/arrival-confirmed | gps(83m/-) | automotive | sub=false | arvlCd=1 | arc=11492.76 | cell=NRNSA/surface-weak-nrnsa
15:44:07 | cycle | 3-021 | arrival/arrival-arriving | gps(83m/-) | automotive | sub=false | arvlCd=1 | arc=11492.76 | cell=NRNSA/surface-weak-nrnsa
15:44:07 | cycle | 3-021 | route-progress/route-progress | gps(31m/-) | automotive | sub=false | arvlCd=- | arc=11492.76 | cell=NRNSA/surface-weak-nrnsa
15:44:03 | cycle | 3-021 | route-progress/route-progress | gps(31m/-) | automotive | sub=false | arvlCd=- | arc=11492.76 | cell=NRNSA/surface-weak-nrnsa
15:44:03 | enter | 3-021 | route-progress/route-progress | gps(31m/-) | automotive | sub=false | arvlCd=- | arc=11492.76 | cell=NRNSA/surface-weak-nrnsa
15:44:03 | exit | 5-034 | -/- | gps(31m/-) | automotive | sub=false | arvlCd=- | arc=11492.76 | cell=NRNSA/surface-weak-nrnsa
15:44:03 | cycle | 5-034 | route-progress/route-progress | gps(31m/-) | automotive | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:44:03 | enter | 5-034 | route-progress/route-progress | gps(31m/-) | automotive | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:44:03 | exit | 3-021 | -/- | gps(31m/-) | automotive | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:44:02 | cycle | 3-021 | position-train/position-train | gps(31m/-) | automotive | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:44:02 | enter | 3-021 | position-train/position-train | gps(31m/-) | automotive | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:44:02 | exit | 5-025 | -/- | gps(31m/-) | automotive | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:44:02 | cycle | 5-025 | position/arrival-confirmed | gps(31m/-) | automotive | sub=false | arvlCd=1 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:44:02 | enter | 5-025 | position/arrival-confirmed | gps(31m/-) | automotive | sub=false | arvlCd=1 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:44:02 | exit | 5-034 | -/- | gps(31m/-) | automotive | sub=false | arvlCd=1 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:43:33 | cycle | 5-034 | gps/gps-only | gps(31m/-) | automotive | sub=false | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:42:59 | cycle | 5-034 | arrival/arrival-arriving | gps(60m/-) | automotive | sub=false | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:42:55 | cycle | 5-034 | arrival/arrival-arriving | gps(60m/-) | automotive | sub=false | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:42:51 | cycle | 5-034 | arrival/arrival-arriving | gps(60m/-) | automotive | sub=false | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:42:48 | cycle | 5-034 | arrival/arrival-arriving | gps(60m/-) | automotive | sub=false | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:41:52 | cycle | 5-034 | arrival/arrival-arriving | gps(60m/-) | automotive | sub=false | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:41:44 | cycle | 5-034 | arrival/arrival-arriving | gps(60m/-) | automotive | sub=false | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:39:32 | cycle | 5-034 | arrival/arrival-arriving | gps(60m/-) | walking | sub=false | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:39:28 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:39:21 | cycle | - | gps/gps-only-underground | gps(60m/-) | walking | sub=true | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:39:16 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:39:08 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:38:45 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:38:41 | cycle | - | gps/gps-only-underground | gps(60m/-) | walking | sub=true | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:38:35 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:38:31 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:37:36 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:37:32 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:36:47 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:36:15 | cycle | - | gps/gps-only-underground | gps(60m/-) | walking | sub=true | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:35:43 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:35:29 | cycle | - | gps/gps-only-underground | gps(60m/-) | walking | sub=true | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:35:20 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:35:15 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:34:58 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:34:14 | cycle | - | gps/gps-only-underground | gps(60m/-) | walking | sub=true | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:33:42 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:33:26 | cycle | - | gps/gps-only-underground | gps(60m/-) | automotive | sub=true | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:33:16 | cycle | - | gps/gps-only | gps(60m/-) | automotive | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:33:11 | cycle | - | gps/gps-only | gps(60m/-) | automotive | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:31:27 | cycle | - | gps/gps-only | gps(60m/-) | automotive | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:31:16 | cycle | - | gps/gps-only-underground | gps(60m/-) | automotive | sub=true | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:30:23 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:30:18 | cycle | - | gps/gps-only-underground | gps(60m/-) | walking | sub=true | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:30:15 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:30:07 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:29:45 | cycle | - | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:29:17 | cycle | - | gps/gps-only-underground | gps(60m/-) | automotive | sub=true | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:29:04 | cycle | - | gps/gps-only | gps(60m/-) | automotive | sub=false | arvlCd=- | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:28:22 | cycle | 5-034 | gps/gps-only | gps(60m/-) | walking | sub=false | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:28:03 | cycle | 5-034 | gps/gps-only-underground | gps(60m/-) | walking | sub=true | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:26:37 | cycle | 5-034 | gps/gps-only | gps(60m/-) | automotive | sub=false | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:26:29 | cycle | 5-034 | gps/gps-only | gps(60m/-) | automotive | sub=false | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:26:07 | cycle | 5-034 | gps/gps-only | gps(60m/-) | automotive | sub=false | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:25:46 | cycle | 5-034 | gps/gps-only-underground | gps(60m/-) | automotive | sub=true | arvlCd=99 | arc=3403.71 | cell=NRNSA/surface-weak-nrnsa
15:25:26 | cycle | 5-034 | gps/gps-only | gps(60m/-) | automotive | sub=false | arvlCd=99 | arc=2034.40 | cell=NRNSA/surface-weak-nrnsa
15:25:26 | enter | 5-034 | gps/gps-only | gps(60m/-) | automotive | sub=false | arvlCd=99 | arc=2034.40 | cell=NRNSA/surface-weak-nrnsa
15:25:26 | exit | 5-035 | -/- | gps(60m/-) | automotive | sub=false | arvlCd=99 | arc=2034.40 | cell=NRNSA/surface-weak-nrnsa
15:25:20 | cycle | 5-035 | gps/gps-only | gps(59m/-) | automotive | sub=false | arvlCd=99 | arc=2034.40 | cell=NRNSA/surface-weak-nrnsa
15:25:17 | cycle | 5-035 | gps/gps-only-underground | gps(59m/-) | automotive | sub=true | arvlCd=99 | arc=2034.40 | cell=NRNSA/surface-weak-nrnsa
15:25:16 | cycle | 5-035 | boarding-lock/boarding-lock | gps(59m/-) | automotive | sub=true | arvlCd=99 | arc=2034.40 | cell=NRNSA/surface-weak-nrnsa
15:24:14 | cycle | 5-035 | boarding-lock/boarding-lock | gps(59m/-) | automotive | sub=false | arvlCd=3 | arc=2033.44 | cell=NRNSA/surface-weak-nrnsa
15:24:08 | cycle | 5-035 | boarding-lock/boarding-lock | gps(59m/-) | automotive | sub=false | arvlCd=3 | arc=2033.44 | cell=NRNSA/surface-weak-nrnsa
15:21:43 | cycle | 5-035 | boarding-lock/boarding-lock | gps(59m/-) | automotive | sub=false | arvlCd=3 | arc=2033.44 | cell=NRNSA/surface-weak-nrnsa
15:21:40 | cycle | 5-035 | boarding-lock/boarding-lock | gps(59m/-) | automotive | sub=false | arvlCd=3 | arc=2033.44 | cell=NRNSA/surface-weak-nrnsa
15:21:34 | cycle | 5-035 | boarding-lock/boarding-lock | gps(59m/-) | automotive | sub=false | arvlCd=3 | arc=2033.44 | cell=NRNSA/surface-weak-nrnsa
15:21:02 | cycle | 5-035 | boarding-lock/boarding-lock | gps(61m/-) | unknown | sub=false | arvlCd=3 | arc=2034.44 | cell=NRNSA/surface-weak-nrnsa
15:21:00 | cycle | 5-035 | arrival/arrival-arriving | gps(61m/-) | unknown | sub=false | arvlCd=3 | arc=2034.44 | cell=NRNSA/surface-weak-nrnsa
15:21:00 | cycle | 5-035 | arrival/arrival-confirmed | gps(61m/-) | unknown | sub=false | arvlCd=5 | arc=2034.44 | cell=NRNSA/surface-weak-nrnsa
15:21:00 | cycle | 5-035 | arrival/arrival-arriving | gps(82m/-) | unknown | sub=false | arvlCd=5 | arc=2034.44 | cell=NRNSA/surface-weak-nrnsa
15:21:00 | cycle | 5-035 | gps/gps-only | gps(82m/-) | unknown | sub=false | arvlCd=- | arc=- | cell=NRNSA/surface-weak-nrnsa
15:21:00 | cycle | - | gps/gps-only | gps(-/-) | unknown | sub=false | arvlCd=- | arc=- | cell=NRNSA/surface-weak-nrnsa
15:21:00 | cycle | - | gps/gps-only | gps(-/-) | - | sub=false | arvlCd=- | arc=- | cell=NRNSA/unknown
15:20:55 | cycle | 5-035 | arrival/arrival-confirmed | gps(36m/-) | walking | sub=false | arvlCd=5 | arc=1957.48 | cell=NRNSA/surface-weak-nrnsa
15:20:54 | cycle | 5-035 | arrival/arrival-confirmed | gps(36m/-) | walking | sub=false | arvlCd=5 | arc=1957.48 | cell=NRNSA/surface-weak-nrnsa
15:20:38 | cycle | 5-035 | position/arrival-confirmed | gps(36m/-) | walking | sub=false | arvlCd=99 | arc=2034.26 | cell=NRNSA/surface-weak-nrnsa
15:20:02 | cycle | 5-035 | position/arrival-confirmed | gps(69m/-) | walking | sub=false | arvlCd=99 | arc=2000.36 | cell=NRNSA/surface-weak-nrnsa
15:19:58 | cycle | 5-035 | position/arrival-confirmed | gps(69m/-) | walking | sub=false | arvlCd=99 | arc=2000.36 | cell=NRNSA/surface-weak-nrnsa
15:19:50 | cycle | 5-035 | position/arrival-confirmed | gps(68m/-) | walking | sub=false | arvlCd=99 | arc=1998.30 | cell=NRNSA/surface-weak-nrnsa
15:19:38 | cycle | 5-035 | position/arrival-confirmed | gps(32m/-) | walking | sub=false | arvlCd=99 | arc=1960.16 | cell=NRNSA/surface-weak-nrnsa
15:19:31 | cycle | 5-035 | position/arrival-confirmed | gps(32m/-) | walking | sub=false | arvlCd=99 | arc=1960.16 | cell=NRNSA/surface-weak-nrnsa
15:19:28 | cycle | 5-035 | position/arrival-confirmed | gps(32m/-) | walking | sub=false | arvlCd=99 | arc=1960.16 | cell=NRNSA/surface-weak-nrnsa
15:19:22 | cycle | 5-035 | position/arrival-confirmed | gps(32m/-) | walking | sub=false | arvlCd=99 | arc=1960.16 | cell=NRNSA/surface-weak-nrnsa
15:19:18 | cycle | 5-035 | position/arrival-confirmed | gps(32m/-) | walking | sub=false | arvlCd=99 | arc=1960.16 | cell=NRNSA/surface-weak-nrnsa
15:19:12 | cycle | 5-035 | position/arrival-confirmed | gps(32m/-) | walking | sub=false | arvlCd=99 | arc=1960.16 | cell=NRNSA/surface-weak-nrnsa
15:19:07 | cycle | 5-035 | position/arrival-confirmed | gps(32m/-) | walking | sub=false | arvlCd=99 | arc=1960.16 | cell=NRNSA/surface-weak-nrnsa
15:18:41 | cycle | 5-035 | position/arrival-confirmed | gps(42m/-) | automotive | sub=false | arvlCd=99 | arc=1960.41 | cell=NRNSA/surface-weak-nrnsa
15:18:31 | cycle | 5-035 | position/arrival-confirmed | gps(55m/-) | automotive | sub=false | arvlCd=99 | arc=1960.41 | cell=NRNSA/surface-weak-nrnsa
15:18:30 | cycle | 5-035 | position/arrival-confirmed | gps(55m/-) | automotive | sub=false | arvlCd=99 | arc=1960.41 | cell=NRNSA/surface-weak-nrnsa
15:18:30 | cycle | 5-035 | position/arrival-arriving | gps(55m/-) | automotive | sub=false | arvlCd=99 | arc=1960.41 | cell=NRNSA/surface-weak-nrnsa
15:18:30 | cycle | 5-035 | arrival/arrival-arriving | gps(55m/-) | automotive | sub=false | arvlCd=99 | arc=1960.41 | cell=NRNSA/surface-weak-nrnsa
15:18:30 | enter | 5-035 | arrival/arrival-arriving | gps(55m/-) | automotive | sub=false | arvlCd=99 | arc=1960.41 | cell=NRNSA/surface-weak-nrnsa
15:18:30 | exit | 7-017 | -/- | gps(55m/-) | automotive | sub=false | arvlCd=99 | arc=1960.41 | cell=NRNSA/surface-weak-nrnsa
15:18:28 | cycle | 7-017 | arrival/arrival-arriving | gps(55m/-) | automotive | sub=false | arvlCd=99 | arc=2000.76 | cell=NRNSA/surface-weak-nrnsa
15:18:28 | enter | 7-017 | arrival/arrival-arriving | gps(55m/-) | automotive | sub=false | arvlCd=99 | arc=2000.76 | cell=NRNSA/surface-weak-nrnsa
15:18:28 | exit | 5-035 | -/- | gps(55m/-) | automotive | sub=false | arvlCd=99 | arc=2000.76 | cell=NRNSA/surface-weak-nrnsa
15:18:23 | cycle | 5-035 | position/arrival-confirmed | gps(59m/-) | automotive | sub=false | arvlCd=99 | arc=1994.68 | cell=NRNSA/surface-weak-nrnsa
15:18:19 | cycle | 5-035 | position/arrival-arriving | gps(59m/-) | automotive | sub=false | arvlCd=99 | arc=1994.68 | cell=NRNSA/surface-weak-nrnsa
15:18:09 | cycle | 5-035 | position/arrival-arriving | gps(31m/-) | automotive | sub=false | arvlCd=99 | arc=1960.93 | cell=NRNSA/surface-weak-nrnsa
15:17:47 | cycle | 5-035 | position/arrival-arriving | gps(46m/-) | automotive | sub=false | arvlCd=99 | arc=1960.93 | cell=NRNSA/surface-weak-nrnsa
15:17:37 | cycle | 5-035 | position/arrival-arriving | gps(37m/-) | automotive | sub=false | arvlCd=99 | arc=1961.05 | cell=NRNSA/surface-weak-nrnsa
15:17:32 | cycle | 5-035 | position/arrival-arriving | gps(31m/-) | automotive | sub=false | arvlCd=99 | arc=1961.06 | cell=NRNSA/surface-weak-nrnsa
15:17:32 | cycle | 5-035 | gps/gps-only | gps(31m/-) | automotive | sub=false | arvlCd=99 | arc=1961.06 | cell=NRNSA/surface-weak-nrnsa
15:17:19 | cycle | 5-035 | arrival/arrival-arriving | gps(33m/-) | automotive | sub=false | arvlCd=99 | arc=1962.17 | cell=NRNSA/surface-weak-nrnsa
15:16:49 | cycle | 5-035 | arrival/arrival-arriving | gps(41m/-) | automotive | sub=false | arvlCd=99 | arc=2025.54 | cell=NRNSA/surface-weak-nrnsa
15:16:49 | cycle | 5-035 | gps/gps-only | gps(41m/-) | automotive | sub=false | arvlCd=- | arc=2025.54 | cell=NRNSA/surface-weak-nrnsa
15:16:49 | cycle | 5-035 | arrival/arrival-arriving | gps(41m/-) | automotive | sub=false | arvlCd=99 | arc=1895.66 | cell=NRNSA/surface-weak-nrnsa
15:16:49 | enter | 5-035 | arrival/arrival-arriving | gps(41m/-) | automotive | sub=false | arvlCd=99 | arc=1895.66 | cell=NRNSA/surface-weak-nrnsa
15:16:49 | exit | 7-015 | -/- | gps(41m/-) | automotive | sub=false | arvlCd=99 | arc=1895.66 | cell=NRNSA/surface-weak-nrnsa
15:16:24 | cycle | 7-015 | position/arrival-confirmed | gps(82m/-) | automotive | sub=false | arvlCd=99 | arc=1895.66 | cell=NRNSA/surface-weak-nrnsa
15:16:24 | cycle | 7-015 | arrival/arrival-confirmed | gps(82m/-) | automotive | sub=false | arvlCd=99 | arc=1895.66 | cell=NRNSA/surface-weak-nrnsa
15:16:24 | cycle | 7-015 | arrival/arrival-arriving | gps(82m/-) | automotive | sub=false | arvlCd=99 | arc=1895.66 | cell=NRNSA/surface-weak-nrnsa
15:16:24 | cycle | - | gps/gps-only | gps(82m/-) | automotive | sub=false | arvlCd=- | arc=1895.66 | cell=NRNSA/surface-weak-nrnsa
15:16:24 | cycle | - | gps/gps-only | gps(82m/-) | automotive | sub=false | arvlCd=- | arc=1895.66 | cell=NRNSA/surface-weak-nrnsa
15:16:24 | cycle | 7-015 | arrival/arrival-arriving | gps(82m/-) | automotive | sub=false | arvlCd=1 | arc=1895.66 | cell=NRNSA/surface-weak-nrnsa
15:16:24 | enter | 7-015 | arrival/arrival-arriving | gps(82m/-) | automotive | sub=false | arvlCd=1 | arc=1895.66 | cell=NRNSA/surface-weak-nrnsa
15:16:24 | exit | 5-035 | -/- | gps(82m/-) | automotive | sub=false | arvlCd=1 | arc=1895.66 | cell=NRNSA/surface-weak-nrnsa
15:16:24 | cycle | 5-035 | arrival/arrival-confirmed | gps(82m/-) | automotive | sub=false | arvlCd=1 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa
15:16:24 | cycle | - | gps/gps-only | gps(249m/-) | automotive | sub=false | arvlCd=- | arc=0.00 | cell=NRNSA/surface-weak-nrnsa
15:15:32 | cycle | 5-035 | gps/gps-only | gps(249m/-) | automotive | sub=false | arvlCd=1 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa
15:15:30 | cycle | 5-035 | boarding-lock/boarding-lock | gps(249m/-) | automotive | sub=false | arvlCd=1 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa
15:15:26 | cycle | 5-035 | gps/gps-only | gps(249m/-) | automotive | sub=false | arvlCd=1 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa
15:15:26 | cycle | 5-035 | gps/gps-only | gps(249m/-) | automotive | sub=false | arvlCd=- | arc=0.00 | cell=NRNSA/surface-weak-nrnsa
15:15:26 | enter | 5-035 | gps/gps-only | gps(249m/-) | automotive | sub=false | arvlCd=- | arc=0.00 | cell=NRNSA/surface-weak-nrnsa
15:15:26 | exit | 7-015 | -/- | gps(249m/-) | automotive | sub=false | arvlCd=- | arc=0.00 | cell=NRNSA/surface-weak-nrnsa
15:15:26 | cycle | 7-015 | gps/gps-only | gps(249m/-) | automotive | sub=false | arvlCd=1 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa
`;
