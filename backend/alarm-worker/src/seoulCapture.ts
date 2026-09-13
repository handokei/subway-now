/**
 * Seoul API raw HTTP 응답 캡처 → R2 (#2579, Epic #2239 P0-a).
 *
 * record-replay(#2239)의 빠진 입력을 메운다. cron `handler.scheduled` 경로에서
 * `SeoulArrivalClient`가 나가는 모든 HTTP 요청/응답(raw body)을 fetchImpl 레벨에서
 * 가로채 cycle 단위로 버퍼링하고, active trip이 있던 cycle에 한해 R2(TELEMETRY_R2)에
 * flush한다. 파싱 전 raw body를 저장하므로 P0-c 재생 시 실제 파싱 코드(seoul.ts)까지
 * 포함해 재생할 수 있다 — 파싱 후 entry 캡처(#2571 하네스 방식)는 재생 커버리지가
 * 좁아 기각.
 *
 * 캡처는 순수 관찰자다: 실패해도 cron 본 흐름(push 발사)에 영향을 주면 안 된다.
 */
import { SEOUL_ARRIVAL_PATH_SEGMENT, SEOUL_POSITION_PATH_SEGMENT } from './seoul';

/** capture cycle 파일 스키마 v1 — P0-b 번들러/P0-c 재생 하네스가 공유. */
export interface SeoulCaptureEntry {
  /** fetch 시각 epoch ms */
  tMs: number;
  /** 'arrival' | 'position' — URL의 realtimeStationArrival / realtimePosition으로 분류 */
  kind: 'arrival' | 'position';
  /** arrival이면 역명, position이면 호선명 (URL 마지막 path segment, decodeURIComponent) */
  target: string;
  /** API 키 마스킹된 URL */
  url: string;
  /** HTTP status. fetch throw 시 0 */
  status: number;
  /** 응답 body text. fetch throw/비2xx여도 가능한 만큼 보존, 실패 시 '' */
  body: string;
  /** 안전 상한(개수/바이트) 초과로 body를 생략했으면 true */
  truncated?: boolean;
}

export interface SeoulCaptureCycle {
  schemaVersion: 1;
  cycleStartMs: number;
  scanned: number;
  /** 이번 cycle에서 캡처된 Seoul API 호출(entries) 수 — ScheduledStats.polled(락 활성 trip 수)와 의미가 달라 별도 명명 (#2579 리뷰). */
  seoulCalls: number;
  entries: SeoulCaptureEntry[];
  /** entries 개수 상한 또는 body 바이트 상한으로 온전히 캡처되지 못한 건수. 0/undefined면 무손실. */
  droppedEntries?: number;
}

export interface SeoulCaptureRecorder {
  /** base fetch를 감싼 recording fetch — SeoulArrivalClient의 fetchImpl로 주입한다. */
  fetchImpl: typeof fetch;
  entries: SeoulCaptureEntry[];
  /** 지금까지 캡처된 body의 UTF-8 바이트 합계. index.ts log의 `bytes`가 재계산 대신 이 값을 쓴다. */
  totalBodyBytes: number;
  /** entries 상한/byte 상한으로 온전히 캡처되지 못한 건수 (silent drop 관측용, #2579 리뷰). */
  droppedEntries: number;
}

/** entries 개수 상한 — 이후 요청은 위임만 하고 캡처하지 않는다. */
const MAX_ENTRIES = 200;
/** body 바이트(UTF-8) 합계 상한 — 초과분은 body를 비우고 truncated 마킹. */
const MAX_TOTAL_BODY_BYTES = 4 * 1024 * 1024;

const ARRIVAL_URL_PATTERN = new RegExp(`/${SEOUL_ARRIVAL_PATH_SEGMENT}/[^/]+/[^/]+/([^/?]+)`);
const POSITION_URL_PATTERN = new RegExp(`/${SEOUL_POSITION_PATH_SEGMENT}/[^/]+/[^/]+/([^/?]+)`);

/**
 * Seoul API 요청 URL → kind('arrival'|'position')/target(역명 또는 호선명) 분류.
 * P0-c 재생 하네스(`__tests__/helpers/replayHarness.ts`)가 fixture entry를 찾을 때 이
 * 함수를 재사용한다 — URL 패턴 정규식 중복 구현 금지 (#2581 설계).
 */
export function classifyUrl(url: string): { kind: 'arrival' | 'position'; target: string } | null {
  const arrivalMatch = url.match(ARRIVAL_URL_PATTERN);
  if (arrivalMatch) {
    return { kind: 'arrival', target: decodeURIComponent(arrivalMatch[1]) };
  }
  const positionMatch = url.match(POSITION_URL_PATTERN);
  if (positionMatch) {
    return { kind: 'position', target: decodeURIComponent(positionMatch[1]) };
  }
  return null;
}

