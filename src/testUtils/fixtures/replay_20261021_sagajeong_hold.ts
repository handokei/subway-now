/**
 * #3191 PR-2 - 2026-10-18~21 사가정/서울숲 오승리 실측 fixture (정지 fix 유지 hold).
 *
 * 불변: 아래 문자열은 전부 디버그 덤프 원문 줄 그대로다. 테스트를 통과시키려고 조정하지 않는다.
 * 출처(plan tasks/plan-2026-10-22-s1-sagajeong-surface-stale-gate.md §7, tasks/plan-2026-10-28-3191-pr2-final.md §3):
 *  - T: ~/Downloads/텍스트-88B1B2A2036E-1.txt (2026-10-21 21:31 KST dump). 집(용마산 227m), lockless.
 *  - A: ~/Downloads/텍스트-0CB5AF3703FA-1.txt (2026-10-18 23:27 KST dump). 집(용마산 225m), lockless.
 *  - D: ~/Downloads/텍스트-76CC2D4225E7-1.txt (2026-10-19 17:51 KST dump). 뚝섬 사무실(뚝섬 161m), trip 없음.
 *
 * Raw Signal 행에는 좌표가 출력되지 않는다(DebugModal formatter). 좌표/최근접역 거리는 같은 덤프의
 * `## GPS` / `## Nearest` 헤더(덤프 시점 값)에서 가져왔다 - 사용자가 같은 자리에 정지해 있던 행들이다.
 */

export interface SagajeongDumpHeader {
  /** 덤프 `## GPS lat=…, lng=…`. */
  lat: number;
  lng: number;
  /** 덤프 `## Nearest <역> · <m> m`. */
  nearestStationName: string;
  nearestDistanceM: number;
  /** 덤프의 KST 날짜 (YYYY-MM-DD) - Raw 행 `HH:MM:SS`를 epoch로 바꿀 때 쓴다. */
  kstDate: string;
  /** `barometer: … firstCallbackAt=HH:MM:SS`. */
  baroFirstCallbackAt: string;
}

export interface SagajeongDumpFixture {
  header: SagajeongDumpHeader;
  /** Raw Signal 원문 줄 (덤프 순서 그대로: 최신 -> 과거). */
  rows: readonly string[];
}

export const T_21_OCT_HOME: SagajeongDumpFixture = {
  header: {
    lat: 37.57565821434634,
    lng: 127.08719217745576,
    nearestStationName: '용마산',
    nearestDistanceM: 227,
    kstDate: '2026-10-21',
    baroFirstCallbackAt: '21:25:20',
  },
  rows: [
    '21:27:44 | cycle | 7-014 | position/arrival-confirmed | gps(8m/-) | stationary | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1018.3 | fix=21:25:25',
    '21:25:53 | cycle | 7-014 | position/arrival-confirmed | gps(8m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1018.2 | fix=21:25:25',
    '21:25:49 | cycle | 7-014 | position/arrival-confirmed | gps(8m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1018.2 | fix=21:25:25',
    '21:25:41 | cycle | 7-014 | position/arrival-confirmed | gps(8m/-) | automotive | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1018.2 | fix=21:25:25',
    '21:30:30 | cycle | 7-014 | arrival/arrival-arriving | gps(5m/-) | stationary | sub=false | arvlCd=99 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1018.3 | fix=21:30:15',
  ],
};

export const A_18_OCT_HOME: SagajeongDumpFixture = {
  header: {
    lat: 37.57564378189635,
    lng: 127.0871823501924,
    nearestStationName: '용마산',
    nearestDistanceM: 225,
    kstDate: '2026-10-18',
    baroFirstCallbackAt: '23:20:46',
  },
  rows: [
    '23:22:15 | cycle | 7-014 | arrival/arrival-confirmed | gps(17m/-) | walking | sub=false | arvlCd=1 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1010.7 | fix=23:20:48',
    '23:21:19 | cycle | 7-014 | arrival/arrival-confirmed | gps(17m/-) | walking | sub=false | arvlCd=1 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1010.7 | fix=23:20:48',
    '23:21:03 | cycle | 7-014 | arrival/arrival-confirmed | gps(17m/-) | walking | sub=false | arvlCd=1 | arc=0.00 | cell=NRNSA/surface-weak-nrnsa | hpa=1010.7 | fix=23:20:48',
  ],
};

export const D_19_OCT_TTUKSEOM_OFFICE: SagajeongDumpFixture = {
  header: {
    lat: 37.54631235133286,
    lng: 127.0488281528063,
    nearestStationName: '뚝섬',
    nearestDistanceM: 161,
    kstDate: '2026-10-19',
    baroFirstCallbackAt: '17:35:19',
  },
  rows: [
    '17:46:27 | cycle | bundang-052 | arrival/arrival-confirmed | gps(3m/-) | unknown | sub=false | arvlCd=4 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1017.6 | fix=17:44:49',
    '17:46:26 | cycle | bundang-052 | arrival/arrival-confirmed | gps(3m/-) | unknown | sub=false | arvlCd=4 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1017.6 | fix=17:44:49',
    '17:46:25 | cycle | bundang-052 | arrival/arrival-confirmed | gps(3m/-) | walking | sub=false | arvlCd=4 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1017.6 | fix=17:44:49',
  ],
};

