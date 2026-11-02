/**
 * #3191 PR-1(A) - 2026-10-31 09:37~09:39 용마산->사가정 오전환 실측 fixture (lock 없음, route 있음, primary).
 *
 * 불변: 아래 Raw 행은 디버그 덤프 원문 줄 그대로다. 테스트를 통과시키려고 조정하지 않는다.
 * 출처: ~/Downloads/텍스트-3DCCD7F760F6-1.txt (Raw Signal L611-L627, 최신 -> 과거 순서).
 * 사용자는 용마산(7-015)에 있었고(distM=34, fix 09:37:23~35 acc 86~87m) 사가정(7-014, 상류)으로 두 번 튀었다.
 * 계획: tasks/plan-2026-11-02-3191-stale-gps-distance-gate.md §2.1 행 1-5, §7 Y31.
 */
export const Y31_ROWS: readonly string[] = [
  '09:39:36 | cycle | 7-015 | gps/gps-only | gps(87m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:35 | watch=inactive | app=active | baroEvt=- | hold=0 | holdBlk=accuracy | distM=34 | pos=37.57396,127.08682',
  '09:39:36 | enter | 7-015 | gps/gps-only | gps(87m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:35 | watch=inactive | app=active | baroEvt=- | hold=0 | holdBlk=accuracy | distM=34 | pos=37.57396,127.08682',
  '09:39:36 | exit | 7-014 | -/- | gps(87m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:35 | watch=inactive | app=active | baroEvt=- | hold=0 | holdBlk=accuracy | distM=34 | pos=37.57396,127.08682',
  '09:39:26 | cycle | 7-014 | arrival/arrival-confirmed | gps(87m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.5 | fix=09:37:35 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=accuracy | distM=34 | pos=37.57396,127.08682',
  '09:39:25 | cycle | 7-014 | arrival/arrival-confirmed | gps(87m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:35 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=accuracy | distM=34 | pos=37.57396,127.08682',
  '09:39:25 | cycle | 7-014 | arrival/arrival-arriving | gps(87m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:35 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=accuracy | distM=34 | pos=37.57396,127.08682',
  '09:39:25 | enter | 7-014 | arrival/arrival-arriving | gps(87m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:35 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=accuracy | distM=34 | pos=37.57396,127.08682',
  '09:39:25 | exit | 7-015 | -/- | gps(87m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:35 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=accuracy | distM=34 | pos=37.57396,127.08682',
  '09:39:25 | cycle | 7-015 | arrival/arrival-arriving | gps(87m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:35 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=accuracy | distM=34 | pos=37.57396,127.08682',
  '09:39:25 | enter | 7-015 | arrival/arrival-arriving | gps(87m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:35 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=accuracy | distM=34 | pos=37.57396,127.08682',
  '09:39:25 | exit | 7-014 | -/- | gps(87m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:35 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=accuracy | distM=34 | pos=37.57396,127.08682',
  '09:37:53 | cycle | 7-014 | arrival/arrival-arriving | gps(86m/-) | automotive | sub=false | arvlCd=1 | arc=0.00 | cell=LTE/surface-weak | hpa=1019.3 | fix=09:37:23 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=accuracy | distM=34 | pos=37.57395,127.08680',
  '09:37:38 | cycle | 7-014 | arrival/arrival-arriving | gps(86m/-) | automotive | sub=false | arvlCd=1 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:23 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=34 | pos=37.57395,127.08680',
  '09:37:38 | enter | 7-014 | arrival/arrival-arriving | gps(86m/-) | automotive | sub=false | arvlCd=1 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:23 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=34 | pos=37.57395,127.08680',
  '09:37:38 | exit | 7-015 | -/- | gps(86m/-) | automotive | sub=false | arvlCd=1 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.3 | fix=09:37:23 | watch=inactive | app=background | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=34 | pos=37.57395,127.08680',
  '09:37:31 | cycle | 7-015 | route-progress/route-progress | gps(86m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1019.2 | fix=09:37:23 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=34 | pos=37.57395,127.08680 | launch=cold@09:37:19 hpa0=1019.1@09:37:21',
  '09:37:20 | cycle | 7-015 | gps/gps-only | gps(86m/-) | unknown | sub=false | arvlCd=99 | arc=- | cell=LTE/surface-weak | hpa=- | fix=09:37:18 | watch=active | app=active | baroEvt=- | hold=0 | holdBlk=baro-unavailable | distM=41 | pos=37.57401,127.08680',
];
