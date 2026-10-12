/**
 * Seoul Open API arrival fetch + 메모리 캐싱.
 *
 * 폴링 최적화 원칙:
 * - station 이름 단위 dedup (같은 사이클 내 여러 트립이 같은 역을 봐도 1회만 호출)
 * - 15초 캐싱 (cron 주기 1분이지만 다음 주기 초반에 캐시가 살아있을 가능성은 낮음.
 *   동일 사이클 내 중복 호출 차단이 주 목적)
 */

import { canonicalLineName, lineNameBySubwayId } from './lineAlias';
import { fromSeoulStationName, toSeoulQueryName } from './seoulStationNameMap';
import {
  parseTrainType,
  parseTrainTypeFromDirectAt,
  type TrainType,
} from '../../../src/shared/constants/trainTypes';

const UP_DIRECTION_VALUES = ['상행', '내선'] as const;
/**
 * #2746 — `realtimePosition` 엔드포인트의 `updnLine`은 `realtimeStationArrival`(한글 '상행'/'하행')과
 * 달리 숫자 문자열이다. R2 실캡처(seoul-capture/2026-09-17/1789642190359.json) 대조로 확정:
 * 같은 trainCode(8387/2389/7355/7351/7353/3370/6604/7322/7320/7318, 10쌍 전수 일치)가 arrival에서
 * '외선'/'하행'이면 position에서는 항상 '1', arrival에서 '내선'/'상행'이면 position은 항상 '0'.
 * → '0'=상행/내선, '1'=하행/외선. 추정이 아니라 실측 대조 결과.
 */
const UP_POSITION_CODE = '0';
const DOWN_POSITION_CODE = '1';
const SEOUL_API_TZ_OFFSET = '+09:00';
const MAX_RECPTN_DRIFT_SEC = 120;
const CACHE_TTL_MS = 15_000;
const ERROR_CACHE_TTL_MS = 5_000;

/**
 * Seoul Open API endpoint path segment. `seoulCapture.ts`가 raw fetch URL을
 * arrival/position으로 분류할 때 이 상수를 소비한다 — URL 빌더와 분류 로직이
 * 별도 문자열 리터럴로 drift 나는 걸 방지 (#2579 리뷰).
 */
export const SEOUL_ARRIVAL_PATH_SEGMENT = 'realtimeStationArrival';
export const SEOUL_POSITION_PATH_SEGMENT = 'realtimePosition';

export interface ArrivalEntry {
  destination: string;
  arrivalSeconds: number;
  trainCode: string;
  /** "상행"/"내선" 인지 여부 */
  isUp: boolean;
  /**
   * 노선명 (예: "지하철1호선") — Seoul API의 subwayNm. #2355: 실 API는 이 필드를 null로
   * 보내는 경우가 있어(subwayId만 유효), 그런 경우 `subwayId`에서 역파생한 canonical
   * line name으로 대체된다 (`parseEntry` 참고) — 원본 raw subwayNm이 아닐 수 있다.
   */
  subwayNm: string;
  /**
   * #2355 — Seoul API `subwayId` (예: "1007" = 7호선). `subwayNm`이 null인 실 API shape에서
   * `lineNameBySubwayId`로 line을 복원하기 위해 파싱. optional — 구 caller/합성 entry
   * (`arrivalsFromPositions.ts`)/테스트 fixture가 이 필드 없이 리터럴을 구성해도 컴파일 호환
   * (#1720 `synthesized?`와 동일 정책).
   */
  subwayId?: string;
  /**
   * 도착 코드 (Seoul API arvlCd, #409): 0:진입, 1:도착, 2:출발, 3:전역출발,
   * 4:전역진입, 5:전역도착, 99:운행중. 누락/파싱 실패 시 null.
   * ETA 예측 대신 실측 신호로 phase 판정하기 위한 핵심 필드.
   */
  arvlCd: number | null;
  /**
   * #1720 — positions 합성 entry 표기. true 면 ADR-015 §3 signal B(arrival) 자격이 없어
   * consensusGate strongBE 통과 X. real Seoul API entry 는 undefined / false.
   */
  synthesized?: boolean;
  /**
   * #2328 (consensus-B, 설계 SSoT #2323) — Seoul API `btrainSttus`(열차종류) 파싱. 원래는
   * `legCandidateFilters.ts` 급행 정차 필터(④)의 입력이었으나, 그 필터는 caller(consensus-C,
   * #2329)에 끝내 배선되지 않은 채 생산자 0건으로 남아 #2765(게이트 전수감사 A)에서 제거됐고,
   * 파일 자체도 유일 caller였던 `tryFireConsensusTrainLeg` 제거로 #2766에서 삭제됐다. 이 필드는
   * 여전히 파싱은 되지만 현재 소비자가 없다(생산-후 미소비) — 정리는 후속 이슈(#2754 트랙) 범위.
   */
  trainType?: TrainType;
  /**
   * #2328 — Seoul API `trainLineNm`(행선지) 텍스트에서 추출한 순수 종착역명. 원래는
   * `legCandidateFilters.ts` 지선 필터(③)의 입력이었으나 위 trainType과 동일하게 미배선 상태로
   * #2765에서 필터가, #2766에서 그 파일 자체가 제거됐다. 이산 종점이 없는 순환선(내선/외선순환)
   * 또는 인식 불가 포맷은 null — 파싱은 유지되나 현재 소비자 없음(정리는 후속 이슈 범위).
   */
  terminus?: string | null;
}

