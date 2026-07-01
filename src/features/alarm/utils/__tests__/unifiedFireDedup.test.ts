import {
  observeArvlCd,
  getCurrentCycle,
  hasFiredForCycle,
  markFiredForCycle,
  clearUnifiedFireDedup,
  _resetUnifiedFireDedupForTests,
  UNIFIED_FIRE_DEDUP_TTL_MS,
} from '../unifiedFireDedup';
import { SIMPLE_ARRIVAL_ARCH_ENV_KEY } from '../../../../shared/config/archFlag';

const ORIGINAL_ENV = process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];

/** flag=ON 을 위해 env 를 'true' 로 세팅. */
function enableFlag(): void {
  process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
}

/** flag=OFF (기본) — env 를 명시적으로 제거. */
function disableFlag(): void {
  delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
}

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
  } else {
    process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = ORIGINAL_ENV;
  }
  _resetUnifiedFireDedupForTests();
});

const STATION = '성수';
const LINE = '2';
const TRAIN = '2001';

describe('unifiedFireDedup — arvlCd cycle 추적 (#1997)', () => {
  it('최초 관측 시 cycle = 0 초기화', () => {
    observeArvlCd(STATION, LINE, TRAIN, 0);
    expect(getCurrentCycle(STATION, LINE, TRAIN)).toBe(0);
  });

  it('관측 전엔 cycle 0 (default)', () => {
    expect(getCurrentCycle(STATION, LINE, TRAIN)).toBe(0);
  });

  it('0 → 1 → 2 → 5 monotone 시퀀스는 cycle 유지', () => {
    observeArvlCd(STATION, LINE, TRAIN, 0);
    observeArvlCd(STATION, LINE, TRAIN, 1);
    observeArvlCd(STATION, LINE, TRAIN, 2);
    observeArvlCd(STATION, LINE, TRAIN, 5);
    expect(getCurrentCycle(STATION, LINE, TRAIN)).toBe(0);
  });

  it('5 → 0 전환 시 cycle +1 (다음 train)', () => {
    observeArvlCd(STATION, LINE, TRAIN, 5);
    observeArvlCd(STATION, LINE, TRAIN, 0);
    expect(getCurrentCycle(STATION, LINE, TRAIN)).toBe(1);
  });

  it('5 → 0 여러 번 반복 시 cycle 계속 +1', () => {
    observeArvlCd(STATION, LINE, TRAIN, 5);
    observeArvlCd(STATION, LINE, TRAIN, 0);
    observeArvlCd(STATION, LINE, TRAIN, 5);
    observeArvlCd(STATION, LINE, TRAIN, 0);
    observeArvlCd(STATION, LINE, TRAIN, 5);
    observeArvlCd(STATION, LINE, TRAIN, 0);
    expect(getCurrentCycle(STATION, LINE, TRAIN)).toBe(3);
  });

  it('같은 값 반복은 cycle 유지 (e.g. 1 → 1 → 1)', () => {
    observeArvlCd(STATION, LINE, TRAIN, 1);
    observeArvlCd(STATION, LINE, TRAIN, 1);
    observeArvlCd(STATION, LINE, TRAIN, 1);
    expect(getCurrentCycle(STATION, LINE, TRAIN)).toBe(0);
  });

  it('non-5→0 전환은 cycle 유지 (e.g. 2 → 0 은 새 cycle 아님)', () => {
    // 방어적: monotone 시퀀스 밖에서 5→0 만 전환 신호로 인식.
    observeArvlCd(STATION, LINE, TRAIN, 2);
    observeArvlCd(STATION, LINE, TRAIN, 0);
    expect(getCurrentCycle(STATION, LINE, TRAIN)).toBe(0);
  });

  it('(station, line, trainCode) 조합 별로 독립적 cycle 추적', () => {
    observeArvlCd(STATION, LINE, TRAIN, 5);
    observeArvlCd(STATION, LINE, TRAIN, 0);
    // 다른 station: cycle 그대로 0
    observeArvlCd('건대입구', LINE, TRAIN, 5);
    expect(getCurrentCycle(STATION, LINE, TRAIN)).toBe(1);
    expect(getCurrentCycle('건대입구', LINE, TRAIN)).toBe(0);
    // 다른 line, 같은 station: 독립
    observeArvlCd(STATION, '7', TRAIN, 3);
    expect(getCurrentCycle(STATION, '7', TRAIN)).toBe(0);
  });

  it('line=null 조합도 지원 (환승역 무-노선 방어)', () => {
    observeArvlCd(STATION, null, TRAIN, 5);
    observeArvlCd(STATION, null, TRAIN, 0);
    expect(getCurrentCycle(STATION, null, TRAIN)).toBe(1);
    // (station, null) 은 (station, LINE) 과 별개 key
    expect(getCurrentCycle(STATION, LINE, TRAIN)).toBe(0);
  });
});

