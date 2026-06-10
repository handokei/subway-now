import { createDebugBuffer } from '../createDebugBuffer';

describe('createDebugBuffer', () => {
  it('초기 상태는 빈 배열이다', () => {
    const buf = createDebugBuffer<number>(10);
    expect(buf.get()).toHaveLength(0);
  });

  it('push하면 get()에서 엔트리를 읽을 수 있다', () => {
    const buf = createDebugBuffer<number>(10);
    buf.push(42);
    expect(buf.get()).toEqual([42]);
  });

  it('capacity 초과 시 오래된 항목부터 삭제한다', () => {
    const buf = createDebugBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    expect(buf.get()).toEqual([2, 3, 4]);
  });

  it('clear()로 버퍼를 비운다', () => {
    const buf = createDebugBuffer<number>(10);
    buf.push(1);
    buf.clear();
    expect(buf.get()).toHaveLength(0);
  });

  it('push 시 구독자에게 알린다', () => {
    const buf = createDebugBuffer<number>(10);
    const cb = jest.fn();
    buf.subscribe(cb);
    buf.push(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('clear 시 구독자에게 알린다', () => {
    const buf = createDebugBuffer<number>(10);
    const cb = jest.fn();
    buf.subscribe(cb);
    buf.clear();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe 후 콜백을 호출하지 않는다', () => {
    const buf = createDebugBuffer<number>(10);
    const cb = jest.fn();
    const unsub = buf.subscribe(cb);
    unsub();
    buf.push(1);
    expect(cb).not.toHaveBeenCalled();
  });

  it('복수 구독자 모두에게 알린다', () => {
    const buf = createDebugBuffer<number>(10);
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    buf.subscribe(cb1);
    buf.subscribe(cb2);
    buf.push(1);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('subscribe 중 unsubscribe해도 다른 구독자는 계속 알림 받는다', () => {
    const buf = createDebugBuffer<number>(10);
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    const unsub1 = buf.subscribe(cb1);
    buf.subscribe(cb2);
    unsub1();
    buf.push(1);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