export interface FetchSeoulOptions {
  apiKey: string;
  host: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

interface CacheEntry {
  expiresAt: number;
  data: ArrivalEntry[];
}

/** realtimePosition API의 1 train 항목 (#585 trainCode tracking). */
export interface PositionEntry {
  /** Seoul API trainNo / btrainNo (예: "7246") */
  trainCode: string;
  /** 현재 위치한 역명 */
  stationName: string;
  /** Seoul API trainSttus: 0:진입, 1:도착, 2:출발. `TRAIN_STATUS` 상수로 비교한다. 누락 시 null. */
  trainSttus: number | null;
  /** "상행"/"내선" 여부 */
  isUp: boolean;
  /** API 수신 시각 (epoch ms) — staleness 판정용. 누락 시 0. */
  recptnMs: number;
  /** #2328 — realtimePosition API `directAt`(1:급행, 7:특급) 파싱. ArrivalEntry.trainType과 동일 정책. */
  trainType?: TrainType;
  /** #2328 — realtimePosition API `statnTnm`(종착역명, 이미 순수 역명) 파싱. 누락/빈 문자열은 null. */
  terminus?: string | null;
}

interface PositionCacheEntry {
  expiresAt: number;
  data: PositionEntry[];
}

export class SeoulArrivalClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly positionCache = new Map<string, PositionCacheEntry>();
  private callCount = 0;
  /**
   * #1663 — HTTP-level error count (non-2xx response) across all fetch calls this instance.
   * Cron scope = one scheduled() invocation = one SeoulArrivalClient lifetime.
   * `httpErrorCount > 0` in `handleEtaMissing` signals Seoul API was unreachable this cycle,
   * not just that the specific trainCode disappeared.
   */
  private httpErrorCount = 0;
  /**
   * #2746 — `realtimePosition` 항목 중 `updnLine`이 '0'/'1' 어느 쪽으로도 해석 안 되는(누락·구
   * 한글값·그 외 미지 값) 항목 누적 카운트. 이런 항목은 방향 판정 오염을 막기 위해 결과에서
   * 제외되므로(parsePositionEntry가 null 반환), "조용히 false로 떨어뜨리는" 대신 이 카운터로
   * 관측 가능하게 남긴다.
   */
  private positionUnknownDirectionCount = 0;
  /**
   * #2751 — `realtimePosition` 항목 중 수신시각(`recptnDt`)이 누락되었거나 파싱 불가한 항목
   * 누적 카운트. `lastRecptnDt`는 날짜만('YYYYMMDD', 시각 없음)이라 수신시각으로 쓸 수 없고
   * `recptnDt`(공백구분 전체 타임스탬프)를 읽어야 한다(`parsePositionEntry`) — 그래도 값 자체가
   * 없거나 깨진 항목은 있을 수 있다. `positionUnknownDirectionCount`(#2746)와 달리 이 경우는
   * 항목을 결과에서 배제하지 않는다: `recptnMs=0`인 항목은 `boardingAnchorResolver.ts`의
   * 신선도 필터(`recptnMs > 0`)가 이미 걸러내므로 여기서 이중으로 제외할 필요가 없고,
   * stationName/isUp/trainSttus 등 나머지 필드는 여전히 유효해 다른 소비처(있다면)를 막을
   * 이유가 없다 — "조용히 0으로 떨어뜨리지 말 것"의 관측은 이 카운터가 담당한다.
   */
  private positionMissingRecptnCount = 0;

