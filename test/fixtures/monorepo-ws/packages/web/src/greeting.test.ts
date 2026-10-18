import { expect, it } from 'vitest';
import { greeting } from './greeting';

it('greets', () => {
  expect(greeting('Ada', 'Lovelace')).toBe('Hello, Ada Lovelace!');
});
