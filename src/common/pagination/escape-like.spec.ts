import { escapeLike } from './escape-like';

describe('escapeLike', () => {
  it.each([
    ['plain', 'plain'],
    ['100%', '100\\%'],
    ['a_b', 'a\\_b'],
    ['c:\\x', 'c:\\\\x'],
    ['%_\\', '\\%\\_\\\\'],
    ['', ''],
  ])('%j becomes %j', (term, expected) => {
    expect(escapeLike(term)).toBe(expected);
  });
});
