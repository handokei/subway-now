describe('createPositionProvider', () => {
  it('SeoulOpenPositionProvider 인스턴스를 반환한다', () => {
    const { createPositionProvider } = require('../factory');
    const { SeoulOpenPositionProvider } = require('../SeoulOpenPositionProvider');
    expect(createPositionProvider()).toBeInstanceOf(SeoulOpenPositionProvider);
  });
});
