/**
 * Seoul Open API arrival fetch + 메모리 캐싱.
 *
 * 폴링 최적화 원칙:
 * - station 이름 단위 dedup (같은 사이클 내 여러 트립이 같은 역을 봐도 1회만 호출)
 * - 15초 캐싱 (cron 주기 1분이지만 다음 주기 초반에 캐시가 살아있을 가능성은 낮음.
 *   동일 사이클 내 중복 호출 차단이 주 목적)
 */

import { canonicalLineName } from './lineAlias';

const UP_DIRECTION_VALUES = ['상행', '내선'] as const;
const SEOUL_API_TZ_OFFSET = '+09:00';
const MAX_RECPTN_DRIFT_SEC = 120;
const CACHE_TTL_MS = 15_000;
const ERROR_CACHE_TTL_MS = 5_000;

export interface ArrivalEntry {
  destination: string;
  arrivalSeconds: number;
  trainCode: string;
  /** "상행"/"내선" 인지 여부 */
  isUp: boolean;
  /** 노선명 (예: "지하철1호선") — Seoul API의 subwayNm */
  subwayNm: string;
  /**
   * 도착 코드 (Seoul API arvlCd, #409): 0:진입, 1:도착, 2:출발, 3:전역출발,
   * 4:전역진입, 5:전역도착, 99:운행중. 누락/파싱 실패 시 null.
   * ETA 예측 대신 실측 신호로 phase 판정하기 위한 핵심 필드.
   */
  arvlCd: number | null;
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

  constructor(private readonly options: FetchSeoulOptions) {}

  get stats(): { callCount: number; cacheSize: number; httpErrorCount: number } {
    return { callCount: this.callCount, cacheSize: this.cache.size, httpErrorCount: this.httpErrorCount };
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
    const url = `http://${this.options.host}/api/subway/${this.options.apiKey}/json/realtimePosition/0/100/${encodeURIComponent(lineName)}`;

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
      .map(parsePositionEntry)
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
    const url = `http://${this.options.host}/api/subway/${this.options.apiKey}/json/realtimeStationArrival/0/10/${encodeURIComponent(stationName)}`;

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

  return {
    destination: typeof item.trainLineNm === 'string' ? item.trainLineNm : '',
    arrivalSeconds: seconds,
    trainCode: typeof item.btrainNo === 'string' ? item.btrainNo : '',
    isUp,
    subwayNm: typeof item.subwayNm === 'string' ? item.subwayNm : '',
    arvlCd: parseArvlCd(item.arvlCd),
  };
}

function parsePositionEntry(raw: unknown): PositionEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const trainCode = typeof item.trainNo === 'string' ? item.trainNo : '';
  if (!trainCode) return null;
  const stationName = typeof item.statnNm === 'string' ? item.statnNm : '';
  const updnLine = typeof item.updnLine === 'string' ? item.updnLine : '';
  return {
    trainCode,
    stationName,
    trainSttus: parseArvlCd(item.trainSttus),
    isUp: (UP_DIRECTION_VALUES as readonly string[]).includes(updnLine),
    recptnMs: parseRecptnDt(item.lastRecptnDt),
  };
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
