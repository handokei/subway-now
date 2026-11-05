/**
 * #3191 PR-F - 정지 fix 직후 도달 불가 이웃역 실측 fixture (2026-10-30~11-03 덤프).
 *
 * 불변: 아래 rows는 전부 디버그 덤프 원문 줄 그대로다(Raw Signal, 최신 -> 과거). 테스트를 통과시키려고 조정하지 않는다.
 * 출처(plan tasks/plan-2026-11-03-3191-stale-anchor.md v6 §1, §5.1) - 덤프 줄 번호는 `~/Downloads/텍스트-<ID>-1.txt` 기준:
 *  - AB2FB85C916A (2026-11-02 21:19 KST dump): R11 L625-637, R10 L652-658
 *  - B8D812F06A34 (2026-10-30 20:32 KST dump): W L754-766, L797 계열 L800-802
 *  - 1321808001AF (2026-11-03 20:08 KST dump): R0 L586-591, R12 L625-640
 *  - 3DCCD7F760F6 (2026-10-31 22:23 KST dump): R7-R9 L639-659
 * 파서는 replay_20261021_sagajeong_hold.ts `parseRawRow`를 재사용한다.
 */

export interface UnreachableDumpFixture {
  /** 덤프 파일 ID와 원 덤프 줄 범위 (출처 추적용). */
  source: string;
  /** 행 `HH:MM:SS`를 epoch로 바꿀 KST 날짜. */
  kstDate: string;
  /** Raw Signal 원문 줄 (덤프 순서 그대로: 최신 -> 과거). */
  rows: readonly string[];
}

/** R11 - 뚝섬->성수 (trip 활성, LA 28초). L627=lock 2-010 생성 행 */
export const R11_NOV02: UnreachableDumpFixture = {
  source: 'AB2FB85C916A L625-637',
  kstDate: '2026-11-02',
  rows: [
    '19:45:06 | cycle | 2-010 | boarding-lock/boarding-lock | gps(19m/2.2m/s) | automotive | sub=false | arvlCd=4 | arc=9.70 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.2 | fix=19:45:05 | watch=active | app=inactive | baroEvt=- | hold=0 | holdBlk=lock | distM=10 | pos=37.54718,127.04750',
    '19:45:05 | cycle | 2-010 | gps/gps-only | gps(21m/0.0m/s) | walking | sub=false | arvlCd=4 | arc=9.34 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.2 | fix=19:45:04 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=lock | distM=10 | pos=37.54719,127.04749',
    '19:45:02 | cycle | 2-010 | boarding-lock/boarding-lock | gps(22m/-) | walking | sub=false | arvlCd=4 | arc=9.57 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.2 | fix=19:45:02 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=lock | distM=10 | pos=37.54718,127.04748',
    '19:45:02 | cycle | 2-010 | position/arrival-arriving | gps(22m/-) | walking | sub=false | arvlCd=4 | arc=9.57 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.2 | fix=19:45:02 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=lock | distM=10 | pos=37.54718,127.04748',
    '19:45:02 | cycle | 2-010 | route-progress/route-progress | gps(22m/-) | walking | sub=false | arvlCd=4 | arc=9.57 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.2 | fix=19:45:02 | watch=inactive | app=active | baroEvt=- | hold=0 | holdBlk=lock | distM=10 | pos=37.54718,127.04748',
    '19:45:02 | cycle | 2-010 | route-progress/route-progress | gps(22m/-) | walking | sub=false | arvlCd=3 | arc=16.04 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.2 | fix=19:45:02 | watch=inactive | app=active | baroEvt=- | hold=0 | holdBlk=near-station | distM=10 | pos=37.54718,127.04748',
    '19:45:02 | enter | 2-010 | route-progress/route-progress | gps(22m/-) | walking | sub=false | arvlCd=3 | arc=16.04 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.2 | fix=19:45:02 | watch=inactive | app=active | baroEvt=- | hold=0 | holdBlk=near-station | distM=10 | pos=37.54718,127.04748',
    '19:45:02 | exit | 2-011 | -/- | gps(22m/-) | walking | sub=false | arvlCd=3 | arc=16.04 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.2 | fix=19:45:02 | watch=inactive | app=active | baroEvt=- | hold=0 | holdBlk=near-station | distM=10 | pos=37.54718,127.04748',
    '19:44:34 | cycle | 2-011 | position/arrival-confirmed | gps(19m/0.0m/s) | automotive | sub=false | arvlCd=99 | arc=16.04 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.2 | fix=19:44:18 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=19 | pos=37.54721,127.04758',
    '19:44:34 | enter | 2-011 | position/arrival-confirmed | gps(19m/0.0m/s) | automotive | sub=false | arvlCd=99 | arc=16.04 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.2 | fix=19:44:18 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=19 | pos=37.54721,127.04758',
    '19:44:34 | exit | 2-010 | -/- | gps(19m/0.0m/s) | automotive | sub=false | arvlCd=99 | arc=16.04 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.2 | fix=19:44:18 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=19 | pos=37.54721,127.04758',
    '19:44:15 | cycle | 2-010 | route-progress/route-progress | gps(9m/2.0m/s) | unknown | sub=false | arvlCd=3 | arc=16.61 | cell=LTE/surface-weak | hpa=1019.2 | fix=19:44:14 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=15 | pos=37.54716,127.04756',
    '19:44:15 | cycle | 2-010 | gps/gps-only | gps(9m/2.0m/s) | unknown | sub=false | arvlCd=3 | arc=- | cell=LTE/surface-weak | hpa=1019.2 | fix=19:44:14 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=15 | pos=37.54716,127.04756 | launch=cold@19:44:13 hpa0=1019.2@19:44:15',
  ],
};

