// STUB (red commit) — 구현은 다음 커밋.
export const D1_KV_PROBE_ENABLED = true;
export const PROBE_HTTP_SAMPLE_RATE = 0.05;
export const PROBE_HTTP_DAILY_CAP = 100;
export type ProbeSource = 'cron' | 'http';
export interface ProbeEnv {
  DB?: D1Database;
  TRIPS: KVNamespace;
}
export function isCronProbeTick(_scheduledTime: number): boolean {
  return false;
}
export async function recordLatencyProbe(
  _env: ProbeEnv,
  _source: ProbeSource,
  _colo: string,
): Promise<void> {}
export async function runHttpProbe(
  _env: ProbeEnv,
  _colo: string,
  _now: number,
  _random: number,
  _enabled: boolean = D1_KV_PROBE_ENABLED,
): Promise<void> {}
export async function fetchCronColo(_fetchImpl: typeof fetch = fetch): Promise<string> {
  return 'unknown';
}
export function scheduleCronProbe(
  _env: ProbeEnv,
  _ctx: ExecutionContext,
  _scheduledTime: number,
  _enabled: boolean = D1_KV_PROBE_ENABLED,
): void {}
