import { formatName } from './format';

export function greeting(first: string, last: string): string {
  return `Hello, ${formatName(first, last)}!`;
}
