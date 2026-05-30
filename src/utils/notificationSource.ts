import type { FusionSource } from './pickFusedStation';

/**
 * 사용자에게 노출되는 데이터 출처 그룹 (#327 Phase B).
 * FusionSource 5종을 4그룹으로 묶어 라벨/색에 일관되게 사용한다.
 *
 * - positionTrain: 열차 데이터 기반 (position-train / position / arrival)
 * - routeProgress: 경로 진행 추정
 * - gpsOnly: GPS 거리 기반 추정
 * - uncertain: 위치 확인 중 (locationUncertain 우선)
 */
export type NotificationSource =
  | 'positionTrain'
  | 'routeProgress'
  | 'gpsOnly'
  | 'uncertain';

/**
 * FusionSource + locationUncertain → 사용자 노출 그룹 매핑.
 * locationUncertain은 source를 덮어쓴다(가장 약한 신뢰도가 우선).
 */
export function resolveNotificationSource(
  source: FusionSource,
  locationUncertain: boolean = false,
): NotificationSource {
  if (locationUncertain) return 'uncertain';
  switch (source) {
    case 'boarding-lock':
    case 'boarding-lock-interp':
    case 'position-train':
    case 'position':
    case 'arrival':
      return 'positionTrain';
    case 'route-progress':
      return 'routeProgress';
    case 'gps':
      return 'gpsOnly';
    /* istanbul ignore next -- FusionSource 유니온이 위 case와 동기화되므로 도달 불가. 새 값 추가 시 컴파일 타임에 잡힘 */
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

export type SourceI18nKey = `source.${NotificationSource}`;

/**
 * i18n 키 prefix. caller가 t(notificationSourceI18nKey(key)) 형태로 사용.
 * 반환 타입을 template literal union으로 좁혀 i18next strict 타입에 통과시킨다.
 */
export function notificationSourceI18nKey(key: NotificationSource): SourceI18nKey {
  return `source.${key}`;
}

/**
 * 사용자에게 자백이 의미 있는 source만 true (#327 UX 정책).
 * positionTrain/routeProgress는 일상적 정상 상태라 라벨이 노이즈 → 표시 생략.
 * gpsOnly/uncertain은 신뢰도가 낮아 사용자가 의심해야 하므로 표시.
 *
 * 모든 표면(SourceBadge / 알람 본문 suffix / LA sourceLabel)에서 이 룰을 공유한다.
 */
export function shouldDiscloseNotificationSource(key: NotificationSource): boolean {
  return key === 'gpsOnly' || key === 'uncertain';
}