function maskApiKey(url: string, apiKey: string): string {
  return apiKey ? url.split(apiKey).join('***') : url;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * base fetch를 감싼 recording fetchImpl을 만든다. `SeoulArrivalClient`의 `fetchImpl`
 * 옵션으로 주입하면 cron cycle 동안의 모든 Seoul API 요청/응답이 `entries`에 쌓인다.
 *
 * - URL이 arrival/position 패턴에 매칭 안 되면 캡처 skip하고 위임만 한다(방어적 — 알 수 없는
 *   요청 형태를 억지로 분류하지 않는다).
 * - fetch 자체가 throw해도(네트워크 오류 등) status=0, body=''로 entry를 남기고 원래
 *   예외를 그대로 재throw한다 — 캡처가 seoul.ts의 에러 핸들링을 바꾸면 안 된다.
 * - body 바이트 예산이 이미 소진된 상태면 clone/text 디코드 자체를 건너뛰고 곧장
 *   truncated entry를 남긴다(불필요한 디코드 비용 회피, #2579 리뷰).
 */
export function createSeoulCaptureRecorder(apiKey: string, now: () => number = Date.now): SeoulCaptureRecorder {
  const entries: SeoulCaptureEntry[] = [];
  let totalBodyBytes = 0;
  let droppedEntries = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    // seoul.ts는 fetchImpl을 항상 plain string URL로 호출한다(RequestInfo/URL 형태는
    // 실사용 없음). String()으로 통일해 불필요한 분기(및 커버리지 사각지대)를 없앤다.
    const url = String(input);
    const classified = classifyUrl(url);
    if (!classified) {
      return fetch(input, init);
    }

    const tMs = now();
    const maskedUrl = maskApiKey(url, apiKey);

    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (err) {
      if (entries.length < MAX_ENTRIES) {
        entries.push({ tMs, ...classified, url: maskedUrl, status: 0, body: '' });
      } else {
        droppedEntries += 1;
      }
      throw err;
    }

    if (entries.length >= MAX_ENTRIES) {
      droppedEntries += 1;
      return response;
    }

    if (totalBodyBytes >= MAX_TOTAL_BODY_BYTES) {
      // budget 이미 소진 — clone/text 디코드를 생략하고 곧장 truncated entry.
      entries.push({ tMs, ...classified, url: maskedUrl, status: response.status, body: '', truncated: true });
      droppedEntries += 1;
      return response;
    }

    const cloned = response.clone();
    let body = '';
    try {
      body = await cloned.text();
    } catch {
      body = '';
    }

    let truncated = false;
    const bodyBytes = utf8ByteLength(body);
    if (totalBodyBytes + bodyBytes > MAX_TOTAL_BODY_BYTES) {
      body = '';
      truncated = true;
      droppedEntries += 1;
    } else {
      totalBodyBytes += bodyBytes;
    }

    entries.push({
      tMs,
      ...classified,
      url: maskedUrl,
      status: response.status,
      body,
      ...(truncated ? { truncated: true } : {}),
    });

    return response;
  };

  return {
    fetchImpl,
    entries,
    get totalBodyBytes() {
      return totalBodyBytes;
    },
    get droppedEntries() {
      return droppedEntries;
    },
  };
}

/** R2 key prefix. */
export const SEOUL_CAPTURE_KEY_PREFIX = 'seoul-capture/';

/** UTC 날짜 key(`YYYY-MM-DD`) — #2592 admin/seoul-capture/keys의 날짜 prefix 분할이 재사용. */
export function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** R2 key 포맷을 caller(index.ts log 호출)와 공유하기 위한 export. */
export function buildSeoulCaptureKey(cycleStartMs: number): string {
  return `${SEOUL_CAPTURE_KEY_PREFIX}${utcDateKey(cycleStartMs)}/${cycleStartMs}.json`;
}

/**
 * `buildSeoulCaptureKey`의 역함수 — key basename(`{cycleStartMs}.json`)에서 cycleStartMs를
 * 파싱한다. 포맷 불일치(basename이 숫자.json이 아님)면 null (#2592).
 */
export function parseSeoulCaptureKey(key: string): number | null {
  const match = key.match(/\/(\d+)\.json$/);
  if (!match) return null;
  const ms = Number(match[1]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * cycle을 R2에 저장한다. key = `seoul-capture/{YYYY-MM-DD}/{cycleStartMs}.json` (UTC 날짜).
 * throw는 caller(index.ts `handler.scheduled`)에서 swallow + Sentry forward한다 — 이
 * 함수 자체는 방어 처리를 하지 않는다(단일 책임: put만).
 */
export async function flushSeoulCapture(r2: R2Bucket, cycle: SeoulCaptureCycle): Promise<void> {
  const key = buildSeoulCaptureKey(cycle.cycleStartMs);
  await r2.put(key, JSON.stringify(cycle));
}
