/**
 * APNs 토큰 환경(sandbox / production) 판별.
 *
 * 빌드 환경별 기본값:
 * - `EXPO_PUBLIC_APNS_ENV`를 명시 설정 → 그 값을 신뢰
 * - 미설정 + `__DEV__` true → 'sandbox' (Expo dev client / development build)
 * - 미설정 + `__DEV__` false → 'sandbox' (preview/internal distribution도 sandbox 토큰을 받음)
 *
 * production은 반드시 EAS production profile에서 `EXPO_PUBLIC_APNS_ENV=production` 명시 필요.
 * 미설정 시 sandbox로 떨어지는 것이 안전 — production host로 sandbox 토큰을 보내면
 * BadDeviceToken으로 거부되어 trip이 즉시 삭제되기 때문.
 */
export function resolveApnsEnv(): 'sandbox' | 'production' {
  const raw = process.env.EXPO_PUBLIC_APNS_ENV;
  if (raw === 'production' || raw === 'sandbox') return raw;
  return 'sandbox';
}
