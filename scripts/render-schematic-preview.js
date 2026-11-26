#!/usr/bin/env node
/**
 * #3371 PR-1: schematicLayout.json → tasks/schematic-preview.svg (사람이 보고 overrides로 보정하는 용도).
 *
 * 사용: node scripts/render-schematic-preview.js   (커밋하지 않는 산출물 — PR 본문엔 생성 방법만 기재)
 * 노선 색은 stations.json lineColor, 앱에 없는 역(supported:false)은 회색, 환승 node는 큰 원.
 */
const fs = require('fs');
const path = require('path');
const { MIN_SPACING, NODE_RADIUS, LABEL_CHAR_W, LABEL_H } = require('./build-schematic-layout');

const LAYOUT_PATH = path.join(__dirname, '..', 'src', 'data', 'schematicLayout.json');
const STATIONS_PATH = path.join(__dirname, '..', 'src', 'data', 'stations.json');
const OUT_PATH = path.join(__dirname, '..', 'tasks', 'schematic-preview.svg');
const UNSUPPORTED_COLOR = '#9AA0A6';
const FONT_SIZE = LABEL_H - 3;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function lineColors(stations) {
  const colors = {};
  for (const { line, lineColor } of stations) if (!colors[line]) colors[line] = lineColor;
  return colors;
}

function renderSvg(layout, colors) {
  const { bounds, nodes, edges } = layout;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.w}" height="${bounds.h}" viewBox="0 0 ${bounds.w} ${bounds.h}" font-family="sans-serif" font-size="${FONT_SIZE}">`,
    `<rect width="100%" height="100%" fill="#F5F2EC"/>`,
  ];
  for (const { line, from, to, points } of edges) {
    const pts = [nodes[from], ...(points ?? []).map(([x, y]) => ({ x, y })), nodes[to]];
    const stroke = nodes[from].supported && nodes[to].supported ? colors[line] : UNSUPPORTED_COLOR;
    parts.push(
      `<polyline points="${pts.map(({ x, y }) => `${x},${y}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`,
    );
  }
  for (const { x, y, name, lines, supported, label } of Object.values(nodes)) {
    const r = lines.length > 1 ? NODE_RADIUS : NODE_RADIUS - 3;
    const stroke = supported ? '#222' : UNSUPPORTED_COLOR;
    parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" stroke="${stroke}" stroke-width="2"/>`);
    const textAnchor = label.anchor;
    const fill = supported ? '#222' : UNSUPPORTED_COLOR;
    parts.push(
      `<text x="${x + label.dx}" y="${y + label.dy}" text-anchor="${textAnchor}" dominant-baseline="central" fill="${fill}">${esc(name)}</text>`,
    );
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function main() {
  const layout = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf-8'));
  const colors = lineColors(JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf-8')));
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, renderSvg(layout, colors));
  console.log(`wrote ${OUT_PATH} (MIN_SPACING ${MIN_SPACING}, label char ${LABEL_CHAR_W}px)`);
}

if (require.main === module) main();

module.exports = { renderSvg, lineColors };