  constructor(private readonly options: FetchSeoulOptions) {}

  get stats(): {
    callCount: number;
    cacheSize: number;
    httpErrorCount: number;
    positionUnknownDirectionCount: number;
    positionMissingRecptnCount: number;
  } {
    return {
      callCount: this.callCount,
      cacheSize: this.cache.size,
      httpErrorCount: this.httpErrorCount,
      positionUnknownDirectionCount: this.positionUnknownDirectionCount,
      positionMissingRecptnCount: this.positionMissingRecptnCount,
    };
  }

  /**
   * realtimePosition(line) — 노선에 운행 중인 모든 열차 위치 (#585).
   * 노선당 1 call로 trainCode 단위 추적이 가능하다.
   * 캐시: 노선명 단위 15s (사이클 내 중복 호출 차단). 매핑 없는 line은 빈 배열.
   */
  async fetchPositions(line: string): Promise<PositionEntry[]> {
    const lineName = canonicalLineName(line);
    if (!lineName) return [];

    const now = this.options.now?.() ?? Date.now();
    const cached = this.positionCache.get(lineName);
    if (cached && cached.expiresAt > now) return cached.data;

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = `http://${this.options.host}/api/subway/${this.options.apiKey}/json/${SEOUL_POSITION_PATH_SEGMENT}/0/100/${encodeURIComponent(lineName)}`;

    this.callCount += 1;
    const response = await fetchImpl(url);
    if (!response.ok) {
      this.httpErrorCount += 1;
      this.positionCache.set(lineName, { expiresAt: now + ERROR_CACHE_TTL_MS, data: [] });
      return [];
    }

    const data = (await response.json()) as { realtimePositionList?: unknown[] };
    const items = Array.isArray(data.realtimePositionList) ? data.realtimePositionList : [];
    const parsed = items
      .map((raw) =>
        parsePositionEntry(
          raw,
          () => (this.positionUnknownDirectionCount += 1),
          () => (this.positionMissingRecptnCount += 1),
        ),
      )
      .filter((e): e is PositionEntry => e !== null);

    this.positionCache.set(lineName, { expiresAt: now + CACHE_TTL_MS, data: parsed });
    return parsed;
  }

  async fetchArrivals(stationName: string): Promise<ArrivalEntry[]> {
    const now = this.options.now?.() ?? Date.now();
    const cached = this.cache.get(stationName);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    // #2868 — stations.json 역명이 Seoul API 정식 질의명과 다른 35역. 캐시 키는 호출자가
    // 쓰는 stations.json 원명을 유지(위 cache.get/set)하고, URL 생성 직전에만 질의명으로 치환.
    const queryName = toSeoulQueryName(stationName);
    const url = `http://${this.options.host}/api/subway/${this.options.apiKey}/json/${SEOUL_ARRIVAL_PATH_SEGMENT}/0/10/${encodeURIComponent(queryName)}`;

    this.callCount += 1;
    const response = await fetchImpl(url);
    if (!response.ok) {
      // 실패 시 빈 배열을 짧게 캐시해 폭주 방지
      this.httpErrorCount += 1;
      this.cache.set(stationName, { expiresAt: now + ERROR_CACHE_TTL_MS, data: [] });
      return [];
    }

    const data = (await response.json()) as { realtimeArrivalList?: unknown[] };
    const items = Array.isArray(data.realtimeArrivalList) ? data.realtimeArrivalList : [];
    const parsed = items
      .map((raw) => parseEntry(raw, now))
      .filter((entry): entry is ArrivalEntry => entry !== null);

    this.cache.set(stationName, { expiresAt: now + CACHE_TTL_MS, data: parsed });
    return parsed;
  }
}