describe('unifiedFireDedup — trainCode 격리 (Finding #2)', () => {
  beforeEach(() => {
    enableFlag();
  });

  /**
   * wire PR 에서 caller 가 실수로 arrival.up[] + arrival.down[] 를 iterate 해 여러 train 의
   * arvlCd 를 섞어 넣더라도 사용자 target train (BoardingLock.trainCode) 의 cycle 은
   * 다른 train row 의 관측에 영향받지 않아야 한다.
   */
  it('두 train 이 같은 station 에 있어도 각자의 cycle 은 독립적', () => {
    const TARGET = '2001'; // 사용자 target
    const OTHER = '2099'; // 옆에 서 있는 다른 train
    // 실수 시나리오: caller 가 OTHER train arvlCd=5 관측 후 TARGET arvlCd=0 관측.
    // Finding #2 이전 (trainCode 없음) 이라면 prev=5, curr=0 → cycle=1 로 잘못 전환.
    // trainCode 격리 후: OTHER 의 5 는 TARGET timeline 에 영향 없음.
    observeArvlCd(STATION, LINE, OTHER, 5);
    observeArvlCd(STATION, LINE, TARGET, 0);
    expect(getCurrentCycle(STATION, LINE, TARGET)).toBe(0);
    expect(getCurrentCycle(STATION, LINE, OTHER)).toBe(0);
  });

  it('TARGET train 이 실제로 5→0 전환한 경우만 cycle 증가', () => {
    const TARGET = '2001';
    observeArvlCd(STATION, LINE, TARGET, 5);
    observeArvlCd(STATION, LINE, TARGET, 0);
    expect(getCurrentCycle(STATION, LINE, TARGET)).toBe(1);
  });

  it('같은 station, 같은 line 에서 두 train 이 각자 fire 판정', () => {
    const TRAIN_A = '2001';
    const TRAIN_B = '2099';
    markFiredForCycle(STATION, LINE, TRAIN_A);
    // A 는 dedup, B 는 통과
    expect(hasFiredForCycle(STATION, LINE, TRAIN_A)).toBe(true);
    expect(hasFiredForCycle(STATION, LINE, TRAIN_B)).toBe(false);
  });
});

describe('unifiedFireDedup — stationName 정규화 (Finding #1)', () => {
  beforeEach(() => {
    enableFlag();
  });

  /**
   * wire PR 에서 caller 에 따라 서로 다른 source (arrival.stationName vs
   * route.waypoint.stationName) 를 쓸 수 있다. 표기 variant (괄호 부제) 가
   * 같은 물리적 역으로 취급돼야 kind-agnostic dedup 이 유지된다.
   */
  it("'서울역(1)' 과 '서울역' 은 같은 cycle timeline 으로 처리", () => {
    // caller A: 정규화 이전 원문
    markFiredForCycle('서울역(1)', '1', TRAIN);
    // caller B: 정규화된 이름
    expect(hasFiredForCycle('서울역', '1', TRAIN)).toBe(true);
  });

  it("괄호 이전에 observe 한 cycle 이 괄호 없는 조회에도 반영", () => {
    observeArvlCd('사당(4·2)', LINE, TRAIN, 5);
    observeArvlCd('사당(4·2)', LINE, TRAIN, 0);
    // 다른 caller 가 괄호 없는 이름으로 조회
    expect(getCurrentCycle('사당', LINE, TRAIN)).toBe(1);
  });

  it('trailing whitespace 도 정규화되어 같은 key', () => {
    markFiredForCycle('성수 ', LINE, TRAIN);
    expect(hasFiredForCycle('성수', LINE, TRAIN)).toBe(true);
  });
});

describe('unifiedFireDedup — flag OFF (기존 5 채널만 동작)', () => {
  beforeEach(() => {
    disableFlag();
  });

  it('flag OFF 면 hasFiredForCycle 항상 false — mark 여부 무관', () => {
    markFiredForCycle(STATION, LINE, TRAIN);
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(false);
  });

  it('flag OFF + remote undefined 도 false', () => {
    markFiredForCycle(STATION, LINE, TRAIN);
    expect(hasFiredForCycle(STATION, LINE, TRAIN, undefined)).toBe(false);
  });

  it('flag OFF + remote=off 도 false (backward-compat)', () => {
    markFiredForCycle(STATION, LINE, TRAIN);
    expect(hasFiredForCycle(STATION, LINE, TRAIN, 'off')).toBe(false);
  });
});

