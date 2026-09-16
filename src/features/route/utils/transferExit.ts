import transferExitData from '../../../data/transferExit.json';
import type { TransferExitEntry, TransferExitMap } from '../types/transferExit';
import type { LineNumber } from '../../../shared/types/station';
import { normalizeStationName } from '../../../shared/utils/stationRoute';

const MAP = transferExitData as TransferExitMap;

export interface ResolveTransferDoorArgs {
  stationName: string;
  fromLine: LineNumber;
  toLine: LineNumber;
  // 진행방면 종착역명(예: "장암"). 분기 노선·도착 방면 변종에서 정확도를 올린다 — 선택.
  fromTerminal?: string;
  toTerminal?: string;
  // 2호선 등 순환선 진행방향(외선/내선). 같은 (fromLine, toLine)에 외선/내선 변종이 모두 있을 때
  // 잘못된 도어를 안내하지 않도록 사용. 미지정 + 변종 다수면 abstain(null) 반환.
  fromLoop?: '외선순환' | '내선순환';
  toLoop?: '외선순환' | '내선순환';
}

// 점수 가중치. fromTerminal/fromLoop은 진행 노선을 직접 결정하므로 toTerminal/toLoop보다 강하다.
const WEIGHT_FROM_TERMINAL = 4;
const WEIGHT_FROM_LOOP = 4;
const WEIGHT_TO_TERMINAL = 1;
const WEIGHT_TO_LOOP = 1;

// 한 (역, fromLine, toLine) 조합에 대해 가장 잘 맞는 빠른 환승 엔트리를 반환.
// - terminal/loop 일치 점수로 정렬 후 첫 매치 채택.
// - 후보가 fromLoop으로 갈리는데 caller가 fromLoop을 모르면 잘못 안내 위험이 있어 abstain.
// - 매칭 0건이면 null — caller(UI)는 라벨을 생략한다.
export function resolveTransferDoor(args: ResolveTransferDoorArgs): TransferExitEntry | null {
  let candidates = MAP[args.stationName];
  if (!candidates) {
    const normalized = normalizeStationName(args.stationName);
    const matched = Object.keys(MAP).find((k) => normalizeStationName(k) === normalized);
    if (!matched) return null;
    candidates = MAP[matched];
  }
  const filtered = candidates.filter(
    (c) => c.fromLine === args.fromLine && c.toLine === args.toLine,
  );
  if (filtered.length === 0) return null;
  // 순환선 가드: caller가 fromLoop을 안 줬는데 데이터에 외선/내선 변종이 둘 다 있으면
  // 잘못된 도어를 안내할 수 있다 — 안전 우선으로 라벨 미표시.
  if (!args.fromLoop) {
    const distinctFromLoops = new Set(
      filtered.map((c) => c.fromLoop).filter((v): v is '외선순환' | '내선순환' => Boolean(v)),
    );
    if (distinctFromLoops.size > 1) return null;
  }
  const scored = filtered.map((c) => {
    let score = 0;
    if (args.fromTerminal && c.fromTerminal === args.fromTerminal) score += WEIGHT_FROM_TERMINAL;
    if (args.fromLoop && c.fromLoop === args.fromLoop) score += WEIGHT_FROM_LOOP;
    if (args.toTerminal && c.toTerminal === args.toTerminal) score += WEIGHT_TO_TERMINAL;
    if (args.toLoop && c.toLoop === args.toLoop) score += WEIGHT_TO_LOOP;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].c;
}