/** R10 - 사가정 (trip 없음 BG; 신선 fix 복귀 행 포함) */
export const R10_NOV02: UnreachableDumpFixture = {
  source: 'AB2FB85C916A L652-658',
  kstDate: '2026-11-02',
  rows: [
    '06:27:38 | cycle | 7-015 | position/arrival-arriving | gps(15m/-) | automotive | sub=false | arvlCd=3 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1013.5 | fix=06:27:38 | watch=active | app=active | baroEvt=06:27:37 | hold=0 | holdBlk=near-station | distM=77 | pos=37.57433,127.08687',
    '06:27:38 | cycle | 7-015 | gps/gps-only | gps(19m/-) | automotive | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1013.5 | fix=06:27:38 | watch=inactive | app=active | baroEvt=06:27:37 | hold=0 | holdBlk=near-station | distM=77 | pos=37.57433,127.08686',
    '06:27:38 | enter | 7-015 | gps/gps-only | gps(19m/-) | automotive | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1013.5 | fix=06:27:38 | watch=inactive | app=active | baroEvt=06:27:37 | hold=0 | holdBlk=near-station | distM=77 | pos=37.57433,127.08686',
    '06:27:38 | exit | 7-014 | -/- | gps(19m/-) | automotive | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1013.5 | fix=06:27:38 | watch=inactive | app=active | baroEvt=06:27:37 | hold=0 | holdBlk=near-station | distM=77 | pos=37.57433,127.08686',
    '06:27:22 | cycle | 7-014 | arrival/arrival-arriving | gps(23m/1.5m/s) | unknown | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1013.4 | fix=06:25:33 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=speed | distM=244 | pos=37.57584,127.08687',
    '06:27:22 | enter | 7-014 | arrival/arrival-arriving | gps(23m/1.5m/s) | unknown | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1013.4 | fix=06:25:33 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=speed | distM=244 | pos=37.57584,127.08687',
    '06:27:22 | exit | 7-015 | -/- | gps(23m/1.5m/s) | unknown | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1013.4 | fix=06:25:33 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=speed | distM=244 | pos=37.57584,127.08687 | launch=cold@06:25:25 hpa0=1013.3@06:25:26',
  ],
};

