/**
 * #3155 — 앵커역 출발 열차 조회 client.
 *
 * Backend `GET /trips/:tripToken/anchor-departures`: 현재 leg 앵커역을 최근 10분 내 출발한 같은 방향
 * 열차(최근 출발 순)와 각 열차의 현재 역. 목록의 "이미 출발" 섹션 원본이다.
 *
 * 어떤 실패(네트워크/5xx/404/형식 불일치/구버전 backend)에서도 throw하지 않고 null — 소비자는 null이면
 * 섹션을 그리지 않는다(기존 목록 100% 보존).
 */
import { instrumentBackendFetch } from '../../../shared/utils/instrumentBackendFetch';

export interface AnchorDepartureWireRow {
  trainCode: string;
  /** 출발 시각(epoch ms) — backend 관측 시각(해상도 ≈ cron 주기). */
  departedAt: number;
  /** 그 열차가 지금 있는 역. 피드에 없으면 null. */
  currentStation: string | null;
}

export interface AnchorDeparturesView {
  station: string;
  line: string;
  departed: AnchorDepartureWireRow[];
}

const REQUEST_TIMEOUT_MS = 5000;

function parseRow(raw: unknown): AnchorDepartureWireRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { trainCode, departedAt, currentStation } = raw as Record<string, unknown>;
  if (typeof trainCode !== 'string' || typeof departedAt !== 'number' || !Number.isFinite(departedAt)) {
    return null;
  }
  return {
    trainCode,
    departedAt,
    currentStation: typeof currentStation === 'string' ? currentStation : null,
  };
}

function parseView(body: unknown): AnchorDeparturesView | null {
  if (typeof body !== 'object' || body === null) return null;
  const { station, line, departed } = body as Record<string, unknown>;
  if (typeof station !== 'string' || typeof line !== 'string' || !Array.isArray(departed)) return null;
  const rows = departed.map(parseRow).filter((row): row is AnchorDepartureWireRow => row !== null);
  return { station, line, departed: rows };
}

export async function fetchAnchorDepartures(
  tripToken: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AnchorDeparturesView | null> {
  const url = `${baseUrl.replace(/\/$/, '')}/trips/${encodeURIComponent(tripToken)}/anchor-departures`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await instrumentBackendFetch(url, { method: 'GET', signal: controller.signal }, fetchImpl);
    if (!res.ok) return null;
    return parseView(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
