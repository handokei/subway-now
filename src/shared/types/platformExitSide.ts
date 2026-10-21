// 승강장 구조 기반 하차문 방향 (#3129).
//
//   열차 주행방향(우측통행) 기준: 상대식 → right, 섬식 → left. 좌측통행 노선은 반전.
//   근거가 없는 역(공식 형식 불일치·복합·단선·미수록, 주행방향 미검증)은 키 자체를 생략한다.
//   'both'는 존재하지 않는다 — 종착역·복합식도 방향마다 한쪽 문만 열린다.
//
// 이 SSOT는 진행 방향(up/down)과 무관한 정적 데이터다.
// 방향별 fine-grained 정보는 src/data/exitSide.json (사용자 검수형) 및
// src/data/platformExitSideByDirection.json (인용 출처가 있는 방향별 override) 참조.
export type PlatformExitSide = 'left' | 'right';

// 항목의 신뢰 출처. 알림 레이어가 표시 여부를 결정할 때 사용한다.
//   official-derived: 서울교통공사 공식 역사심도정보 + 건축정보 일치 형식에서 도출
export type PlatformExitSideGrade = 'official-derived';

export interface PlatformExitSideEntry {
  side: PlatformExitSide;
  grade: PlatformExitSideGrade;
}

// station id → entry 맵. 매핑이 없는 역은 키 자체가 없다 (helper가 null 반환).
export type PlatformExitSideMap = Record<string, PlatformExitSideEntry>;

// 방향별(up/down) 하차문 override 항목. 인용 가능한 문장이 있는 방향만 수록한다(비공식 wiki 등급).
// sourceUrl은 ko.wikipedia 또는 나무위키 문서, note에 인용·한계를 남긴다.
export interface DirectionalExitSideEntry {
  up: PlatformExitSide;
  down: PlatformExitSide;
  grade: 'wiki';
  sourceUrl: string;
  note: string;
}

export type DirectionalExitSideMap = Record<string, DirectionalExitSideEntry>;
