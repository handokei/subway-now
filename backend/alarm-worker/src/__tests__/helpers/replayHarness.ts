/**
 * capture fixture 재생 하네스 — 재사용 가능한 helper (Epic #2239 P0-c, #2581).
 *
 * #2571의 1회성 하네스(`replay_20260912_line7_arvlcd_sampling.test.ts`)는 파싱을 우회하고
 * 축약된 필드를 합성한 fake `SeoulArrivalClient`를 직접 구현해 충실도 한계가 있었다. 이
 * 하네스는 **fetchImpl 레벨**로 내려 실제 `SeoulArrivalClient`(seoul.ts) 파싱 코드까지
 * 재생 범위에 포함한다 — fixture의 raw Seoul JSON body가 실 파싱 경로를 그대로 통과한다.
 *
 * 입력 = `ReplayFixture`(P0-b, replayFixture.ts) + seed Trip[]. 출력 = cycle별
 * `ScheduledStats` + 발사된 push 목록 — 어떤 가설이든 라이드 0으로 오프라인 검증한다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import {
  runMidCycleFireOnly,
  runScheduled,
  type MidCycleFireStats,
  type ScheduledStats,
} from '../../scheduled';
import { resetApnsJwtCache, type ApnsConfig } from '../../apns';
import { putTrip } from '../../trips';
import { classifyUrl } from '../../seoulCapture';
import { SeoulArrivalClient } from '../../seoul';
import { isLossyFixture, type ReplayFixture } from '../../replayFixture';
import { MID_CYCLE_OFFSET_MS } from '../../cronConstants';
import type { Env, Trip } from '../../types';
import { InMemoryKV } from '../inMemoryKv';

/** Seoul 갱신 주기 근사 — 이 창 안의 최신 관측만 유효(#2571 하네스와 동일 정책). */
const DEFAULT_FRESH_MS = 20_000;

const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };

/** cron 재생 중 발사(APNs 전송)된 push 1건 — fetchImpl로 가로챈 실제 요청. */
export interface CapturedPush {
  simNowMs: number;
  url: string;
  /** POST body를 JSON.parse한 결과. `{ aps, data, body? }` 형태(silent/alert 공통 `data`). */
  body: Record<string, unknown>;
  /**
   * APNs 전송 헤더 일부 (#2581 리뷰 P5) — `apns-push-type`으로 silent(background)와
   * alert(사용자 가시 배너)를 구분한다. "매역 침묵 0" 같은 assertion이 실제로는 silent만
   * 발사되고 화면엔 아무것도 안 뜨는 상태를 green 처리하는 것을 차단하기 위함.
   */
  headers: { pushType?: string; priority?: string; collapseId?: string };
}

export interface ReplayCycleResult {
  simNowMs: number;
  stats: ScheduledStats;
  pushes: CapturedPush[];
}

/**
 * #2615 (재설계) — `runCaptureReplay({ twoPass: true })`가 생성하는 t+30 경량 fire-only
 * pass 1회분 결과. 1차 `ReplayCycleResult`와 다른 타입 — mid pass는 `runScheduled`를
 * 재진입하지 않고 `runMidCycleFireOnly`(fire-only, `MidCycleFireStats`)만 실행하므로
 * 전체 `ScheduledStats` shape을 만들 근거가 없다(F8: allowlist 함수를 직접 단위로 다루기
 * 위한 분리이기도 하다).
 */
export interface MidCycleReplayResult {
  simNowMs: number;
  stats: MidCycleFireStats;
  pushes: CapturedPush[];
}

export interface ReplayRunResult {
  cycles: ReplayCycleResult[];
  /** #2615 — `twoPass: true`일 때만 채워짐(기본 `[]`). */
  midCycles: MidCycleReplayResult[];
  pushes: CapturedPush[];
  /**
   * fixture에 캡처 유실 신호(`droppedEntries`/`failedCycleStartsMs`)가 있으면 true —
   * 이 재생 결과가 불완전한 입력으로 만들어졌다는 경고. caller는 이 값을 무시하지 말고
   * 결론(특히 "발사 안 됨")을 낼 때 신뢰도 판단에 반영해야 한다.
   */
  lossyCapture: boolean;
}