/** W - 건대입구->어린이대공원 (구 빌드 행, trip 활성) */
export const W_OCT30: UnreachableDumpFixture = {
  source: 'B8D812F06A34 L754-766',
  kstDate: '2026-10-30',
  rows: [
    '17:25:08 | cycle | 7-019 | boarding-lock/boarding-lock | gps(52m/-) | automotive | sub=false | arvlCd=3 | arc=1434.82 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.0 | fix=17:25:08 | watch=inactive | app=background | baroEvt=17:19:46 | hold=0 | holdBlk=- | distM=- | pos=37.54083,127.07126',
    '17:24:57 | cycle | 7-019 | gps/gps-only | gps(24m/-) | automotive | sub=false | arvlCd=3 | arc=1434.82 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.0 | fix=17:24:46 | watch=active | app=background | baroEvt=17:19:46 | hold=0 | holdBlk=- | distM=- | pos=37.54080,127.07131',
    '17:24:47 | cycle | 7-019 | route-progress/route-progress | gps(24m/-) | walking | sub=false | arvlCd=3 | arc=1434.82 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.0 | fix=17:24:46 | watch=active | app=background | baroEvt=17:19:46 | hold=1 | holdBlk=- | distM=- | pos=37.54080,127.07131',
    '17:24:18 | cycle | 7-019 | route-progress/route-progress | gps(25m/-) | automotive | sub=false | arvlCd=3 | arc=1433.80 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.0 | fix=17:24:05 | watch=active | app=background | baroEvt=17:19:46 | hold=1 | holdBlk=- | distM=- | pos=37.54079,127.07130',
    '17:24:14 | cycle | 7-019 | route-progress/route-progress | gps(25m/-) | automotive | sub=false | arvlCd=3 | arc=1433.80 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.1 | fix=17:24:05 | watch=active | app=background | baroEvt=17:19:46 | hold=1 | holdBlk=- | distM=- | pos=37.54079,127.07130',
    '17:24:10 | cycle | 7-019 | route-progress/route-progress | gps(25m/-) | automotive | sub=false | arvlCd=3 | arc=1431.16 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.1 | fix=17:24:05 | watch=inactive | app=background | baroEvt=17:19:46 | hold=1 | holdBlk=- | distM=- | pos=37.54079,127.07130',
    '17:24:10 | enter | 7-019 | route-progress/route-progress | gps(25m/-) | automotive | sub=false | arvlCd=3 | arc=1431.16 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.1 | fix=17:24:05 | watch=inactive | app=background | baroEvt=17:19:46 | hold=1 | holdBlk=- | distM=- | pos=37.54079,127.07130',
    '17:24:10 | exit | 7-018 | -/- | gps(25m/-) | automotive | sub=false | arvlCd=3 | arc=1431.16 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.1 | fix=17:24:05 | watch=inactive | app=background | baroEvt=17:19:46 | hold=1 | holdBlk=- | distM=- | pos=37.54079,127.07130',
    '17:24:06 | cycle | 7-018 | arrival/arrival-arriving | gps(27m/-) | automotive | sub=false | arvlCd=99 | arc=1431.16 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.1 | fix=17:23:51 | watch=inactive | app=background | baroEvt=17:19:46 | hold=1 | holdBlk=- | distM=- | pos=37.54078,127.07126',
    '17:24:06 | enter | 7-018 | arrival/arrival-arriving | gps(27m/-) | automotive | sub=false | arvlCd=99 | arc=1431.16 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.1 | fix=17:23:51 | watch=inactive | app=background | baroEvt=17:19:46 | hold=1 | holdBlk=- | distM=- | pos=37.54078,127.07126',
    '17:24:06 | exit | 7-019 | -/- | gps(27m/-) | automotive | sub=false | arvlCd=99 | arc=1431.16 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.1 | fix=17:23:51 | watch=inactive | app=background | baroEvt=17:19:46 | hold=1 | holdBlk=- | distM=- | pos=37.54078,127.07126',
    '17:24:01 | cycle | 7-019 | route-progress/route-progress | gps(27m/-) | automotive | sub=false | arvlCd=3 | arc=1431.16 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.1 | fix=17:23:51 | watch=inactive | app=inactive | baroEvt=17:19:46 | hold=1 | holdBlk=- | distM=- | pos=37.54078,127.07126',
    '17:24:00 | cycle | 7-019 | position/arrival-confirmed | gps(27m/-) | automotive | sub=false | arvlCd=3 | arc=1431.16 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.1 | fix=17:23:51 | watch=inactive | app=active | baroEvt=17:19:46 | hold=1 | holdBlk=- | distM=- | pos=37.54078,127.07126',
  ],
};

