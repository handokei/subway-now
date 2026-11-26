/**
 * #3371: render-schematic-preview — layout JSON → SVG 문자열 변환 단위 테스트.
 */
const { renderSvg, lineColors } = require('../render-schematic-preview');

const layout = {
  bounds: { w: 200, h: 100 },
  nodes: {
    a: { x: 20, y: 20, name: '가&나', lines: ['1'], supported: true, label: { dx: 10, dy: 0, anchor: 'start' } },
    b: { x: 100, y: 60, name: '다', lines: ['1', '2'], supported: true, label: { dx: -10, dy: 0, anchor: 'end' } },
    c: { x: 180, y: 60, name: '라', lines: ['1'], supported: false, label: { dx: 0, dy: 12, anchor: 'middle' } },
  },
  edges: [
    { line: '1', from: 'a', to: 'b', points: [[100, 20]] },
    { line: '1', from: 'b', to: 'c' },
  ],
};

describe('render-schematic-preview', () => {
  it('lineColors: 노선별 첫 역의 lineColor', () => {
    expect(
      lineColors([
        { line: '1', lineColor: '#111' },
        { line: '1', lineColor: '#999' },
        { line: '2', lineColor: '#222' },
      ]),
    ).toEqual({ 1: '#111', 2: '#222' });
  });

  it('renderSvg: 선(꺾임점 포함)·원·라벨 출력, 미지원 구간·역은 회색, 환승 node는 큰 원', () => {
    const svg = renderSvg(layout, { 1: '#0052A4' });
    expect(svg).toContain('width="200" height="100"');
    expect(svg).toContain('points="20,20 100,20 100,60"');
    expect(svg).toContain('stroke="#0052A4"');
    expect(svg).toContain('stroke="#9AA0A6"');
    expect(svg).toContain('r="8"');
    expect(svg).toContain('r="5"');
    expect(svg).toContain('가&amp;나');
    expect(svg.match(/<circle/g)).toHaveLength(3);
  });
});