/**
 * W: ~/Downloads/텍스트-47A7E6D831B4-1.txt (2026-10-28 17:49 KST dump) - PR-0/PR-1 계측(watch/app/baroEvt/hold)이
 * 들어간 유일한 덤프. 거부 행으로 쓴다(plan pr2-final §7 "거부").
 *  - 06:21:02: 정확도는 통과(5m)하지만 baroEvt 06:21:01이 lookback 안 -> hold=0 (baro-event).
 *  - 06:26:49: 지하(용마산 승강장) acc 45 + baroEvt 06:26:49 -> hold=0.
 *  - 17:24:06: 지하(7-019 `underground`) acc 27인데도 PR-1 술어는 hold=1이었다 - G2가 막아야 하는 행.
 *    Raw 행에는 최근접역 거리가 출력되지 않으므로(B8) 거리는 테스트가 지하 승강장 표본(용마산 64m, acc 20)을 넣는다.
 */
export const W_28_OCT: SagajeongDumpFixture = {
  header: {
    // W의 `## GPS`는 17:49 집 좌표(37.57568213121049, 127.08714660883145), 용마산 230m. 아래 행은 그 시각의 위치가 아니므로
    // 좌표는 쓰지 않고(테스트가 행별로 지정) 날짜/기압 시작만 쓴다.
    lat: 37.57568213121049,
    lng: 127.08714660883145,
    nearestStationName: '용마산',
    nearestDistanceM: 230,
    kstDate: '2026-10-28',
    baroFirstCallbackAt: '17:48:50',
  },
  rows: [
    '06:21:02 | cycle | 7-015 | position/arrival-confirmed | gps(5m/-) | automotive | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1021.2 | fix=06:20:59 | watch=inactive | app=background | baroEvt=06:21:01 | hold=0',
    '06:26:49 | enter | 7-016 | position/arrival-arriving | gps(45m/-) | automotive | sub=false | arvlCd=3 | arc=63.58 | cell=NRNSA/surface-weak-nrnsa | hpa=1025.5 | fix=06:26:34 | watch=active | app=inactive | baroEvt=06:26:49 | hold=0',
    '17:24:06 | enter | 7-018 | arrival/arrival-arriving | gps(27m/-) | automotive | sub=false | arvlCd=99 | arc=1431.16 | cell=NRNSA/surface-weak-nrnsa | hpa=1024.1 | fix=17:23:51 | watch=inactive | app=background | baroEvt=17:19:46 | hold=1',
  ],
};

export interface ParsedRawRow {
  /** 행 시각(= cycle이 돈 시각) epoch ms. */
  nowMs: number;
  stationId: string;
  accuracyMeters: number;
  /** fix 수신 시각 epoch ms. */
  fixAtMs: number;
  hpa: number;
  /** `sub=false|true`. */
  subsurface: boolean;
  arvlCd: number;
  /** `baroEvt=HH:MM:SS` (PR-0 이후 덤프만). 컬럼이 없으면(구 덤프) null. */
  baroEventAtMs: number | null;
}

/** `YYYY-MM-DD` + KST `HH:MM:SS` -> epoch ms. */
export function kstEpochMs(kstDate: string, hms: string): number {
  return Date.parse(`${kstDate}T${hms}+09:00`);
}

/** Raw Signal 원문 한 줄을 읽는다 (formatter 컬럼 순서 고정: DebugModal formatRawSignalLine). */
export function parseRawRow(line: string, kstDate: string): ParsedRawRow {
  const cols = line.split(' | ').map((c) => c.trim());
  const [time, , stationId, , gps, , sub, arvl, , , hpa, fix, , , baroEvt] = cols;
  // 덤프 원문 고정 포맷(`gps(<acc>m/…)`) - 형식이 바뀌면 NaN으로 테스트가 깨진다.
  const [, accuracy] = gps.match(/gps\((\d+(?:\.\d+)?)m/) as RegExpMatchArray;
  return {
    nowMs: kstEpochMs(kstDate, time),
    stationId,
    accuracyMeters: Number(accuracy),
    fixAtMs: kstEpochMs(kstDate, fix.replace('fix=', '')),
    hpa: Number(hpa.replace('hpa=', '')),
    subsurface: sub === 'sub=true',
    arvlCd: Number(arvl.replace('arvlCd=', '')),
    baroEventAtMs:
      baroEvt === undefined ? null : kstEpochMs(kstDate, baroEvt.replace('baroEvt=', '')),
  };
}