function parseEntry(raw: unknown, now: number): ArrivalEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;

  const rawSeconds = Math.max(0, Number(item.barvlDt ?? 0) || 0);
  const parsedRecvMs = parseRecptnDt(item.recptnDt);
  const rawDriftSec = parsedRecvMs > 0 ? (now - parsedRecvMs) / 1000 : 0;
  const isStale = parsedRecvMs > 0 && rawDriftSec > MAX_RECPTN_DRIFT_SEC;
  const driftSec = isStale ? 0 : Math.max(0, rawDriftSec);
  const seconds = Math.max(0, Math.round(rawSeconds - driftSec));

  const updnLine = typeof item.updnLine === 'string' ? item.updnLine : '';
  const isUp = (UP_DIRECTION_VALUES as readonly string[]).includes(updnLine);

  const trainLineNm = typeof item.trainLineNm === 'string' ? item.trainLineNm : '';
  const subwayId = typeof item.subwayId === 'string' ? item.subwayId : '';
  // #2355 — 실 Seoul API는 subwayNm=null, subwayId만 보낸다. subwayNm 부재 시 subwayId에서
  // canonical line name을 역파생 — matchLine('', line)이 전량 false로 떨어져 arrival pool이
  // 통째로 비는 회귀 차단.
  const rawSubwayNm = typeof item.subwayNm === 'string' ? item.subwayNm : '';
  const subwayNm = rawSubwayNm || (canonicalLineName(lineNameBySubwayId(subwayId) ?? '') ?? '');

  return {
    destination: trainLineNm,
    arrivalSeconds: seconds,
    trainCode: typeof item.btrainNo === 'string' ? item.btrainNo : '',
    isUp,
    subwayNm,
    subwayId,
    arvlCd: parseArvlCd(item.arvlCd),
    trainType: parseTrainType(item.btrainSttus),
    terminus: parseTerminusFromBstatnNm(item.bstatnNm),
  };
}

/**
 * #2953 — Seoul API `realtimeStationArrival`의 `bstatnNm`(종착역명, 이미 순수 역명)에서
 * terminus를 가져온다. 구 `parseTerminusStationName`은 `trainLineNm`(행선지 텍스트)을
 * `"X행"`/`"Y방면"` 단독 포맷으로 가정했으나, 실 API는 `"{종착}행 - {다음정차역}방면 [(급행)]"`
 * 복합 포맷으로 응답한다(실측 R2 캡처 1,252건/100% 복합, 이슈 #2953 본문) — 그 가정이 깨져
 * ①`trainLineNm`을 그대로 노출하거나 ②다음정차역을 종착으로 오인하거나 ③급행 접미사가 붙으면
 * null로 식별 정보가 통째로 소실되는 3중 버그를 냈다. `bstatnNm`은 같은 응답의 옆 필드에서
 * 복합 포맷 영향 없이 순수 종착역명을 준다(실측 R2 캡처 1,252건 중 빈 값 0건, distinct 17종
 * 전수 순수 역명, 급행 포함).
 *
 * - `fromSeoulStationName`으로 역명 경계 번역을 적용한다(#2868 정책 — "번역은 이 seoul.ts
 *   경계에서만"). 예: `'뚝섬유원지'` → `'자양(뚝섬한강공원)'`.
 * - `bstatnNm` 부재/빈 문자열은 null.
 *
 * 역명 존재 판정은 **`stations.json` 조회로 하지 않는다** (초안에서 시도했다가 폐기 —
 * `stations.json`이 최근 연장 종점 61역을 반영하지 않은 stale 데이터셋이라는 전수 census가
 * 같은 날 확정됐다(#2954). `stations.json`에 없는 역명을 null로 떨어뜨리면 석남/불암산/
 * 하남검단산 같은 **실존** 종착역까지 오탈락한다 — 이슈 #2953 본문이 애초에 제시했던 판정
 * 기준이었으나 이 모순으로 폐기됐다. 이 함수의 표시 목적은 공식 종착역명의 passthrough이며,
 * 역이 우리 데이터에 없어도 라벨 자체는 정확하고 유용하다. **역 보강은 좌표 데이터 부재로
 * 별도 차단 중(#2954)** — 그 작업과 독립적이어야 하므로 여기서 재도입하지 말 것).
 *
 * 대신 구 `parseTerminusStationName` 주석에 문서화돼 있던 불변식("순환선은 이산 종점이 없어
 * null", #2328)을 일반화한다 —
 * 실 데이터에 `"내선순환"`/`"외선순환"` 외 제3의 형태가 있다: `bstatnNm='응암순환(상선)'`
 * (실 API 직접 확인, trainLineNm='응암순환(상선)행 - 대흥(서강대앞)방면'). 종착역명에 `순환`이
 * 포함되면 이산 종점이 아니므로 null — 리터럴 화이트리스트가 아니라 도메인 불변식이라 "하드코딩
 * 금지/데이터 주도" 원칙 위배가 아니다. 안전성: `stations.json`에 `순환`/`상선`/`하선` 포함
 * 역명 0건(실존 역 오탐 불가), 실캡처 `bstatnNm` 중 `순환` 포함은 `응암순환(상선)` 10건(0.8%)이
 * 전부이고 나머지 distinct 16종은 전부 순수 역명.
 */