/** Seoul 빈 응답 JSON — freshness 창 안에 매칭되는 entry가 없거나(또는 truncated) fallback. */
function emptySeoulResponseBody(kind: 'arrival' | 'position'): string {
  return kind === 'arrival' ? '{"realtimeArrivalList":[]}' : '{"realtimePositionList":[]}';
}

/**
 * `SeoulCaptureEntry.status`가 실제 HTTP Response로 구성 가능한 값인지. capture recorder
 * (`seoulCapture.ts`)는 fetch 자체가 throw한 네트워크 오류를 `status: 0`으로 기록한다 —
 * `new Response(body, { status: 0 })`는 RangeError이므로 그대로 재생하면 안 되고, 원본이
 * throw였다는 사실 자체를 fetch reject로 재현해야 한다(#2581 리뷰 P3).
 */
function isConstructibleResponseStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status <= 599;
}

/**
 * fixture 캡처 스트림을 서빙하는 fetchImpl. simNow 기준 `freshMs`(default 20s) 이내의
 * 최신 entry의 raw body/status를 그대로 응답한다 — 파싱은 실 `SeoulArrivalClient`가 한다.
 * classify는 `seoulCapture.ts`의 URL 파서를 그대로 재사용(중복 정규식 구현 금지).
 *
 * - entry가 `truncated`(캡처 상한으로 body가 비워짐)면 raw body(빈 문자열)를 그대로 서빙하지
 *   않는다 — `replayFixture.ts`의 계약("재생 시 빈 응답 취급은 하네스 책임")대로 적법한 빈
 *   Seoul JSON으로 매핑한다. 빈 문자열을 그대로 흘리면 `SeoulArrivalClient`의 `response.json()`이
 *   SyntaxError를 던져 해당 cron cycle 전체가 오염된다(#2581 리뷰 P2).
 * - entry의 `status`가 Response로 구성 불가능한 값(0 등, fetch 자체 실패 sentinel)이면 그
 *   자체를 reject해 원본의 네트워크 오류를 재현한다(#2581 리뷰 P3).
 *
 * `ceilingMs`(#2600) — entry.tMs가 넘을 수 없는 상한. 미지정 시 `simNow`(기존 동작, 옛
 * "합성 grid" 재생과 100% 동일 — grid tick은 실 cycleStartsMs와 무관해 미래 entry를 허용할
 * 근거가 없다). `runCaptureReplay`가 'recorded' cadence(cron 미지정)에서 **실 캡처**를
 * 재생할 때만 다음 tick 시각을 넘겨 넓힌다 — production `handler.scheduled`는
 * `cycleStartMs = Date.now()`를 fetch **이전**에 stamp하므로(`src/index.ts`), 실 캡처
 * entry의 tMs는 그 cycle 자신의 `cycleStartMs`보다 항상(네트워크/처리 지연만큼, 실측
 * 수 초) **뒤**에 찍힌다. `entry.tMs > simNow`를 그대로 두면 이 몇 초 지연 때문에 그 entry가
 * 자신이 속한 cycle의 tick에서는 "아직 안 옴"으로, 다음 tick에서는 이미 `freshMs`를 넘겨
 * "너무 오래됨"으로 두 번 다 걸러져 **영영 재생되지 않는다** — 실캡처 fixture(#2600
 * capture_20260913T1249Z_b00dd879)를 라이브러리에 등록하며 발견(발사 0건 회귀 재현).
 * `ceilingMs`를 다음 tick(=그 다음 실 cron 실행 시각)으로 넓히면 "이 cycle 동안 캡처된
 * entry는 이 cycle의 tick에서 보인다"는 실제 의미를 정확히 재현하면서, 여전히 그 다음
 * cycle의 entry가 이번 tick으로 새는 것은 막는다(합성 grid의 90s 드리프트 회귀 테스트는
 * `ceilingMs` 미지정 경로라 영향 없음).
 */
