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

export const LINE_NAMES: Record<LineNumber, string> = {
  '1': '1호선',
  '2': '2호선',
  '3': '3호선',
  '4': '4호선',
  '5': '5호선',
  '6': '6호선',
  '7': '7호선',
  '8': '8호선',
  '9': '9호선',
  airport: '공항철도',
  gyeongui: '경의중앙선',
  bundang: '분당선',
  sinbundang: '신분당선',
};
