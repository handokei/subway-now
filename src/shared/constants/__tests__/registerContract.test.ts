import { REGISTER_KV_UNAVAILABLE_ERROR } from '../registerContract';

describe('registerContract', () => {
  it('REGISTER_KV_UNAVAILABLE_ERROR는 backend POST /trips 503 본문 error와 공유하는 wire 계약값이다', () => {
    expect(REGISTER_KV_UNAVAILABLE_ERROR).toBe('kv_unavailable');
  });
});
