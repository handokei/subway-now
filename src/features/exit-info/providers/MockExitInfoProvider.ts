import type { LineNumber } from '../../../shared/types/station';
import type { ExitInfo } from '../../../shared/types/exitInfo';
import type { ExitInfoProvider } from './types';
import sampleData from '../../../data/exit-info-sample.json';

interface SampleEntry {
  stationName: string;
  line: string;
  exitNumber: string;
  facilities: string[];
  nearby?: string;
}

interface SampleFile {
  exits: SampleEntry[];
}

/**
 * 개발/테스트용 mock provider. `src/data/exit-info-sample.json`을 in-memory 인덱싱.
 *
 * 실 API(SeoulOdExitInfoProvider) 키 발급 전에도 hook/UI 개발이 가능하도록 한다.
 */
export class MockExitInfoProvider implements ExitInfoProvider {
  private readonly entries: ExitInfo[];

  constructor(data: SampleFile = sampleData as SampleFile) {
    this.entries = data.exits.map((entry) => ({
      stationName: entry.stationName,
      line: entry.line as LineNumber,
      exitNumber: entry.exitNumber,
      facilities: entry.facilities,
      nearby: entry.nearby,
    }));
  }

  async getExits(stationName: string, line: LineNumber): Promise<ExitInfo[]> {
    return this.entries.filter(
      (entry) => entry.stationName === stationName && entry.line === line,
    );
  }
}
