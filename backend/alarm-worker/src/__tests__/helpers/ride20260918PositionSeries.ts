/**
 * 2026-09-18 저녁 라이드 device position/motion series 실측 (#2718, 2차 fidelity 정정).
 *
 * main coordinator 지적: 최초 lockless 재생이 station-passed 채널 0건("RED")을 낸 것은
 * `runLocklessIntermediate`의 `isAdvanceAllowedByMotion` 게이트(scheduled.ts:482)가 매
 * cycle 차단했기 때문인데, 그 판정 입력(motion series)을 fixture가 **아예 공급하지
 * 않았다** — R2 `seoul-capture/`(Seoul Open API 응답)에는 device position이 없다.
 * 그 상태에서 "backend 결함"으로 결론 낸 것은 fixture 인공물을 코드 결함으로 오판한 것.
 *
 * 실측 device는 `POST /position`을 약 10s 간격으로 76회 보냈고 매 payload에 motion이
 * 실린다 — 그 실측이 **덤프 Raw Signal 섹션**(`ed3e62ef-918-2.txt`, `## Raw Signal (300)`)
 * 에 cycle 단위로 그대로 남아있다. 아래 배열은 그 섹션에서 `kind==='cycle'`이고
 * `17:38:00~17:52:35` 창(fixture window와 동일)에 속하는 라인을 그대로 옮긴 것 —
 * **조작/합성 금지**(CLAUDE.md 정직 제약) 원칙에 따라 관측된 그대로다.
 *
 * 실측 분포(17:40~17:49, 조건 상세는 main coordinator 코멘트): automotive 23 / walking 13 /
 * "-"(미상) 1. `LOCKLESS_ADVANCE_MOTION_MODES = {'walking','automotive'}`(scheduled.ts:473)
 * 이므로 실제로는 이 값들이 게이트를 통과했을 것 — 그 사실을 재생에 반영해야 "backend가
 * 실제로 침묵했는지"를 정직하게 판정할 수 있다.
 *
 * ## 원본 → PositionPoint 변환 규칙 (정직 명시)
 * - `time`(HH:MM:SS, 2026-09-18 KST) → epoch ms.
 * - `motion`: 덤프 토큰 그대로(`automotive`/`walking`), `-`(미상)는 `PositionPoint.motion`
 *   스키마의 `unknown`에 대응.
 * - `accuracy`: 덤프 `gps(accM/-)`의 accM.
 * - `lat`/`lng`: 덤프는 좌표를 직접 주지 않고 `stationId`(가장 가까운 역 추정)만 준다 —
 *   해당 역의 `stations.json` 좌표로 근사한다. `isAdvanceAllowedByMotion`은 `motion` 필드
 *   자체만 참조하고 좌표를 쓰지 않으므로 이 근사가 그 게이트 판정에는 영향을 주지 않는다
 *   (좌표는 `gpsAvgKmh`/`mapMatchedKmh` 등 이 재생에서 사용하지 않는 부가 지표에만 관여).
 *   `stationId`가 "-"(미상)인 라인은 직전 관측 역을 이월(last-observed carry-forward)했다.
 * - **1개 라인 제외**(45/46) — `17:47:13`은 `gps(-/-)`로 accuracy 자체가 없어
 *   `PositionPoint.accuracy: number` 스키마를 만족할 실측값이 없다. 조작 대신 제외했다
 *   (그 시점 motion도 `-`라 결과에 미치는 영향은 미미 — 지배적 분포는 그대로 automotive
 *   우세).
 * - **17:50:42 이후 데이터 없음** — 덤프 ring buffer(300 cycle)가 이 시점 이후 `cycle` 종류
 *   샘플을 담고 있지 않다(다른 kind만 존재). fixture window는 17:52:29까지이므로 그 구간
 *   (17:50:42~17:52:29, 약 107초)은 motion series가 비어 evaluateWindow가 자연스럽게
 *   가장 최근 6개 sample(MOTION_RECENT_COUNT)로 최빈값을 유지한다 — 이 구간만 실측
 *   부재를 그대로 반영(공백을 채우지 않음).
 */
import type { PositionPoint } from '../../types';

interface RawMotionSample {
  time: string;
  ts: number;
  motion: PositionPoint['motion'];
  accuracy: number;
  lat: number;
  lng: number;
}

/** 덤프 Raw Signal에서 그대로 옮긴 45개 실측 sample (시간순, 위 파일 헤더 변환 규칙 참고). */
const RAW_SAMPLES: readonly RawMotionSample[] = [
  { time: '17:38:01', ts: 1789720681000, motion: 'automotive', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:38:08', ts: 1789720688000, motion: 'automotive', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:38:35', ts: 1789720715000, motion: 'automotive', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:38:41', ts: 1789720721000, motion: 'automotive', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:39:12', ts: 1789720752000, motion: 'walking', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:39:20', ts: 1789720760000, motion: 'walking', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:39:23', ts: 1789720763000, motion: 'walking', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:39:30', ts: 1789720770000, motion: 'walking', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:39:39', ts: 1789720779000, motion: 'walking', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:39:54', ts: 1789720794000, motion: 'automotive', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:40:10', ts: 1789720810000, motion: 'automotive', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:40:16', ts: 1789720816000, motion: 'automotive', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:40:28', ts: 1789720828000, motion: 'automotive', accuracy: 49.0, lat: 37.540373, lng: 127.069191 },
  { time: '17:40:31', ts: 1789720831000, motion: 'automotive', accuracy: 49.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:40:31', ts: 1789720831000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:40:31', ts: 1789720831000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:40:31', ts: 1789720831000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:40:32', ts: 1789720832000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:40:33', ts: 1789720833000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:40:49', ts: 1789720849000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:40:53', ts: 1789720853000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:41:38', ts: 1789720898000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:41:41', ts: 1789720901000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:42:16', ts: 1789720936000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:42:17', ts: 1789720937000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:42:19', ts: 1789720939000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:45:12', ts: 1789721112000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:45:30', ts: 1789721130000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:45:46', ts: 1789721146000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:45:50', ts: 1789721150000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:45:59', ts: 1789721159000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:46:37', ts: 1789721197000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:46:57', ts: 1789721217000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:47:11', ts: 1789721231000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:47:15', ts: 1789721235000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:47:22', ts: 1789721242000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:47:25', ts: 1789721245000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:47:29', ts: 1789721249000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:47:33', ts: 1789721253000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:48:45', ts: 1789721325000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:48:58', ts: 1789721338000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:49:43', ts: 1789721383000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:49:47', ts: 1789721387000, motion: 'walking', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:49:58', ts: 1789721398000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
  { time: '17:50:42', ts: 1789721442000, motion: 'automotive', accuracy: 74.0, lat: 37.540786, lng: 127.071011 },
];

/**
 * `runCaptureReplay({ seedPositionSeries })`에 그대로 넘길 수 있는 `PositionPoint[]` —
 * seed trip의 `token`을 key로 매핑해서 사용한다(`readSeries(env.TRIPS, trip.token)`와
 * 동일 키 계약).
 */
export function buildRide20260918PositionSeries(): PositionPoint[] {
  return RAW_SAMPLES.map((s) => ({
    lat: s.lat,
    lng: s.lng,
    accuracy: s.accuracy,
    ts: s.ts,
    motion: s.motion,
  }));
}
