/**
 * APNs host 선택 정책 (#482) — scheduled.ts와 liveActivity.ts가 공유하는 SSOT.
 *
 * - 누락된 apnsEnv는 sandbox로 fallback. 구버전 클라이언트(필드 없음)가 production host로
 *   잘못 보내져 BadDeviceToken을 받는 회귀를 막기 위함. App Store/TestFlight 빌드는
 *   반드시 명시적으로 'production'을 보내야 한다.
 * - `flipApnsEnv`는 self-heal에서 1차 host와 반대 host로 retry할 때 사용. undefined는
 *   sandbox로 시작했으므로 production으로 뒤집는다.
 */

import type { ApnsEnv } from './types';

export function pickApnsHost(apnsEnv: ApnsEnv | undefined, hosts: Record<ApnsEnv, string>): string {
  return hosts[apnsEnv ?? 'sandbox'];
}

export function flipApnsEnv(env: ApnsEnv | undefined): ApnsEnv {
  return (env ?? 'sandbox') === 'sandbox' ? 'production' : 'sandbox';
}
