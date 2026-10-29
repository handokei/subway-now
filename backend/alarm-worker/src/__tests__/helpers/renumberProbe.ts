/**
 * #3158 — 성수 번호 변경 replay 공용 하네스. 실측 R2 `seoul-capture` 캡처를 cron tick 순서대로
 * `runScheduled`에 공급하고 tick별 lock/miss/head + trip_events(D1) 행을 기록한다.
 * 캡처 fixture는 불변 실측(R2 원문과 byte 동일) — 통과시키려 조정 금지.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../../apns';
import { runScheduled } from '../../scheduled';
import { SeoulArrivalClient } from '../../seoul';
import { putTrip } from '../../trips';
import type { Env, Trip } from '../../types';
import { InMemoryKV } from '../inMemoryKv';

interface Capture {
  cycleStartMs: number;
  entries: Array<{ kind: string; target: string; body: string }>;
}

export interface D1Row {
  kind: string;
  station: string;
  meta: Record<string, unknown>;
}

export interface ProbeTick {
  /** KST HH:MM:SS */
  kst: string;
  lock: string | undefined;
  miss: number | undefined;
  headStation: string | undefined;
  /** 이번 tick의 `realtime-position:2` KV get 횟수. */
  position2Gets: number;
  logs: string[];
  d1: D1Row[];
}

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

export function loadCaptures(fixtureDir: string, skip = 0): Capture[] {
  const dir = path.join(FIXTURES_DIR, fixtureDir, 'caps');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return files.slice(skip).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as Capture);
}

function parseMeta(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const KST_OFFSET_MS = 9 * 3600_000;
const LOG_PATTERN = /swapped|timetable|fallback-fire|advanced|vanished —/;

export async function runCaptureTicks(captures: readonly Capture[], makeTrip: (t0: number, token: string) => Trip, token: string): Promise<ProbeTick[]> {
  const { privateKey } = await generateKeyPair('ES256');
  const apnsConfig: ApnsConfig = {
    keyId: 'K',
    teamId: 'T',
    privateKeyPem: await exportPKCS8(privateKey),
    bundleId: 'com.example.app',
  };
  resetApnsJwtCache();

  let simNow = captures[0].cycleStartMs;
  let active = captures[0];
  const kv = new InMemoryKV(() => simNow);
  const getSpy = vi.spyOn(kv, 'get');
  const inserts: unknown[][] = [];
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        inserts.push(args);
        return { run: async () => ({ success: true }), first: async () => null };
      },
    }),
  } as unknown as D1Database;
  const env = {
    TRIPS: kv,
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
    DB: db,
  } as unknown as Env;
  await putTrip(kv as unknown as KVNamespace, makeTrip(simNow, token));
  const seoul = new SeoulArrivalClient({
    apiKey: 'KEY',
    host: 'seoul.api',
    now: () => simNow,
    fetchImpl: (async (url: string) => {
      const target = decodeURIComponent(url.split('/').pop() ?? '');
      const kind = url.includes('/realtimePosition/') ? 'position' : 'arrival';
      const hit = active.entries.find((e) => e.kind === kind && e.target === target);
      const empty = kind === 'position' ? '{"realtimePositionList":[]}' : '{"realtimeArrivalList":[]}';
      return new Response(hit?.body ?? empty, { status: 200 });
    }) as unknown as typeof fetch,
  });

  const ticks: ProbeTick[] = [];
  for (const cap of captures) {
    active = cap;
    simNow = cap.cycleStartMs;
    const before = {
      pos: getSpy.mock.calls.filter((c) => String(c[0]) === 'realtime-position:2').length,
      ins: inserts.length,
    };
    const logs: string[] = [];
    await runScheduled(env, {
      seoul,
      apnsConfig,
      apnsHosts: { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' },
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => simNow,
      generatePushId: () => `pid-${simNow}`,
      archFlag: 'off',
      log: (message: string, meta?: Record<string, unknown>) => {
        if (LOG_PATTERN.test(message)) logs.push(`${message} ${JSON.stringify(meta)}`);
      },
    });
    const raw = (await kv.get(`trip:${token}`)) as string | null;
    const trip = raw ? (JSON.parse(raw) as Trip) : null;
    const d1: D1Row[] = inserts.slice(before.ins).flatMap((args) => {
      // trip_events INSERT만 (meta가 JSON 객체 문자열). 다른 테이블 INSERT는 제외.
      const meta = parseMeta(args[5]);
      return meta === null ? [] : [{ kind: String(args[2]), station: String(args[3]), meta }];
    });
    ticks.push({
      kst: new Date(simNow + KST_OFFSET_MS).toISOString().slice(11, 19),
      lock: trip?.boardingLock?.trainCode,
      miss: trip?.consecutiveEtaMissing,
      headStation: trip?.waypoints?.[0]?.stationName,
      position2Gets: getSpy.mock.calls.filter((c) => String(c[0]) === 'realtime-position:2').length - before.pos,
      logs,
      d1,
    });
  }
  getSpy.mockRestore();
  return ticks;
}
