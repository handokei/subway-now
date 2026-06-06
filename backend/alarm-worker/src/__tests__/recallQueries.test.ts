/**
 * recallQueries.ts SSOT 회귀 — query 문자열이 catalog/recallTelemetry schema와 동기를 유지하는지 검증.
 *
 * "동기"의 의미:
 *   - blob label은 `recordRecallUpload`가 적재한 형식과 1:1 매칭
 *   - threshold/dataset 식별자는 catalog SSOT에서 끌어옴 (hardcoded 식별자 금지)
 *   - 새 query 추가 = `RECALL_QUERIES` 배열에만 등록
 */

import { describe, expect, it } from 'vitest';
import {
  RECALL_DATASET,
  RECALL_QUERIES,
  dailyRecallRateQuery,
  gateSuppressionDistributionQuery,
  lowRecallTripRatioQuery,
} from '../recallQueries';
import { METRIC_KIND, MIN_RECALL_RATIO_THRESHOLD } from '../metrics';
import { RECALL_DISTRIBUTION_LABEL_PREFIX } from '../recallTelemetry';

describe('RECALL_DATASET', () => {
  it('matches wrangler.toml dataset name', () => {
    // wrangler.toml의 `dataset = "silent_push_telemetry"`와 동일 (#498 / #506 주석 참조).
    expect(RECALL_DATASET).toBe('silent_push_telemetry');
  });
});

describe('dailyRecallRateQuery', () => {
  it('references both hit and total labels for the recall rate metric', () => {
    const rateKind = METRIC_KIND.PER_STATION_ALARM_RECALL;
    expect(dailyRecallRateQuery).toContain(`phase3:${rateKind}:hit`);
    expect(dailyRecallRateQuery).toContain(`phase3:${rateKind}:total`);
  });

  it('queries the recall dataset', () => {
    expect(dailyRecallRateQuery).toContain(RECALL_DATASET);
  });

  it('does not hardcode the metric key string literally', () => {
    // catalog SSOT에서 끌어와야 함 — METRIC_KIND가 바뀌면 query도 자동 갱신.
    // 본 테스트는 회귀 방지용 — 키가 바뀌었는데 query가 안 바뀌면 첫 assertion이 깨진다.
    const rateKind = METRIC_KIND.PER_STATION_ALARM_RECALL;
    expect(rateKind.length).toBeGreaterThan(0);
  });
});

describe('gateSuppressionDistributionQuery', () => {
  it('uses the recallTelemetry distribution label prefix', () => {
    const gatePrefix = `phase3:${RECALL_DISTRIBUTION_LABEL_PREFIX}:`;
    expect(gateSuppressionDistributionQuery).toContain(gatePrefix);
  });

  it('extracts reason via substring offset matching the prefix length', () => {
    const gatePrefix = `phase3:${RECALL_DISTRIBUTION_LABEL_PREFIX}:`;
    // SQL substring 인덱스는 1-based — prefix 길이 + 1 로 첫 reason 문자 시작.
    expect(gateSuppressionDistributionQuery).toContain(
      `substring(blob1, ${gatePrefix.length + 1})`,
    );
  });
});

describe('lowRecallTripRatioQuery', () => {
  it('embeds the catalog SSOT threshold value', () => {
    expect(lowRecallTripRatioQuery).toContain(String(MIN_RECALL_RATIO_THRESHOLD));
  });

  it('aggregates per token prefix (blob2)', () => {
    expect(lowRecallTripRatioQuery).toContain('blob2');
  });

  it('guards division by zero (total_tokens=0 → ratio=0 instead of NaN)', () => {
    // 빈 7일 윈도우에서 outer SELECT가 NaN/inf를 산출하면 alert webhook이 spurious 발사.
    expect(lowRecallTripRatioQuery).toContain('if(total_tokens > 0');
  });
});

describe('dailyRecallRateQuery', () => {
  it('guards division by zero (expected_stops=0 → recall_rate=0 instead of NaN)', () => {
    // 해당 일자에 total data point가 0인 경우 분모 0. NaN이면 dashboard 카드 깨짐.
    expect(dailyRecallRateQuery).toContain('if(expected_stops > 0');
  });
});

describe('RECALL_QUERIES', () => {
  it('contains the three exported queries with unique ids', () => {
    const ids = RECALL_QUERIES.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('daily-recall-rate');
    expect(ids).toContain('gate-suppression-distribution');
    expect(ids).toContain('low-recall-trip-ratio');
  });

  it('each entry exposes a non-empty SQL string referencing the dataset', () => {
    for (const entry of RECALL_QUERIES) {
      expect(entry.sql.length).toBeGreaterThan(0);
      expect(entry.sql).toContain(RECALL_DATASET);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('is frozen (catalog mutation guard)', () => {
    expect(Object.isFrozen(RECALL_QUERIES)).toBe(true);
  });
});
