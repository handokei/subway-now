/**
 * #2667 — backend LA push 채널을 실제로 살리는 ambient 등록 훅.
 *
 * 문제(2026-09-16 실측): `laPushDelivery=0% (0/0)` — backend가 24시간 동안 LA push를 **한 건도**
 * 보내지 않았다. `fireLiveActivityUpdate`(backend)는 `trip.activityPushToken`이 없으면 no-op인데,
 * 그 값을 채우는 device 경로가 `startLiveActivityWithRegistration` 하나뿐이었고 **실제로 LA를
 * 띄우는 경로들은 그 함수를 쓰지 않는다**(pre-boarding 훅과 lock 이전 GPS 파이프라인은 깜빡임
 * 회피/트립 미등록 때문에 `updateLiveActivity`를 직접 호출한다). native는 어느 경로로 만들어지든
 * `pushType: .token`으로 Activity를 만들고 token을 emit하지만, 듣는 쪽이 없어 버려졌다.
 *
 * 이 훅은 LA 세션 소유권과 무관하게 앱 수명 동안 token emit을 듣고 현재 trip에 등록한다.
 * Activity를 시작/종료하지 않으므로 기존 LA lifecycle에 간섭하지 않는다(additive).
 *
 * `tripIntentKey`가 바뀌면 보관 중인 token을 현재 trip에 다시 등록한다 — LA가 trip 등록보다 먼저
 * 뜨는 순서에서도 채널이 비지 않도록. 이 훅은 trip token을 인자로 받지 않는다: 등록 시점의 권위는
 * `ACTIVE_TRIP_KEY`(AsyncStorage)이고, 그 값은 `useApnsTripRegistration`이 backend ack 후에야
 * 쓰기 때문에 렌더 상태로 들고 있는 값보다 이쪽이 항상 정확하다. 호출자는 "새 trip이 생겼을 수
 * 있는 시점"만 알려주면 되고(예: `destination.id`), 실제 token/trip 조합 판정과 재시도는
 * `liveActivityPushChannel`이 한다.
 *
 * iOS 전용 — 다른 플랫폼에서는 native 모듈 자체가 no-op subscription을 준다.
 */
import { useEffect } from 'react';
import { Platform } from 'react-native';
import {
  registerHeldLiveActivityTokenForCurrentTrip,
  startAmbientLiveActivityTokenRegistration,
} from '../utils/liveActivityPushChannel';

export function useLiveActivityTokenRegistration(tripIntentKey: string | null): void {
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    return startAmbientLiveActivityTokenRegistration();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    if (!tripIntentKey) return;
    registerHeldLiveActivityTokenForCurrentTrip();
  }, [tripIntentKey]);
}