/** L797 계열 - acc 189 (D 밖) */
export const L797_OCT30: UnreachableDumpFixture = {
  source: 'B8D812F06A34 L800-802',
  kstDate: '2026-10-30',
  rows: [
    '17:13:23 | cycle | 2-011 | position/arrival-arriving | gps(189m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=LTE/surface-weak | hpa=1021.7 | fix=17:13:04 | watch=active | app=active | baroEvt=17:13:22 | hold=0 | holdBlk=- | distM=- | pos=37.54695,127.04801',
    '17:13:22 | cycle | 2-011 | position/arrival-arriving | gps(189m/-) | automotive | sub=false | arvlCd=1 | arc=- | cell=LTE/surface-weak | hpa=1021.7 | fix=17:13:04 | watch=active | app=active | baroEvt=17:13:22 | hold=0 | holdBlk=- | distM=- | pos=37.54695,127.04801',
    '17:13:22 | enter | 2-011 | position/arrival-arriving | gps(189m/-) | automotive | sub=false | arvlCd=1 | arc=- | cell=LTE/surface-weak | hpa=1021.7 | fix=17:13:04 | watch=active | app=active | baroEvt=17:13:22 | hold=0 | holdBlk=- | distM=- | pos=37.54695,127.04801',
  ],
};

/** R0 - 신선 fix 용마산 (대조) */
export const R0_NOV03: UnreachableDumpFixture = {
  source: '1321808001AF L586-591',
  kstDate: '2026-11-03',
  rows: [
    '20:08:35 | cycle | 7-015 | gps/gps-only | gps(15m/2.4m/s) | stationary | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1019.8 | fix=20:08:34 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=222 | pos=37.57560,127.08719',
    '20:08:30 | cycle | 7-015 | gps/gps-only | gps(16m/-) | stationary | sub=false | arvlCd=99 | arc=- | cell=LTE/surface-weak | hpa=1019.8 | fix=20:08:26 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=222 | pos=37.57561,127.08718',
    '20:08:25 | cycle | 7-015 | gps/gps-only | gps(16m/-) | stationary | sub=false | arvlCd=99 | arc=- | cell=LTE/surface-weak | hpa=1019.8 | fix=20:08:20 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=222 | pos=37.57561,127.08718',
    '20:08:22 | cycle | 7-015 | gps/gps-only | gps(16m/-) | unknown | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.8 | fix=20:08:20 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=222 | pos=37.57561,127.08718 | launch=cold@20:08:20 hpa0=1019.8@20:08:21',
    '20:08:20 | cycle | 7-015 | gps/gps-only | gps(16m/-) | unknown | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=- | fix=20:08:20 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=222 | pos=37.57561,127.08718',
    '20:08:20 | cycle | 7-015 | gps/gps-only | gps(16m/-) | unknown | sub=false | arvlCd=- | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=- | fix=20:08:20 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=222 | pos=37.57561,127.08718',
  ],
};