function parseTerminusFromBstatnNm(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.includes('순환')) return null;
  return fromSeoulStationName(trimmed);
}

function parsePositionEntry(
  raw: unknown,
  onUnknownDirection: () => void,
  onMissingRecptn: () => void,
): PositionEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const trainCode = typeof item.trainNo === 'string' ? item.trainNo : '';
  if (!trainCode) return null;
  const rawStationName = typeof item.statnNm === 'string' ? item.statnNm : '';
  // #2868 — statnNm에 ①sentinel(…종착/…지선) strip ②Seoul 응답명→stations.json명 역매핑을
  // 적용한다. 번역은 이 seoul.ts 경계에서만 — 내부 소비자(segmentStations/waypoint 비교)는
  // stations.json명 일관 사용.
  const stationName = fromSeoulStationName(stripPositionStationSentinel(rawStationName));
  const updnLine = typeof item.updnLine === 'string' ? item.updnLine : '';
  // #2746 — realtimePosition의 updnLine은 숫자 코드('0'=상행/내선, '1'=하행/외선)다.
  // 그 외 값(누락·구 한글 오염값 등)은 방향을 알 수 없으므로 조용히 false로 떨어뜨리지 않고
  // 항목 자체를 제외한다 — 관측은 onUnknownDirection() 카운터로.
  let isUp: boolean;
  if (updnLine === UP_POSITION_CODE) {
    isUp = true;
  } else if (updnLine === DOWN_POSITION_CODE) {
    isUp = false;
  } else {
    onUnknownDirection();
    return null;
  }
  const statnTnm = typeof item.statnTnm === 'string' ? item.statnTnm.trim() : '';
  // #2751 — `lastRecptnDt`는 날짜만('YYYYMMDD', 시각 없음)이라 수신시각으로 쓸 수 없다.
  // `recptnDt`(arrival과 동일 포맷, 공백구분 전체 타임스탬프)가 실제 수신시각 필드다.
  const recptnMs = parseRecptnDt(item.recptnDt);
  if (recptnMs === 0) onMissingRecptn();
  return {
    trainCode,
    stationName,
    trainSttus: parseArvlCd(item.trainSttus),
    isUp,
    recptnMs,
    trainType: parseTrainTypeFromDirectAt(item.directAt),
    terminus: statnTnm.length > 0 ? statnTnm : null,
  };
}

/**
 * #2868 — `realtimePosition`의 `statnNm`은 종착/지선 진입 열차에 역명 아닌 상태 문자열을
 * 담는다(10/3 실측: 열차 3174 statnNm='성수종착', R2 캡처 어휘에 '성수지선'도 존재).
 * 접미 strip으로 역명을 복원 — strip 결과가 빈 문자열이 되는 경우(접미 자체가 전체 문자열)는
 * 원문을 보존한다.
 */
const POSITION_STATION_SENTINEL_SUFFIXES = ['종착', '지선'] as const;

function stripPositionStationSentinel(statnNm: string): string {
  for (const suffix of POSITION_STATION_SENTINEL_SUFFIXES) {
    if (statnNm.endsWith(suffix) && statnNm.length > suffix.length) {
      return statnNm.slice(0, -suffix.length);
    }
  }
  return statnNm;
}

/** Seoul API는 arvlCd를 number 또는 numeric string으로 반환 — 둘 다 수용. */
function parseArvlCd(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseRecptnDt(recptnDt: unknown): number {
  if (typeof recptnDt !== 'string' || recptnDt.length === 0) return 0;
  const ms = Date.parse(recptnDt.replace(' ', 'T') + SEOUL_API_TZ_OFFSET);
  return Number.isFinite(ms) ? ms : 0;
}
