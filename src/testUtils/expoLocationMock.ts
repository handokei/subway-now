/**
 * expo-location의 정적 enum(module-load 시점에 읽히는 값)에 대한 단일 출처(SSoT).
 *
 * `src/shared/constants/locationTracking.ts` 같은 모듈은 top-level `const`에서
 * `Location.Accuracy.High` / `Location.LocationActivityType.AutomotiveNavigation`을
 * 즉시 평가한다. 테스트가 `jest.mock('expo-location', () => ({}))`처럼 빈 객체로
 * mock하면 이 모듈을 import만 해도(직접 호출 없이) `undefined.High` 접근으로
 * 테스트 스위트 자체가 실행 실패한다(#2354 회귀).
 *
 * 값은 `node_modules/expo-location/build/Location.types.d.ts`의 실제 enum과 동일하게
 * 맞춘다(매직 넘버 금지). 함수형 API(getCurrentPositionAsync 등)는 테스트마다 동작이
 * 다르므로 여기서 stub하지 않는다 — 각 테스트가 필요한 함수만 개별 mock한다.
 */
export const expoLocationEnumMock = {
  Accuracy: {
    Lowest: 1,
    Low: 2,
    Balanced: 3,
    High: 4,
    Highest: 5,
    BestForNavigation: 6,
  },
  LocationActivityType: {
    Other: 1,
    AutomotiveNavigation: 2,
    Fitness: 3,
    OtherNavigation: 4,
    Airborne: 5,
  },
} as const;