/** R12 - 실제 탑승 이동(속도 0.6), 성수 표시가 정답 */
export const R12_NOV03: UnreachableDumpFixture = {
  source: '1321808001AF L625-640',
  kstDate: '2026-11-03',
  rows: [
    '18:56:11 | cycle | 7-019 | gps/gps-only | gps(31m/-) | automotive | sub=false | arvlCd=- | arc=29.30 | cell=LTE/surface-weak | hpa=1024.9 | fix=18:56:11 | watch=inactive | app=active | baroEvt=18:54:31 | hold=0 | holdBlk=accuracy | distM=42 | pos=37.54092,127.07146',
    '18:56:11 | cycle | 7-019 | gps/gps-only | gps(31m/-) | automotive | sub=false | arvlCd=3 | arc=29.29 | cell=LTE/surface-weak | hpa=1024.9 | fix=18:56:11 | watch=inactive | app=active | baroEvt=18:54:31 | hold=0 | holdBlk=accuracy | distM=42 | pos=37.54092,127.07146',
    '18:56:11 | enter | 7-019 | gps/gps-only | gps(31m/-) | automotive | sub=false | arvlCd=3 | arc=29.29 | cell=LTE/surface-weak | hpa=1024.9 | fix=18:56:11 | watch=inactive | app=active | baroEvt=18:54:31 | hold=0 | holdBlk=accuracy | distM=42 | pos=37.54092,127.07146',
    '18:56:11 | exit | 2-011 | -/- | gps(31m/-) | automotive | sub=false | arvlCd=3 | arc=29.29 | cell=LTE/surface-weak | hpa=1024.9 | fix=18:56:11 | watch=inactive | app=active | baroEvt=18:54:31 | hold=0 | holdBlk=accuracy | distM=42 | pos=37.54092,127.07146',
    '18:55:40 | cycle | 2-011 | position/arrival-arriving | gps(24m/0.6m/s) | automotive | sub=false | arvlCd=99 | arc=29.29 | cell=LTE/surface-weak | hpa=1024.9 | fix=18:46:41 | watch=inactive | app=background | baroEvt=18:54:31 | hold=0 | holdBlk=speed | distM=29 | pos=37.54705,127.04766',
    '18:55:32 | cycle | 2-011 | position/arrival-arriving | gps(24m/0.6m/s) | automotive | sub=false | arvlCd=99 | arc=29.29 | cell=LTE/surface-weak | hpa=1024.9 | fix=18:46:41 | watch=inactive | app=background | baroEvt=18:54:31 | hold=0 | holdBlk=speed | distM=29 | pos=37.54705,127.04766',
    '18:55:11 | cycle | 2-011 | position/arrival-arriving | gps(24m/0.6m/s) | automotive | sub=false | arvlCd=99 | arc=29.29 | cell=LTE/surface-weak | hpa=1024.8 | fix=18:46:41 | watch=inactive | app=background | baroEvt=18:54:31 | hold=0 | holdBlk=speed | distM=29 | pos=37.54705,127.04766',
    '18:54:21 | cycle | 2-011 | position/arrival-arriving | gps(24m/0.6m/s) | automotive | sub=false | arvlCd=99 | arc=29.29 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.8 | fix=18:46:41 | watch=inactive | app=background | baroEvt=18:54:20 | hold=0 | holdBlk=speed | distM=29 | pos=37.54705,127.04766',
    '18:50:49 | cycle | 2-011 | position/arrival-arriving | gps(24m/0.6m/s) | unknown | sub=false | arvlCd=99 | arc=29.29 | cell=NRNSA/surface-weak-nrnsa | hpa=1022.3 | fix=18:46:41 | watch=inactive | app=background | baroEvt=18:50:49 | hold=0 | holdBlk=speed | distM=29 | pos=37.54705,127.04766',
    '18:47:14 | cycle | 2-011 | position/arrival-arriving | gps(24m/0.6m/s) | automotive | sub=false | arvlCd=99 | arc=29.29 | cell=NRNSA/surface-weak-nrnsa | hpa=1021.8 | fix=18:46:41 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=speed | distM=29 | pos=37.54705,127.04766',
    '18:47:05 | cycle | 2-011 | position/arrival-arriving | gps(24m/0.6m/s) | automotive | sub=false | arvlCd=99 | arc=29.29 | cell=NRNSA/surface-weak-nrnsa | hpa=1021.8 | fix=18:46:41 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=speed | distM=29 | pos=37.54705,127.04766',
    '18:46:56 | cycle | 2-011 | position/arrival-arriving | gps(24m/0.6m/s) | automotive | sub=false | arvlCd=99 | arc=29.29 | cell=NRNSA/surface-weak-nrnsa | hpa=1021.8 | fix=18:46:41 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=29 | pos=37.54705,127.04766',
    '18:46:56 | enter | 2-011 | position/arrival-arriving | gps(24m/0.6m/s) | automotive | sub=false | arvlCd=99 | arc=29.29 | cell=NRNSA/surface-weak-nrnsa | hpa=1021.8 | fix=18:46:41 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=29 | pos=37.54705,127.04766',
    '18:46:56 | exit | 2-010 | -/- | gps(24m/0.6m/s) | automotive | sub=false | arvlCd=99 | arc=29.29 | cell=NRNSA/surface-weak-nrnsa | hpa=1021.8 | fix=18:46:41 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=29 | pos=37.54705,127.04766',
    '18:46:32 | cycle | 2-010 | route-progress/route-progress | gps(22m/-) | unknown | sub=false | arvlCd=3 | arc=27.32 | cell=NRNSA/surface-weak-nrnsa | hpa=1022.0 | fix=18:46:32 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=29 | pos=37.54710,127.04766',
    '18:46:32 | cycle | 2-010 | gps/gps-only | gps(22m/-) | unknown | sub=false | arvlCd=3 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1022.0 | fix=18:46:32 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=29 | pos=37.54710,127.04766 | launch=cold@18:46:31 hpa0=1022.0@18:46:32',
  ],
};

