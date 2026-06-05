/**
 * #807 — parseTrainLineDirection / buildDirectionMeta / getNextStationName 전 노선 fixture 회귀 가드.
 *
 * 실기기 트립에서 5호선(마천행/방화행) 방면 표기 누락이 보고됐고, 다른 노선도 전수 검증 안 됨.
 * 새 사양(#807):
 *   - UI에는 종착 대신 **다음 인접역 방면**만 노출 (`buildDirectionMeta(dest, next, ...) → "<next>방면"`)
 *   - `parseTrainLineDirection`은 nextStationLabel 미전달 경로의 종착 fallback에만 사용됨
 *
 * 노선별 종착역(첫/마지막 역)을 stations.json에서 데이터 주도로 추출해 라인 전체를 한 곳에 모아
 * 검증한다. 새 노선이 stations.json에 추가되면 해당 노선 fixture가 자동 포함된다.
 *
 * 중복 차단: 동일 패턴(라인별 정/역/전구간, ko/en fallback)은 it.each(scenario × line) 단일 루프로
 * 통합해 SonarCloud CPD를 회피한다.
 */

import i18next from 'i18next';

import stationsData from '../../../../data/stations.json';
import type { LineNumber, Station } from '../../../../shared/types/station';
import { buildDirectionMeta, parseTrainLineDirection } from '../trainLineDirection';
import { findRoute, getNextStationName, getStationsOnLine } from '../stationRoute';

const allStations = stationsData as Station[];

// stations.json에 실제 존재하는 라인을 데이터에서 추출 — 하드코딩 금지.
// 새 라인이 추가되면 fixture/검증이 자동 포함된다.
const LINES: readonly LineNumber[] = Array.from(
  new Set(allStations.map((s) => s.line)),
) as LineNumber[];

interface LineTerminals {
  line: LineNumber;
  first: Station;
  last: Station;
}

// 라인별 첫/마지막 역(종착 fixture) 계산. getStationsOnLine은 id 기준 정렬을 보장한다
// (stationRoute.test.ts 별도 describe에서 검증됨).
const lineTerminals: LineTerminals[] = LINES.map((line) => {
  const stations = getStationsOnLine(line);
  return { line, first: stations[0], last: stations[stations.length - 1] };
});

describe('#807 — buildDirectionMeta 전 노선 종착 라벨 → "<next>방면" 통일', () => {
  // 핵심 사양: 종착이 어떤 노선/표기든 nextStationLabel만 주어지면 "<next>방면"으로 통일.
  // 5호선 마천행/방화행 회귀의 정확한 가드.
  afterEach(async () => {
    await i18next.changeLanguage('ko');
  });

  describe('ko: 각 노선 종착 라벨 + 다음역 → "<next>방면"만', () => {
    it.each(lineTerminals)(
      '$line 노선: 마지막 종착 라벨로 진입해도 다음역방면만',
      async ({ first, last }) => {
        await i18next.changeLanguage('ko');
        // 양 종착 라벨 모두 nextStationLabel="중곡"이면 일관된 "중곡방면"
        expect(buildDirectionMeta(`${first.name}행`, '중곡', allStations)).toBe('중곡방면');
        expect(buildDirectionMeta(`${last.name}행`, '중곡', allStations)).toBe('중곡방면');
      },
    );
  });

  describe('5호선 회귀 가드 — 마천/방화 누락 차단', () => {
    // 실기기 보고 회귀의 핵심: 5호선 종착 표기에서 방면이 누락됐던 사례. 이제는 종착 표기 자체가
    // UI에 안 보이고 "<next>방면"만 노출 — 회귀 가능성 자체 제거.
    it.each([
      ['마천행', '중곡', '중곡방면'],
      ['방화행', '광화문', '광화문방면'],
      ['마천행', '광화문', '광화문방면'],
      ['방화행', '중곡', '중곡방면'],
    ])('destination="%s", next="%s" → "%s"', (destination, next, expected) => {
      expect(buildDirectionMeta(destination, next, allStations)).toBe(expected);
    });
  });

  describe('데이터에 없는 종착 표기(상일동/하남검단산 등)도 next만 살아남음', () => {
    // 운영상 들어오지만 stations.json에 미반영된 종착도 다음역방면만 표시되므로 영향 없음.
    it.each([
      ['상일동행'],
      ['하남검단산행'],
      ['신창행'],
      ['연천행'],
      ['석남행'],
      ['진접행'],
      ['별내행'],
      ['서동탄행'],
      ['병점행'],
    ])('"%s" + next="중곡" → "중곡방면"', (destination) => {
      expect(buildDirectionMeta(destination, '중곡', allStations)).toBe('중곡방면');
    });
  });

  describe('순환선: 종착 정보 없어도 다음역방면 OK', () => {
    it.each([
      ['내선순환', '신도림', '신도림방면'],
      ['외선순환', '신도림', '신도림방면'],
    ])('"%s" + next="%s" → "%s"', (destination, next, expected) => {
      expect(buildDirectionMeta(destination, next, allStations)).toBe(expected);
    });
  });

  describe('다국어 통일 — next 표기만 i18n 변환', () => {
    it.each<[LineNumber, 'en' | 'ja' | 'zh', string]>([
      ['1', 'en', 'via 다음역'],
      ['5', 'en', 'via 다음역'],
      ['7', 'ja', '다음역方面'],
      ['9', 'zh', '다음역方向'],
    ])('$line 노선 / lang=$1: terminal과 무관하게 next만 i18n 표기', async (line, lang, expected) => {
      await i18next.changeLanguage(lang);
      const { first, last } = lineTerminals.find((t) => t.line === line)!;
      expect(buildDirectionMeta(`${first.name}행`, '다음역', allStations)).toBe(expected);
      expect(buildDirectionMeta(`${last.name}행`, '다음역', allStations)).toBe(expected);
    });
  });
});

