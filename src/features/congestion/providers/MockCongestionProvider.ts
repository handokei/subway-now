import type { CongestionProvider } from './types';
import type { LineNumber } from '../../../shared/types/station';
import type {
  CongestionDirection,
  CongestionEntry,
} from '../../../shared/types/congestion';
import { classifyCongestion } from '../utils/congestionLevel';
import { toDayType, toTimeSlot } from '../utils/timeSlot';
import sampleData from '../../../data/congestion-sample.json';

interface RawEntry {
  line: LineNumber;
  stationName: string;
  direction: CongestionDirection;
  dayType: CongestionEntry['dayType'];
  timeSlot: string;
  raw: number;
}

const RAW_ENTRIES: readonly RawEntry[] = sampleData.entries as RawEntry[];

/**
 * `src/data/congestion-sample.json` fixture 기반 mock provider.
 *
 * PoC 단계: 실제 서울 OD API 키를 발급받기 전까지 lookup 인터페이스를 hook/UI에서
 * 사용할 수 있게 하는 결정적 구현. 후속 PR에서 SeoulOdCongestionProvider가 실 API를
 * 호출하면 factory로 교체한다.
 */
export class MockCongestionProvider implements CongestionProvider {
  getCongestion(
    stationName: string,
    line: LineNumber,
    direction: CongestionDirection,
    now: Date,
  ): CongestionEntry | null {
    const timeSlot = toTimeSlot(now);
    const dayType = toDayType(now);
    const match = RAW_ENTRIES.find(
      (entry) =>
        entry.line === line &&
        entry.stationName === stationName &&
        entry.direction === direction &&
        entry.dayType === dayType &&
        entry.timeSlot === timeSlot,
    );
    if (!match) return null;
    return {
      line: match.line,
      stationName: match.stationName,
      direction: match.direction,
      dayType: match.dayType,
      timeSlot: match.timeSlot,
      raw: match.raw,
      level: classifyCongestion(match.raw),
    };
  }
}
