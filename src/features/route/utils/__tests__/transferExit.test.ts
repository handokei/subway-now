import { resolveTransferDoor } from '../transferExit';

jest.mock('../../../../data/transferExit.json', () => ({
  // 분기 노선·도착방면 변종 — 군자 5↔7 (실제 데이터 형태 모사).
  군자: [
    { fromLine: '5', toLine: '7', fromTerminal: '방화', toTerminal: '장암', doorNumber: '8-4' },
    { fromLine: '5', toLine: '7', fromTerminal: '방화', toTerminal: '석남', doorNumber: '1-1' },
    { fromLine: '5', toLine: '7', fromTerminal: '마천', toTerminal: '장암', doorNumber: '1-1' },
    { fromLine: '7', toLine: '5', fromTerminal: '장암', doorNumber: '5-1' },
  ],
  // 다중 toLine + fromTerminal 변종 — 공덕 5호선 → 6/airport/gyeongui.
  공덕: [
    { fromLine: '5', toLine: '6', fromTerminal: '방화', doorNumber: '1-1' },
    { fromLine: '5', toLine: 'airport', fromTerminal: '방화', doorNumber: '1-1' },
  ],
  // 순환선 변종 — 건대입구 2호선 외선/내선 → 7호선.
  건대입구: [
    { fromLine: '2', toLine: '7', fromLoop: '외선순환', fromTerminal: '성수', doorNumber: '8-3' },
    { fromLine: '2', toLine: '7', fromLoop: '내선순환', fromTerminal: '구의', doorNumber: '3-2' },
  ],
  // toLoop 매칭 점수 검증용 — 가상 환승역(2호선→2호선처럼 toLoop 정보가 직접 있는 데이터를 모사).
  '가상환승역': [
    { fromLine: '1', toLine: '2', toLoop: '외선순환', doorNumber: '5-5' },
    { fromLine: '1', toLine: '2', toLoop: '내선순환', doorNumber: '6-6' },
  ],
  // 정규화 fallback 검증 — 괄호 부제가 붙은 키.
  '잠실(송파구청)': [
    { fromLine: '2', toLine: '8', fromLoop: '내선순환', doorNumber: '4-3' },
  ],
}));

describe('resolveTransferDoor', () => {
  it('(fromLine, toLine) 매칭만 있으면 첫 row 반환', () => {
    const r = resolveTransferDoor({ stationName: '공덕', fromLine: '5', toLine: '6' });
    expect(r?.doorNumber).toBe('1-1');
  });

  it('fromTerminal 일치 row에 우선 점수가 붙어 best match가 선택된다', () => {
    const r = resolveTransferDoor({
      stationName: '군자', fromLine: '5', toLine: '7', fromTerminal: '마천',
    });
    expect(r?.doorNumber).toBe('1-1');
    expect(r?.fromTerminal).toBe('마천');
  });

  it('fromTerminal + toTerminal 모두 일치하면 점수 합산으로 정확한 row 선택', () => {
    const r = resolveTransferDoor({
      stationName: '군자', fromLine: '5', toLine: '7', fromTerminal: '방화', toTerminal: '석남',
    });
    expect(r?.doorNumber).toBe('1-1');
    expect(r?.toTerminal).toBe('석남');
  });

  it('terminal 입력이 어느 row와도 일치 안 하면 (fromLine, toLine) 후보 첫 row 반환', () => {
    const r = resolveTransferDoor({
      stationName: '군자', fromLine: '5', toLine: '7', fromTerminal: '없는방면',
    });
    expect(r?.doorNumber).toBe('8-4'); // 첫 row
  });

  it('toTerminal만 일치하는 케이스도 점수가 붙는다 (가중치 낮음)', () => {
    const r = resolveTransferDoor({
      stationName: '군자', fromLine: '5', toLine: '7', toTerminal: '석남',
    });
    expect(r?.toTerminal).toBe('석남');
  });

  it('역명이 정확 매칭 안 되면 normalize fallback (괄호 부제 무시)', () => {
    const r = resolveTransferDoor({ stationName: '잠실', fromLine: '2', toLine: '8' });
    expect(r?.doorNumber).toBe('4-3');
  });

  it('등록되지 않은 역은 null', () => {
    const r = resolveTransferDoor({ stationName: '없는역_xyz', fromLine: '5', toLine: '7' });
    expect(r).toBeNull();
  });

  it('등록은 됐지만 (fromLine, toLine) 후보가 없으면 null', () => {
    const r = resolveTransferDoor({ stationName: '공덕', fromLine: '5', toLine: '7' });
    expect(r).toBeNull();
  });

  describe('순환선 fromLoop 가드', () => {
    it('외선/내선 변종이 모두 존재하는데 fromLoop 미지정이면 abstain(null)', () => {
      const r = resolveTransferDoor({
        stationName: '건대입구',
        fromLine: '2',
        toLine: '7',
      });
      expect(r).toBeNull();
    });

    it('fromLoop 외선순환을 지정하면 해당 row 선택', () => {
      const r = resolveTransferDoor({
        stationName: '건대입구',
        fromLine: '2',
        toLine: '7',
        fromLoop: '외선순환',
      });
      expect(r?.doorNumber).toBe('8-3');
    });

    it('fromLoop 내선순환을 지정하면 해당 row 선택', () => {
      const r = resolveTransferDoor({
        stationName: '건대입구',
        fromLine: '2',
        toLine: '7',
        fromLoop: '내선순환',
      });
      expect(r?.doorNumber).toBe('3-2');
    });

    it('데이터에 loop 변종이 1종만 있으면 fromLoop 미지정으로도 정상 반환 (abstain 안 함)', () => {
      const r = resolveTransferDoor({ stationName: '잠실', fromLine: '2', toLine: '8' });
      expect(r?.doorNumber).toBe('4-3');
    });

    it('toLoop도 점수에 반영된다', () => {
      const r = resolveTransferDoor({
        stationName: '건대입구',
        fromLine: '2',
        toLine: '7',
        fromLoop: '외선순환',
        toLoop: '내선순환', // 데이터엔 toLoop 없으니 0점, fromLoop만 4점 — 정상 선택 유지
      });
      expect(r?.doorNumber).toBe('8-3');
    });

    it('toLoop 매칭으로 후보가 갈리는 케이스에서 가중치가 작동한다', () => {
      const r = resolveTransferDoor({
        stationName: '가상환승역',
        fromLine: '1',
        toLine: '2',
        toLoop: '내선순환',
      });
      expect(r?.doorNumber).toBe('6-6');
    });
  });
});