export function makeCaptureFetch(
  fixture: ReplayFixture,
  getNow: () => number,
  opts?: { freshMs?: number; ceilingMs?: number },
): typeof fetch {
  const freshMs = opts?.freshMs ?? DEFAULT_FRESH_MS;

  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const classified = classifyUrl(url);
    if (!classified) {
      return new Response('{}', { status: 200 });
    }

    const simNow = getNow();
    const ceilingMs = opts?.ceilingMs ?? simNow;
    let latest: ReplayFixture['entries'][number] | null = null;
    for (const entry of fixture.entries) {
      if (entry.kind !== classified.kind || entry.target !== classified.target) continue;
      if (entry.tMs > ceilingMs || simNow - entry.tMs >= freshMs) continue;
      if (!latest || entry.tMs > latest.tMs) latest = entry;
    }

    if (!latest) {
      return new Response(emptySeoulResponseBody(classified.kind), { status: 200 });
    }
    if (!isConstructibleResponseStatus(latest.status)) {
      throw new Error(`replay: 캡처된 fetch 실패 재현 (status=${latest.status}, target=${classified.target})`);
    }
    const body = latest.truncated ? emptySeoulResponseBody(classified.kind) : latest.body;
    return new Response(body, { status: latest.status });
  }) as unknown as typeof fetch;
}

function makeEnv(kv: InMemoryKV, apnsConfig: ApnsConfig): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: apnsConfig.keyId,
    APNS_TEAM_ID: apnsConfig.teamId,
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: apnsConfig.bundleId,
  };
}

/** ES256 테스트 키 생성 — 재생마다 재생성하지 않도록 모듈 스코프에서 1회 메모이즈. */
let cachedApnsConfig: Promise<ApnsConfig> | undefined;
function getTestApnsConfig(): Promise<ApnsConfig> {
  if (!cachedApnsConfig) {
    cachedApnsConfig = (async () => {
      const { privateKey } = await generateKeyPair('ES256');
      const privateKeyPem = await exportPKCS8(privateKey);
      resetApnsJwtCache();
      return { keyId: 'K', teamId: 'T', privateKeyPem, bundleId: 'com.example.app' };
    })();
  }
  return cachedApnsConfig;
}

function extractHeader(headers: RequestInit['headers'], name: string): string | undefined {
  // apns.ts의 모든 sendXPush는 headers를 plain object literal로 구성해 fetchImpl에 넘긴다
  // (Headers 인스턴스/배열 형태 사용 없음) — 이 하네스가 가로채는 유일한 caller 표면.
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  return (headers as Record<string, string>)[name];
}

