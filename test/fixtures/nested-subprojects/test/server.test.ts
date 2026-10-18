import { describe, expect, it } from 'vitest';
import { summarize } from '../src/complex';

describe('summarize', () => {
  it('counts values', () => {
    expect(summarize([1, 2])).toBe(2);
  });
});