describe('unifiedFireDedup — flag ON kind 무관 1 fire (#1997)', () => {
  beforeEach(() => {
    enableFlag();
  });

  it('첫 fire 는 통과 (mark 이전)', () => {
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(false);
  });

  it('mark 후 같은 cycle 재조회는 true (kind 무관 backstop)', () => {
    // kind1 fire simulation
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(false);
    markFiredForCycle(STATION, LINE, TRAIN);
    // kind2 fire attempt → 통합 dedup 이 차단
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(true);
  });

  it('3+ 케이스 — destination / transfer / station-passed kind 무관 같은 cycle 1 fire', () => {
    // simulation: caller 가 kind 별로 fire 시도. helper 는 kind 를 몰라도 첫 fire 만 통과.
    // 1. destination kind 첫 fire
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(false);
    markFiredForCycle(STATION, LINE, TRAIN);
    // 2. transfer kind 시도 → dedup
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(true);
    // 3. station-passed kind 시도 → dedup
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(true);
  });

  it('remote=on 만으로도 flag 활성 (env 없어도)', () => {
    disableFlag();
    markFiredForCycle(STATION, LINE, TRAIN);
    expect(hasFiredForCycle(STATION, LINE, TRAIN, 'on')).toBe(true);
  });

  it('5→0 전환 시 새 cycle → 재발사 허용 (kind 무관)', () => {
    // cycle 0 fire
    markFiredForCycle(STATION, LINE, TRAIN);
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(true);
    // 다음 train 도착 시퀀스
    observeArvlCd(STATION, LINE, TRAIN, 5);
    observeArvlCd(STATION, LINE, TRAIN, 0);
    expect(getCurrentCycle(STATION, LINE, TRAIN)).toBe(1);
    // 새 cycle 은 fire 되지 않은 상태
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(false);
    // 새 cycle mark 후 재조회
    markFiredForCycle(STATION, LINE, TRAIN);
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(true);
  });

  it('(station, line, trainCode) 조합 별로 독립적 fire 판정', () => {
    markFiredForCycle(STATION, LINE, TRAIN);
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(true);
    // 다른 station 은 fire 안 됨
    expect(hasFiredForCycle('건대입구', LINE, TRAIN)).toBe(false);
    // 다른 line, 같은 station 도 fire 안 됨
    expect(hasFiredForCycle(STATION, '7', TRAIN)).toBe(false);
    // 다른 trainCode 도 fire 안 됨
    expect(hasFiredForCycle(STATION, LINE, '9999')).toBe(false);
  });

  it('TTL 만료 시 fire 허용 (5 분 이상)', () => {
    const t0 = 1_700_000_000_000;
    markFiredForCycle(STATION, LINE, TRAIN, t0);
    expect(hasFiredForCycle(STATION, LINE, TRAIN, undefined, t0)).toBe(true);
    // TTL 직전
    expect(
      hasFiredForCycle(STATION, LINE, TRAIN, undefined, t0 + UNIFIED_FIRE_DEDUP_TTL_MS - 1),
    ).toBe(true);
    // TTL 초과
    expect(
      hasFiredForCycle(STATION, LINE, TRAIN, undefined, t0 + UNIFIED_FIRE_DEDUP_TTL_MS),
    ).toBe(false);
  });

  it('line=null 조합에서도 정상 dedup', () => {
    markFiredForCycle(STATION, null, TRAIN);
    expect(hasFiredForCycle(STATION, null, TRAIN)).toBe(true);
    // (station, LINE) 은 별개 key
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(false);
  });
});

describe('unifiedFireDedup — clearUnifiedFireDedup', () => {
  beforeEach(() => {
    enableFlag();
  });

  it('clear 후 모든 cycle state / fire ledger 초기화', async () => {
    observeArvlCd(STATION, LINE, TRAIN, 5);
    observeArvlCd(STATION, LINE, TRAIN, 0);
    markFiredForCycle(STATION, LINE, TRAIN);
    expect(getCurrentCycle(STATION, LINE, TRAIN)).toBe(1);
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(true);

    await clearUnifiedFireDedup();

    expect(getCurrentCycle(STATION, LINE, TRAIN)).toBe(0);
    expect(hasFiredForCycle(STATION, LINE, TRAIN)).toBe(false);
  });
});

describe('unifiedFireDedup — cap sweep', () => {
  beforeEach(() => {
    enableFlag();
  });

  it('cap 도달 시 만료 entry 를 sweep 하고 live entry 는 보존', () => {
    const t0 = 1_700_000_000_000;
    // 만료 예정 entry 를 대량 stamp
    for (let i = 0; i < 520; i++) {
      markFiredForCycle(`station-${i}`, LINE, TRAIN, t0);
    }
    // live entry 를 5 분 후 stamp — 이 시점에 sweep 이 발동해 옛 entry 삭제, live 는 유지.
    const tLive = t0 + UNIFIED_FIRE_DEDUP_TTL_MS + 1;
    markFiredForCycle('live-station', LINE, TRAIN, tLive);

    // live entry 는 여전히 fire 상태
    expect(hasFiredForCycle('live-station', LINE, TRAIN, undefined, tLive)).toBe(true);
    // 만료된 entry 는 fire 없음 (sweep 되어 lookup 실패)
    expect(hasFiredForCycle('station-0', LINE, TRAIN, undefined, tLive)).toBe(false);
  });

  it('cycle state Map cap 도달 시 만료 entry sweep', () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 520; i++) {
      observeArvlCd(`station-${i}`, LINE, TRAIN, 1, t0);
    }
    const tLive = t0 + UNIFIED_FIRE_DEDUP_TTL_MS + 1;
    observeArvlCd('live-station', LINE, TRAIN, 5, tLive);
    observeArvlCd('live-station', LINE, TRAIN, 0, tLive);
    // live entry cycle 은 유지
    expect(getCurrentCycle('live-station', LINE, TRAIN)).toBe(1);
    // 옛 entry 는 sweep 되어 default 0 반환
    expect(getCurrentCycle('station-0', LINE, TRAIN)).toBe(0);
  });
});