/** R7-R9 - 집 사가정 (trip 없음 BG, 노출 없음) */
export const R789_OCT30: UnreachableDumpFixture = {
  source: '3DCCD7F760F6 L639-659',
  kstDate: '2026-10-30',
  rows: [
    '20:55:30 | cycle | 7-015 | gps/gps-only | gps(19m/-) | unknown | sub=false | arvlCd=5 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:55:30 | watch=active | app=background | baroEvt=20:43:45 | hold=1 | holdBlk=- | distM=221 | pos=37.57562,127.08719',
    '20:55:30 | enter | 7-015 | gps/gps-only | gps(19m/-) | unknown | sub=false | arvlCd=5 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:55:30 | watch=active | app=background | baroEvt=20:43:45 | hold=1 | holdBlk=- | distM=221 | pos=37.57562,127.08719',
    '20:55:30 | exit | 7-014 | -/- | gps(19m/-) | unknown | sub=false | arvlCd=5 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:55:30 | watch=active | app=background | baroEvt=20:43:45 | hold=1 | holdBlk=- | distM=221 | pos=37.57562,127.08719',
    '20:55:30 | cycle | 7-014 | arrival/arrival-confirmed | gps(30m/0.0m/s) | unknown | sub=false | arvlCd=1 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:43:45 | watch=inactive | app=background | baroEvt=20:43:45 | hold=0 | holdBlk=baro-unavailable | distM=221 | pos=37.57562,127.08706',
    '20:55:30 | enter | 7-014 | arrival/arrival-confirmed | gps(30m/0.0m/s) | unknown | sub=false | arvlCd=1 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:43:45 | watch=inactive | app=background | baroEvt=20:43:45 | hold=0 | holdBlk=baro-unavailable | distM=221 | pos=37.57562,127.08706',
    '20:55:30 | exit | 7-015 | -/- | gps(30m/0.0m/s) | unknown | sub=false | arvlCd=1 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:43:45 | watch=inactive | app=background | baroEvt=20:43:45 | hold=0 | holdBlk=baro-unavailable | distM=221 | pos=37.57562,127.08706',
    '20:43:43 | cycle | 7-015 | gps/gps-only | gps(16m/-) | stationary | sub=false | arvlCd=5 | arc=- | cell=-/unknown | hpa=1010.7 | fix=20:43:43 | watch=inactive | app=active | baroEvt=20:43:42 | hold=0 | holdBlk=baro-event | distM=221 | pos=37.57562,127.08719',
    '20:43:43 | enter | 7-015 | gps/gps-only | gps(16m/-) | stationary | sub=false | arvlCd=5 | arc=- | cell=-/unknown | hpa=1010.7 | fix=20:43:43 | watch=inactive | app=active | baroEvt=20:43:42 | hold=0 | holdBlk=baro-event | distM=221 | pos=37.57562,127.08719',
    '20:43:43 | exit | 7-014 | -/- | gps(16m/-) | stationary | sub=false | arvlCd=5 | arc=- | cell=-/unknown | hpa=1010.7 | fix=20:43:43 | watch=inactive | app=active | baroEvt=20:43:42 | hold=0 | holdBlk=baro-event | distM=221 | pos=37.57562,127.08719',
    '20:43:42 | cycle | 7-014 | arrival/arrival-confirmed | gps(6m/0.0m/s) | stationary | sub=false | arvlCd=1 | arc=- | cell=-/unknown | hpa=1010.7 | fix=20:41:17 | watch=inactive | app=background | baroEvt=20:43:42 | hold=0 | holdBlk=baro-event | distM=221 | pos=37.57560,127.08718',
    '20:43:42 | enter | 7-014 | arrival/arrival-confirmed | gps(6m/0.0m/s) | stationary | sub=false | arvlCd=1 | arc=- | cell=-/unknown | hpa=1010.7 | fix=20:41:17 | watch=inactive | app=background | baroEvt=20:43:42 | hold=0 | holdBlk=baro-event | distM=221 | pos=37.57560,127.08718',
    '20:43:42 | exit | 7-015 | -/- | gps(6m/0.0m/s) | stationary | sub=false | arvlCd=1 | arc=- | cell=-/unknown | hpa=1010.7 | fix=20:41:17 | watch=inactive | app=background | baroEvt=20:43:42 | hold=0 | holdBlk=baro-event | distM=221 | pos=37.57560,127.08718',
    '20:43:42 | cycle | 7-015 | gps/gps-only | gps(6m/0.0m/s) | stationary | sub=false | arvlCd=5 | arc=- | cell=-/unknown | hpa=1010.7 | fix=20:41:17 | watch=inactive | app=background | baroEvt=20:43:42 | hold=1 | holdBlk=- | distM=221 | pos=37.57560,127.08718',
    '20:43:41 | cycle | 7-015 | gps/gps-only | gps(6m/0.0m/s) | stationary | sub=false | arvlCd=5 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:41:17 | watch=inactive | app=background | baroEvt=- | hold=1 | holdBlk=- | distM=221 | pos=37.57560,127.08718',
    '20:43:41 | enter | 7-015 | gps/gps-only | gps(6m/0.0m/s) | stationary | sub=false | arvlCd=5 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:41:17 | watch=inactive | app=background | baroEvt=- | hold=1 | holdBlk=- | distM=221 | pos=37.57560,127.08718',
    '20:43:41 | exit | 7-014 | -/- | gps(6m/0.0m/s) | stationary | sub=false | arvlCd=5 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:41:17 | watch=inactive | app=background | baroEvt=- | hold=1 | holdBlk=- | distM=221 | pos=37.57560,127.08718',
    '20:43:41 | cycle | 7-014 | arrival/arrival-confirmed | gps(6m/0.0m/s) | stationary | sub=false | arvlCd=1 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:41:17 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=221 | pos=37.57560,127.08718',
    '20:43:41 | enter | 7-014 | arrival/arrival-confirmed | gps(6m/0.0m/s) | stationary | sub=false | arvlCd=1 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:41:17 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=221 | pos=37.57560,127.08718',
    '20:43:41 | exit | 7-015 | -/- | gps(6m/0.0m/s) | stationary | sub=false | arvlCd=1 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:41:17 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=221 | pos=37.57560,127.08718',
    '20:41:27 | cycle | 7-015 | gps/gps-only | gps(6m/0.0m/s) | stationary | sub=false | arvlCd=5 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:41:17 | watch=inactive | app=background | baroEvt=- | hold=1 | holdBlk=- | distM=221 | pos=37.57560,127.08718',
    '20:41:27 | cycle | 7-015 | gps/gps-only | gps(6m/0.0m/s) | stationary | sub=false | arvlCd=5 | arc=- | cell=-/unknown | hpa=1009.9 | fix=20:41:17 | watch=inactive | app=background | baroEvt=- | hold=1 | holdBlk=- | distM=221 | pos=37.57560,127.08718',
  ],
};