describe('#807 — parseTrainLineDirection (종착 fallback 경로) 전 노선 검증', () => {
  // buildDirectionMeta가 nextStationLabel 미전달 시 fallback으로 호출하는 경로 — 환승 list 등에서
  // 진행 방향 미정일 때 종착 텍스트는 노출되므로 i18n 정규화가 정상 동작해야 함.
  // ko/en을 (lang × line) 단일 it.each로 통합해 동일 어셈블리/어설션 블록 중복을 차단(CPD).
  afterEach(async () => {
    await i18next.changeLanguage('ko');
  });

  // expected 계산은 lang별 한 줄 분기. lang 추가 시 표만 확장하면 됨.
  function expectedTerminal(label: string, station: Station, lang: 'ko' | 'en'): string {
    if (lang === 'ko') return `${label}행`;
    const en = station.nameEn ?? station.name;
    return `Bound for ${en}`;
  }

  const langs = ['ko', 'en'] as const;
  const langLineCases = langs.flatMap((lang) =>
    lineTerminals.map((t) => ({ lang, ...t })),
  );

  it.each(langLineCases)(
    'lang=$lang / line=$line 첫·마지막 종착 라벨 i18n 정규화',
    async ({ lang, first, last }) => {
      await i18next.changeLanguage(lang);
      expect(parseTrainLineDirection(`${first.name}행`, allStations)).toBe(
        expectedTerminal(first.name, first, lang),
      );
      expect(parseTrainLineDirection(`${last.name}행`, allStations)).toBe(
        expectedTerminal(last.name, last, lang),
      );
    },
  );

  describe('신분당선 광교(경기대)행 — 괄호 별칭 종착', () => {
    it.each<['ko' | 'en', string]>([
      ['ko', '광교(경기대)행'],
      ['en', 'Bound for Gwanggyo'],
    ])('lang=%s → "%s"', async (lang, expected) => {
      await i18next.changeLanguage(lang);
      expect(parseTrainLineDirection('광교(경기대)행', allStations)).toBe(expected);
    });
  });
});

describe('#807 — getNextStationName 전 노선 DirectRoute fixture', () => {
  // 정방향(첫→두 번째), 역방향(마지막→끝에서 두 번째), 전 구간 트립(첫→마지막)을 한 it.each로
  // 통합. caseBuilder는 라인 stations에서 시나리오별 (from, to, expected)를 추출 — 중복 블록 제거.
  type Scenario = '정방향' | '역방향' | '전구간트립';
  const scenarios: Scenario[] = ['정방향', '역방향', '전구간트립'];

  function buildCase(line: LineNumber, scenario: Scenario): {
    from: Station;
    to: Station;
    expected: string;
  } {
    const stations = getStationsOnLine(line);
    const first = stations[0];
    const second = stations[1];
    const last = stations[stations.length - 1];
    const beforeLast = stations[stations.length - 2];
    if (scenario === '정방향') return { from: first, to: second, expected: second.name };
    if (scenario === '역방향') return { from: last, to: beforeLast, expected: beforeLast.name };
    // 전구간트립: 첫→마지막 트립의 첫 hop은 두 번째 역.
    return { from: first, to: last, expected: second.name };
  }

  const cases = scenarios.flatMap((scenario) =>
    lineTerminals.map((t) => ({ scenario, line: t.line })),
  );

  it.each(cases)('scenario=$scenario / line=$line', ({ scenario, line }) => {
    const { from, to, expected } = buildCase(line, scenario);
    const route = findRoute(from.id, to.id);
    expect(route).not.toBeNull();
    expect(getNextStationName(from.id, to.id, route)).toBe(expected);
  });
});
