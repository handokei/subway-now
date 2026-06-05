export type ExitSide = 'left' | 'right' | 'both';

export type TravelDirection = 'up' | 'down';

export interface ExitSideEntry {
  up?: ExitSide;
  down?: ExitSide;
}

export type ExitSideMap = Record<string, ExitSideEntry>;
