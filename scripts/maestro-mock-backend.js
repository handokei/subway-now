#!/usr/bin/env node
/**
 * Maestro 회귀 테스트용 mock backend HTTP 서버 (#922).
 *
 * 2026-06-05에 발견된 4건의 실기기 알람 회귀(Seam B/C/E/F)는 단위 테스트로 잡았으나
 * 실기기 재현 경로가 없어 다시 깨지기 쉽다. 본 서버가 BFF arrival + alarm-worker
 * register/clear endpoint를 mock하면 Maestro flow가 시뮬레이터 GPS만으로 회귀 시나리오를
 * 재생해 검증할 수 있다.
 *
 * 첫 PR은 Seam B 1개 시나리오만 지원하지만, scenario fixture(JSON)를 추가하기만 하면
 * 나머지 3개(C/E/F) 시나리오도 동일 인터페이스로 수용 가능하도록 fixture-driven 구조를
 * 유지한다.
 *
 * 사용:
 *   SCENARIO=seam-b-13-19 PORT=8788 node scripts/maestro-mock-backend.js
 *
 * 환경 변수:
 *   - SCENARIO  : scripts/fixtures/regression/<name>.json 의 파일명(확장자 제외)
 *   - PORT      : HTTP 포트 (기본 8788)
 *
 * 앱은
 *   EXPO_PUBLIC_USE_BFF=true
 *   EXPO_PUBLIC_BFF_URL=http://localhost:8788
 *   EXPO_PUBLIC_ALARM_BACKEND_URL=http://localhost:8788
 * 로 빌드한다.
 *
 * fixture 스키마는 .maestro/flows/regression/README.md 참고.
 */
const { createServer } = require('node:http');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const PORT = Number(process.env.PORT || 8788);
const SCENARIO = process.env.SCENARIO;

if (!SCENARIO) {
  console.error('SCENARIO env required (e.g. SCENARIO=seam-b-13-19)');
  process.exit(1);
}

const fixturePath = join(__dirname, 'fixtures', 'regression', `${SCENARIO}.json`);
if (!existsSync(fixturePath)) {
  console.error(`Fixture not found: ${fixturePath}`);
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const startedAt = Date.now();

console.log(`[mock-backend] scenario=${SCENARIO} seam=${fixture.seam} port=${PORT}`);
console.log(`[mock-backend] stations: ${Object.keys(fixture.arrivals).join(', ')}`);

/**
 * 현재 시점에 활성화된 phase를 골라 응답 생성 (receivedAtMs 자동 주입).
 * @param {string} stationName
 * @returns {object | null}
 */
function resolveArrival(stationName) {
  const phases = fixture.arrivals[stationName];
  if (!phases || phases.length === 0) {
    return null;
  }
  const elapsed = Date.now() - startedAt;
  const active = phases
    .filter((p) => p.fromMs <= elapsed)
    .sort((a, b) => b.fromMs - a.fromMs)[0];
  if (!active) {
    return null;
  }
  const receivedAtMs = startedAt + active.fromMs;
  return {
    ...active.body,
    up: active.body.up.map((r) => ({ ...r, receivedAtMs })),
    down: active.body.down.map((r) => ({ ...r, receivedAtMs })),
    source: active.body.source || 'realtime',
  };
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

const ARRIVAL_PATH = /^\/api\/arrival\/([^/?]+)/;

function handle(req, res) {
  const url = req.url || '/';
  const method = req.method || 'GET';

  console.log('[mock-backend] %s %s', encodeURIComponent(method), encodeURIComponent(url));

  // GET /api/arrival/:stationName — BFF arrival
  const arrivalMatch = url.match(ARRIVAL_PATH);
  if (method === 'GET' && arrivalMatch) {
    const stationName = decodeURIComponent(arrivalMatch[1]);
    const body = resolveArrival(stationName);
    if (!body) {
      if (fixture.strictStations) {
        sendJson(res, 404, { error: 'station_not_in_fixture', stationName });
      } else {
        sendJson(res, 200, { up: [], down: [], source: 'realtime' });
      }
      return;
    }
    sendJson(res, 200, body);
    return;
  }

  // POST /trips/*, /live-activity/* — alarm-worker.
  // 회귀 시나리오는 silent push 없이 client-side 알람만 검증하므로 ACK만 돌려준다.
  if (method === 'POST' && (url.startsWith('/trips') || url.startsWith('/live-activity'))) {
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /healthz — CI가 mock 기동을 대기할 수 있도록.
  if (url === '/healthz') {
    sendJson(res, 200, { ok: true, scenario: SCENARIO });
    return;
  }

  sendJson(res, 404, { error: 'not_found', url });
}

const server = createServer(handle);
server.listen(PORT, () => {
  console.log(`[mock-backend] listening on http://localhost:${PORT}`);
});

const shutdown = () => {
  console.log('[mock-backend] shutting down');
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
