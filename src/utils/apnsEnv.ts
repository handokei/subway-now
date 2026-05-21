/**
 * APNs 토큰 환경(sandbox / production) 판별 (#482).
 *
 * 정책:
 * - `EXPO_PUBLIC_APNS_ENV`가 'sandbox' 또는 'production'으로 명시되면 그 값을 신뢰
 * - 그 외(미설정/오타) → 'sandbox' fallback
 *
 * 이유: iOS는 dev/preview/internal distribution 빌드에 sandbox APNs 토큰을 발급하고,
 * 이를 production host로 보내면 `BadDeviceToken`(400)으로 거부된다. 'production'은
 * App Store/TestFlight 빌드에서만 의미가 있으므로, EAS production profile에서
 * `EXPO_PUBLIC_APNS_ENV=production`을 반드시 명시 설정해야 한다.
 */
export type ApnsEnv = 'sandbox' | 'production';

export function resolveApnsEnv(): ApnsEnv {
  const raw = process.env.EXPO_PUBLIC_APNS_ENV;
  if (raw === 'production' || raw === 'sandbox') return raw;
  return 'sandbox';
}
