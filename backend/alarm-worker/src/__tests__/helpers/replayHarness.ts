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
import { runScheduled, type ScheduledStats } from '../../scheduled';
import { resetApnsJwtCache, type ApnsConfig } from '../../apns';
import { putTrip } from '../../trips';
import { classifyUrl } from '../../seoulCapture';
import { SeoulArrivalClient } from '../../seoul';
import type { ReplayFixture } from '../../replayFixture';
import type { Env, Trip } from '../../types';
import { InMemoryKV } from '../inMemoryKv';

const DEFAULT_CRON_INTERVAL_MS = 60_000;
/** Seoul 갱신 주기 근사 — 이 창 안의 최신 관측만 유효(#2571 하네스와 동일 정책). */
const DEFAULT_FRESH_MS = 20_000;

const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };

/** cron 재생 중 발사(APNs 전송)된 push 1건 — fetchImpl로 가로챈 실제 요청. */
export interface CapturedPush {
  simNowMs: number;
  url: string;
  /** POST body를 JSON.parse한 결과. sendSilentPush가 보내는 `{ aps, data }` 형태. */
  body: Record<string, unknown>;
}

export interface ReplayCycleResult {
  simNowMs: number;
  stats: ScheduledStats;
  pushes: CapturedPush[];
}

export interface ReplayRunResult {
  cycles: ReplayCycleResult[];
  pushes: CapturedPush[];
  /**
   * fixture에 캡처 유실 신호(`droppedEntries`/`failedCycleStartsMs`)가 있으면 true —
   * 이 재생 결과가 불완전한 입력으로 만들어졌다는 경고. caller는 이 값을 무시하지 말고
   * 결론(특히 "발사 안 됨")을 낼 때 신뢰도 판단에 반영해야 한다.
   */
  lossyCapture: boolean;
}

/** Seoul 빈 응답 JSON — freshness 창 안에 매칭되는 entry가 없을 때 fallback. */
function emptySeoulResponseBody(kind: 'arrival' | 'position'): string {
  return kind === 'arrival' ? '{"realtimeArrivalList":[]}' : '{"realtimePositionList":[]}';
}

/**
 * fixture 캡처 스트림을 서빙하는 fetchImpl. simNow 기준 `freshMs`(default 20s) 이내의
 * 최신 entry의 raw body/status를 그대로 응답한다 — 파싱은 실 `SeoulArrivalClient`가 한다.
 * classify는 `seoulCapture.ts`의 URL 파서를 그대로 재사용(중복 정규식 구현 금지).
 */
export function makeCaptureFetch(
  fixture: ReplayFixture,
  getNow: () => number,
  opts?: { freshMs?: number },
): typeof fetch {
  const freshMs = opts?.freshMs ?? DEFAULT_FRESH_MS;

  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const classified = classifyUrl(url);
    if (!classified) {
      return new Response('{}', { status: 200 });
    }

    const simNow = getNow();
    let latest: ReplayFixture['entries'][number] | null = null;
    for (const entry of fixture.entries) {
      if (entry.kind !== classified.kind || entry.target !== classified.target) continue;
      if (entry.tMs > simNow || simNow - entry.tMs >= freshMs) continue;
      if (!latest || entry.tMs > latest.tMs) latest = entry;
    }

    if (!latest) {
      return new Response(emptySeoulResponseBody(classified.kind), { status: 200 });
    }
    return new Response(latest.body, { status: latest.status });
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

/** APNs 전송(fetchImpl)을 가로채 CapturedPush로 기록하고 200을 반환하는 fake sender. */
function makeCapturingApnsFetch(sink: CapturedPush[], getNow: () => number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    sink.push({ simNowMs: getNow(), url: String(input), body });
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

/** APNs push를 캡처하지 않고 전부 200으로 no-op 처리하는 fetchImpl(기존 #2571 패턴). */
const NOOP_APNS_FETCH: typeof fetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;

function hasLossySignal(fixture: ReplayFixture): boolean {
  return (fixture.droppedEntries ?? 0) > 0 || (fixture.failedCycleStartsMs?.length ?? 0) > 0;
}

/**
 * fixture 시간창을 cron 간격으로 걸으며 실제 `runScheduled`를 재생한다. cycle마다 fresh
 * `SeoulArrivalClient`(15s 내부 캐시 수명까지 production과 동일하게 재현)를 새로 만들어
 * fixture 캡처 스트림을 서빙하는 fetchImpl을 주입한다.
 */
export async function runCaptureReplay(opts: {
  fixture: ReplayFixture;
  seedTrips: Trip[];
  cronIntervalMs?: number;
  phaseOffsetMs?: number;
  apns?: 'capture';
}): Promise<ReplayRunResult> {
  const kv = new InMemoryKV();
  for (const trip of opts.seedTrips) {
    await putTrip(kv as unknown as KVNamespace, trip);
  }

  const apnsConfig = await getTestApnsConfig();
  const env = makeEnv(kv, apnsConfig);
  const cronIntervalMs = opts.cronIntervalMs ?? DEFAULT_CRON_INTERVAL_MS;
  const phaseOffsetMs = opts.phaseOffsetMs ?? 0;

  const capturedPushes: CapturedPush[] = [];
  let simNow = 0;
  const apnsFetchImpl =
    opts.apns === 'capture' ? makeCapturingApnsFetch(capturedPushes, () => simNow) : NOOP_APNS_FETCH;

  const startMs = (opts.fixture.cycleStartsMs[0] ?? opts.fixture.window.fromMs) + phaseOffsetMs;
  const cycles: ReplayCycleResult[] = [];

  for (simNow = startMs; simNow <= opts.fixture.window.toMs; simNow += cronIntervalMs) {
    const tick = simNow;
    const seoul = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'seoul.api',
      now: () => tick,
      fetchImpl: makeCaptureFetch(opts.fixture, () => tick),
    });

    const pushCountBefore = capturedPushes.length;
    const stats = await runScheduled(env, {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetchImpl,
      now: () => tick,
      generatePushId: () => `replay-${tick}`,
    });

    cycles.push({ simNowMs: tick, stats, pushes: capturedPushes.slice(pushCountBefore) });
  }

  return { cycles, pushes: capturedPushes, lossyCapture: hasLossySignal(opts.fixture) };
}
