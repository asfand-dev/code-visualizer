import chunk from 'lodash/chunk.js';

export function pairs(items) {
  return chunk(items, 2);
}
