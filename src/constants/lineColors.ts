import i18next from 'i18next';
import { LineNumber } from '../types/station';

export const LINE_COLORS: Record<LineNumber, string> = {
  '1': '#0052A4',
  '2': '#009D3E',
  '3': '#EF7C1C',
  '4': '#00A2D1',
  '5': '#996CAC',
  '6': '#CD7C2F',
  '7': '#747F00',
  '8': '#E6186C',
  '9': '#BDB092',
  airport: '#4B81BF',
  gyeongui: '#77C4A3',
  bundang: '#F5A200',
  sinbundang: '#D4003B',
};

// 현재 언어에 맞춰 노선 이름을 동적으로 조회. 기존 LINE_NAMES[line] 형태 사용처 호환.
// 정의되지 않은 키는 undefined를 반환해 호출부의 `?? fallback` 동작을 보존한다.
// ownKeys/getOwnPropertyDescriptor 트랩은 Object.keys/values/entries 순회 지원용.
export const LINE_NAMES = new Proxy({} as Record<LineNumber, string>, {
  get(_, prop: string) {
    if (!(prop in LINE_COLORS)) return undefined;
    return i18next.t(`lines.${prop}` as 'lines.1') as string;
  },
  ownKeys() {
    return Object.keys(LINE_COLORS);
  },
  getOwnPropertyDescriptor(_, prop: string) {
    if (!(prop in LINE_COLORS)) return undefined;
    return { enumerable: true, configurable: true, writable: false };
  },
});