/** APNs 전송(fetchImpl)을 가로채 CapturedPush로 기록하고 200을 반환하는 fake sender. */
function makeCapturingApnsFetch(sink: CapturedPush[], getNow: () => number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    sink.push({
      simNowMs: getNow(),
      url: String(input),
      body,
      headers: {
        pushType: extractHeader(init?.headers, 'apns-push-type'),
        priority: extractHeader(init?.headers, 'apns-priority'),
        collapseId: extractHeader(init?.headers, 'apns-collapse-id'),
      },
    });
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

/** APNs push를 캡처하지 않고 전부 200으로 no-op 처리하는 fetchImpl(기존 #2571 패턴). */
const NOOP_APNS_FETCH: typeof fetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;

/**
 * `recorded` cadence 전용 — 캡처된 entry가 자신이 속한 cycle의 `cycleStartMs`보다 실제로
 * 얼마나 늦게 찍혔는지(median, ms)를 fixture 자체 데이터로 산출한다 (#2600 코드리뷰 항목2).
 *
 * production `handler.scheduled`는 `cycleStartMs = Date.now()`를 Seoul fetch **이전**에
 * stamp한다(`src/index.ts`) — 그래서 그 cycle 동안 캡처된 entry들의 `tMs`는 항상
 * `cycleStartMs`보다 (네트워크/처리 지연만큼) 뒤에 찍힌다. `runCaptureReplay`가 tick을
 * `cycleStartMs` 정각으로 잡으면 production이 실제로 그 데이터를 "평가한" 시점(=fetch가
 * 끝나고 게이트를 통과하는 순간)보다 최대 수 초 이르게 시뮬레이션하게 되고, 이 차이가
 * `evaluateTransferDestinationGate`처럼 60s 임계에 근접한 게이트를 실제와 다르게(더 엄격하게)
 * 판정시킬 수 있다 — 실캡처 fixture(capture_20260913T1249Z_b00dd879)에서 건대입구
 * transfer 발사가 1ms 차이(60001ms)로 오탐 차단된 사례로 발견.
 *
 * 하드코딩 없이 fixture마다 실측값을 쓴다 — entry 각각을 "그 entry.tMs 이하인 cycleStartsMs
 * 중 가장 큰 값"이 속한 cycle로 배정하고, 그 cycle 대비 지연(entry.tMs - cycleStart)의
 * median을 취한다. entry가 없거나 cycleStartsMs가 비어 있으면 0(기존 동작, 합성 fixture는
 * 대개 entry.tMs===cycleStartMs라 median도 자연히 0).
 */
function computeExecLagMs(fixture: ReplayFixture): number {
  const cycleStarts = fixture.cycleStartsMs;
  if (cycleStarts.length === 0) return 0;
  const lags: number[] = [];
  for (const entry of fixture.entries) {
    let owningCycleStart: number | undefined;
    for (const cycleStart of cycleStarts) {
      if (cycleStart <= entry.tMs && (owningCycleStart === undefined || cycleStart > owningCycleStart)) {
        owningCycleStart = cycleStart;
      }
    }
    if (owningCycleStart !== undefined) lags.push(entry.tMs - owningCycleStart);
  }
  if (lags.length === 0) return 0;
  lags.sort((a, b) => a - b);
  const mid = Math.floor(lags.length / 2);
  return lags.length % 2 === 0 ? (lags[mid - 1] + lags[mid]) / 2 : lags[mid];
}

/**
 * 재생할 cron tick(simNow) 목록을 만든다 (#2581 리뷰 P1).
 *
 * - `cronIntervalMs` 미지정(기본): fixture가 기록한 **실제** cron cycle 시각
 *   (`fixture.cycleStartsMs`, P0-a가 실 `handler.scheduled` 호출마다 stamp한 값)에
 *   `computeExecLagMs`(위, #2600 코드리뷰 항목2)로 산출한 지연을 더해 tick으로 쓴다 —
 *   이게 실 P0-a 캡처를 충실히 재생하는 방법이다. 합성 균일 그리드로 가정하면(예:
 *   window.fromMs부터 60s 고정 스텝) 실 캡처의 cron 위상/드리프트와 어긋나 위상 30/45초
 *   같은 조합에서 매 tick이 어떤 entry의 freshness 창도 못 맞춰 전부 빈 응답 fallback이
 *   되는 "합성 grid vs 실 데이터" 불일치가 생긴다.
 * - `cronIntervalMs` 명시: 합성/고밀도 샘플링 fixture(예: 15s 간격으로 캡처해 60s cron을
 *   흉내내고 싶은 검증용 fixture)를 위해 `fixture.cycleStartsMs[0]`부터 균일 그리드로 건너
 *   뛴다 — 기존 동작 보존(execLag 미적용 — 합성 grid는 실 cycleStartsMs와 무관).
 * - `phaseOffsetMs`는 두 경우 모두 각 tick에 더해지는 상대 오프셋(cron 위상 스윕용).
 */
function buildTickSchedule(fixture: ReplayFixture, cronIntervalMs: number | undefined, phaseOffsetMs: number): number[] {
  if (cronIntervalMs !== undefined) {
    const startMs = (fixture.cycleStartsMs[0] ?? fixture.window.fromMs) + phaseOffsetMs;
    const ticks: number[] = [];
    for (let t = startMs; t <= fixture.window.toMs; t += cronIntervalMs) ticks.push(t);
    return ticks;
  }
  const recorded = fixture.cycleStartsMs.length > 0 ? fixture.cycleStartsMs : [fixture.window.fromMs];
  const execLagMs = computeExecLagMs(fixture);
  return recorded.map((cycleStartMs) => cycleStartMs + phaseOffsetMs + execLagMs);
}

/**
 * fixture 시간창을 cron 간격으로 걸으며 실제 `runScheduled`를 재생한다. cycle마다 fresh
 * `SeoulArrivalClient`(15s 내부 캐시 수명까지 production과 동일하게 재현)를 새로 만들어
 * fixture 캡처 스트림을 서빙하는 fetchImpl을 주입한다.
 *
 * KV(`InMemoryKV`)에는 재생 시계(simNow)를 clock으로 주입한다(#2581 리뷰 P4) — 그렇지
 * 않으면 `putTrip`의 KV TTL이 실 벽시계 기준으로 만료돼, 재생이 실행에 60초 이상 실 시간을
 * 쓰거나(느린 머신/장시간 재생) 하면 seed trip이 KV에서 사라져 "거짓 침묵"으로 오염된다.
 */
export async function runCaptureReplay(opts: {
  fixture: ReplayFixture;
  seedTrips: Trip[];
  cronIntervalMs?: number;
  phaseOffsetMs?: number;
  freshMs?: number;
  apns?: 'capture';
  /**
   * #2615 — 각 1차(정각) tick 뒤 `MID_CYCLE_OFFSET_MS`(30s)에 경량 2차(midCycle) pass를
   * 추가로 재생한다. production `index.ts:scheduleMidCyclePass`와 동일 게이트(1차
   * `stats.scanned > 0`일 때만) + 동일 스코프(`runScheduled({ midCycle: true })`)를
   * 그대로 흉내낸다. fresh `SeoulArrivalClient`를 매 pass 새로 생성해 1차와 캐시를
   * 분리한다(production과 동일 — 1차의 15s in-memory 캐시가 2차를 무력화하지 않도록).
   */
  twoPass?: boolean;
}): Promise<ReplayRunResult> {
  const phaseOffsetMs = opts.phaseOffsetMs ?? 0;
  const freshMs = opts.freshMs ?? DEFAULT_FRESH_MS;
  const ticks = buildTickSchedule(opts.fixture, opts.cronIntervalMs, phaseOffsetMs);

  const startMs = ticks[0] ?? opts.fixture.window.fromMs + phaseOffsetMs;
  let simNow = startMs;
  // #2581 리뷰 P4 — `trips.ts:putTrip`의 KV TTL clamp(`max(60, floor((expiresAt-Date.now())/1000))`)는
  // production 코드 내부에서 **실** `Date.now()`를 쓴다(못 바꿈). fixture의 `trip.expiresAt`은
  // fixture 앵커(과거 고정 epoch) 기준이라 실 Date.now()와의 차는 항상 음수 → 이 clamp가 항상
  // 최소값(60s)으로 saturate된다. production에서는 이 60s floor가 근접-만료 trip에만 적용되는
  // 안전판이고 정상 trip은 훨씬 긴 실TTL을 받아 재-put 여부와 무관하게 살아있는데, replay에서는
  // *모든* seed trip이 이 60s floor를 맞아 매 cycle 재-put(dirty)되지 않으면 KV 레벨에서 소멸한다.
  // `InMemoryKV`의 만료 판정 시계를 replay 시작 시각(anchor, 고정값)에 못박아 이 저장소 계층의
  // 부수적 TTL이 도메인 로직(`trip.expiresAt <= deps.now()`, scheduled.ts가 이미 시뮬레이션
  // 시계로 정확히 판단)과 별개로 재생을 오염시키지 않게 한다 — 재생이 실 벽시계뿐 아니라
  // "시뮬레이션 시계가 흐른다"는 사실 자체와도 완전히 독립되는 동급 해법.
  const kv = new InMemoryKV(() => startMs);
  for (const trip of opts.seedTrips) {
    await putTrip(kv as unknown as KVNamespace, trip);
  }

  const apnsConfig = await getTestApnsConfig();
  const env = makeEnv(kv, apnsConfig);

  const capturedPushes: CapturedPush[] = [];
  const apnsFetchImpl =
    opts.apns === 'capture' ? makeCapturingApnsFetch(capturedPushes, () => simNow) : NOOP_APNS_FETCH;

  let pushSeq = 0;
  const cycles: ReplayCycleResult[] = [];
  const midCycles: MidCycleReplayResult[] = [];
  // 'recorded' cadence(cronIntervalMs 미지정)에서만 다음 "실" cycle 경계를 ceiling으로
  // 넓힌다 — `makeCaptureFetch` 문서 참고(#2600). 합성 grid(cronIntervalMs 지정)는
  // ceilingMs를 안 넘겨 기존 동작(entry.tMs <= simNow)을 그대로 유지한다.
  //
  // ceiling은 반드시 **비-shift** `fixture.cycleStartsMs`(phaseOffsetMs/execLagMs를 더하지
  // 않은 원본 실제 cron 실행 시각)를 기준으로 잡는다 — `ticks`(위상/execLag가 반영된 값)를
  // 쓰면 위상 offset이 tick과 ceiling을 함께 밀어, entry는 고정된 실좌표에 있는데 평가
  // 창(window)만 미래로 옮겨가 다음 cycle의 entry가 이전 tick에 새는 회귀가 생긴다
  // (#2600 코드리뷰 항목3 — phaseOffset=15000에서 실증된 leak). `recordedCycleStarts`가
  // `ticks`와 index가 1:1로 맞는 이유는 `buildTickSchedule`이 'recorded' 분기에서
  // `fixture.cycleStartsMs`(비었으면 `[fixture.window.fromMs]`)를 그대로 map하기 때문.
  const isRecordedCadence = opts.cronIntervalMs === undefined;
  const recordedCycleStarts =
    opts.fixture.cycleStartsMs.length > 0 ? opts.fixture.cycleStartsMs : [opts.fixture.window.fromMs];

  for (let tickIdx = 0; tickIdx < ticks.length; tickIdx += 1) {
    const tick = ticks[tickIdx];
    simNow = tick;
    const ceilingMs = isRecordedCadence
      ? (recordedCycleStarts[tickIdx + 1] ?? opts.fixture.window.toMs + 1)
      : undefined;
    const seoul = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'seoul.api',
      now: () => tick,
      fetchImpl: makeCaptureFetch(opts.fixture, () => tick, { freshMs, ceilingMs }),
    });

    const pushCountBefore = capturedPushes.length;
    const stats = await runScheduled(env, {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetchImpl,
      now: () => tick,
      // #2581 리뷰 P6 — 같은 tick 안에서 여러 push가 발사될 수 있어 tick만으로는 충돌한다.
      generatePushId: () => `replay-${tick}-${pushSeq++}`,
    });

    cycles.push({ simNowMs: tick, stats, pushes: capturedPushes.slice(pushCountBefore) });

    // #2615 (재설계) — production `index.ts:scheduleMidCyclePass`와 동일 게이트(1차
    // `polled>0` + 스냅샷 non-empty에만 실행) + 동일 함수(`runMidCycleFireOnly`, fire-only,
    // `runScheduled` 재진입 없음)로 t+30 경량 pass를 재생한다.
    if (opts.twoPass && stats.polled > 0 && stats.midCycleSnapshot.length > 0) {
      const midTick = tick + MID_CYCLE_OFFSET_MS;
      simNow = midTick;
      // ceilingMs를 primary tick 것(다음 recorded cycle 경계)을 그대로 물려주지 않는다 — 그
      // ceiling은 "실 캡처 entry가 자기 소속 cycle 경계를 살짝 넘겨 찍혀도 그 cycle에서
      // 보이게" 하려는 recorded-cadence 전용 보정(#2600)이라, cycle 경계가 아닌 임의
      // 중간 시각(midTick)에 그대로 적용하면 아직 도래하지 않은(다음 실 cycle 몫) entry까지
      // 조기에 노출해 순서를 어긋나게 한다. production의 실제 의미(t+30 시점에 Seoul을 살아
      // 있는 그 순간으로 다시 호출)는 `ceilingMs` 미지정(default: `simNow`=midTick, 그 시각
      // 이전 entry만 허용)이 정확히 재현한다.
      const midSeoul = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'seoul.api',
        now: () => midTick,
        fetchImpl: makeCaptureFetch(opts.fixture, () => midTick, { freshMs }),
      });
      const midPushCountBefore = capturedPushes.length;
      const midStats: MidCycleFireStats = await runMidCycleFireOnly(
        env,
        stats.midCycleSnapshot,
        { seoul: midSeoul, apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: apnsFetchImpl },
        midTick,
        () => undefined,
        () => `replay-mid-${midTick}-${pushSeq++}`,
      );
      midCycles.push({
        simNowMs: midTick,
        stats: midStats,
        pushes: capturedPushes.slice(midPushCountBefore),
      });
    }
  }

  return { cycles, midCycles, pushes: capturedPushes, lossyCapture: isLossyFixture(opts.fixture) };
}
