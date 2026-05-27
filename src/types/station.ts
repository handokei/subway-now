export type LineNumber =
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'airport'
  | 'gyeongui'
  | 'bundang'
  | 'sinbundang';

export interface Station {
  id: string;
  name: string;
  nameEn?: string;
  nameJa?: string;
  nameHanja?: string;
  line: LineNumber;
  lineColor: string;
  lat: number;
  lng: number;
}

export interface FavoriteEntry {
  station: Station;
  label?: string;
}

export interface NearestStationResult {
  station: Station;
  distanceKm: number;
}

export interface NearestStationsResult {
  primary: Station;
  variants: Station[];
  distanceKm: number;
  isTransfer: boolean;
}
