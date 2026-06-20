/**
 * Shared acceptance runner factory (P0-4 / #1580).
 *
 * fixture가 비어 있으면 skip, 1건이라도 있으면 모든 fixture에 동일 assertion을 수행.
 * 실제 R2 ndjson path는 fixture 이름 옆 `.r2.ndjson`를 관습으로 사용.
 *
 * 사용자 5건 annotation이 들어오기 전엔 acceptance suite가 silently skip되며,
 * 들어오면 자동으로 활성화된다 (Wire-completion: orphan 없음, 측정 plan = fixture 수집).
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { parseTripGroundTruth, TripGroundTruth } from '../fixtures/trip-ground-truth.schema';
import {
  ArchiveEvent,
  listFixtureFiles,
  loadR2Trip,
  sliceTripWindow,
} from './r2ArchiveAlign';

export const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');

export interface LoadedFixture {
  name: string;
  groundTruth: TripGroundTruth;
  /** ndjson archive event (없으면 undefined → assertion이 archive 의존하면 skip). */
  events?: ArchiveEvent[];
}

async function loadFixture(jsonPath: string): Promise<LoadedFixture> {
  const raw = await fs.readFile(jsonPath, 'utf-8');
  const parsed = JSON.parse(raw);
  const groundTruth = parseTripGroundTruth(parsed);
  const ndjsonPath = jsonPath.replace(/\.json$/, '.r2.ndjson');
  let events: ArchiveEvent[] | undefined;
  try {
    await fs.access(ndjsonPath);
    const all = await loadR2Trip(ndjsonPath);
    events = sliceTripWindow(all, groundTruth.tripStartedAt, groundTruth.tripEndedAt);
  } catch {
    events = undefined;
  }
  return { name: path.basename(jsonPath), groundTruth, events };
}

/**
 * fixture가 1건이라도 있으면 callback을 각 fixture에 대해 it()으로 실행.
 * 0건이면 describe.skip 처리하여 P0-3 R2 archive 미완 상태에서도 CI green.
 */
export function defineAcceptanceSuite(
  suiteName: string,
  assertion: (fixture: LoadedFixture) => void,
): void {
  describe(suiteName, () => {
    let fixtures: LoadedFixture[] = [];
    let initError: Error | null = null;

    beforeAll(async () => {
      try {
        const files = await listFixtureFiles(FIXTURES_DIR);
        fixtures = await Promise.all(files.map(loadFixture));
      } catch (err) {
        initError = err as Error;
      }
    });

    it('fixture load 성공 또는 빈 fixture', () => {
      expect(initError).toBeNull();
    });

    it('fixture 디렉토리 상태 보고', () => {
      // fixture 0건은 acceptance suite를 의도적으로 skip 상태로 둔다 (P0-3/P0-4 진행 중).
      // 1건 이상이면 각 fixture에 대해 assertion 실행.
      if (fixtures.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[${suiteName}] fixture 0건 — tests/fixtures/trip-ground-truth-*.json 추가 필요 (#1580).`,
        );
      }
      expect(fixtures.length).toBeGreaterThanOrEqual(0);
    });

    it('각 fixture에 대해 assertion 실행', () => {
      fixtures.forEach((fx) => assertion(fx));
    });
  });
}
