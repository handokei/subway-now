import {
  __resetDebugBufferRegistryForTests,
  getRegisteredDebugBuffers,
  registerDebugBuffer,
} from '../debugBufferRegistry';

describe('debugBufferRegistry (#1348)', () => {
  beforeEach(() => {
    __resetDebugBufferRegistryForTests();
  });

  it('등록된 buffer source를 등록 순서대로 반환한다', () => {
    registerDebugBuffer({ key: 'A', dumpLines: () => ['a1', 'a2'] });
    registerDebugBuffer({ key: 'B', dumpLines: () => ['b1'] });
    const sources = getRegisteredDebugBuffers();
    expect(sources.map((s) => s.key)).toEqual(['A', 'B']);
    expect(sources[0].dumpLines()).toEqual(['a1', 'a2']);
    expect(sources[1].dumpLines()).toEqual(['b1']);
  });

  it('동일 key 재등록 시 마지막 등록이 우선 (테스트용 mock 대체)', () => {
    registerDebugBuffer({ key: 'A', dumpLines: () => ['orig'] });
    registerDebugBuffer({ key: 'A', dumpLines: () => ['mock'] });
    const sources = getRegisteredDebugBuffers();
    expect(sources).toHaveLength(1);
    expect(sources[0].dumpLines()).toEqual(['mock']);
  });

  it('빈 registry는 빈 배열 반환', () => {
    expect(getRegisteredDebugBuffers()).toEqual([]);
  });

  it('새 source 추가 시 enumerate 결과에 자동 포함된다 (확장성)', () => {
    registerDebugBuffer({ key: 'Existing', dumpLines: () => [] });
    expect(getRegisteredDebugBuffers().map((s) => s.key)).toEqual(['Existing']);
    // 후속 등록.
    registerDebugBuffer({ key: 'New', dumpLines: () => ['n1'] });
    expect(getRegisteredDebugBuffers().map((s) => s.key)).toEqual(['Existing', 'New']);
  });

  it('__resetDebugBufferRegistryForTests로 초기화된다', () => {
    registerDebugBuffer({ key: 'Temp', dumpLines: () => [] });
    expect(getRegisteredDebugBuffers()).toHaveLength(1);
    __resetDebugBufferRegistryForTests();
    expect(getRegisteredDebugBuffers()).toHaveLength(0);
  });
});
