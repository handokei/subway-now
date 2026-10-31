import { calculateStaticEtaDetail, type Route } from '../../../shared/utils/stationRoute';
import { etaDisplayKind, formatFirstTrainTime, type EtaDisplayKind } from '../../../shared/utils/journeyTimeline';

/**
 * #1480 후속 — 경로 목록 칩·공유 문구의 소요 시간(대기 포함).
 *
 * 홈 상단 ETA와 같은 엔진(`journeyTimeline`, `calculateStaticEtaDetail`)으로 "지금 출발" 기준 총 분을 낸다.
 * 후보 정렬·선택에 쓰는 `RouteCandidate.travelMinutes`(주행+환승 도보)는 건드리지 않는다 — 표시 숫자만 대기를 포함한다.
 */
export interface ChipEta {
  minutes: number;
  kind: EtaDisplayKind;
  /** kind='lastTrainEnded'일 때 시간표 첫차 시각 — 있으면 "첫차 HH:mm"로 표시한다. */
  firstTrainAtMs?: number;
}

type TFunction = (key: string, options?: Record<string, unknown>) => string;

export function computeChipEta(route: NonNullable<Route>, nowMs: number, originStationId?: string): ChipEta {
  const detail = calculateStaticEtaDetail(route, { nowMs, originStationId });
  // route가 non-null이므로 detail은 항상 존재한다.
  const { minutes, firstTrainAtMs } = detail!;
  return { minutes, kind: etaDisplayKind(detail), firstTrainAtMs };
}

/** 칩 보조 라벨 — 홈 상단과 같은 i18n 키(`home.lastTrainEnded`)를 재사용한다. */
export function buildRouteChipLabel(t: TFunction, transferCount: number, eta: ChipEta): string {
  const { minutes: min, kind, firstTrainAtMs } = eta;
  if (kind === 'lastTrainEnded') {
    return firstTrainAtMs === undefined
      ? t('home.lastTrainEnded')
      : t('home.firstTrainAt', { time: formatFirstTrainTime(firstTrainAtMs) });
  }
  const suffix = kind === 'unknownWait' ? 'Plus' : '';
  return transferCount === 0
    ? t(`route.directOnly${suffix}`, { min })
    : t(`route.minutesAndTransfers${suffix}`, { min, count: transferCount });
}
