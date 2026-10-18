import { categorical, hashString } from './colors';

/** Stable, collision-free colors for the most active contributors of this report. */
const order = new Map<string, number>();

export function registerPeople(names: string[]): void {
  order.clear();
  names.forEach((name, i) => order.set(name, i));
}

export function personColor(name: string): string {
  const i = order.get(name);
  return categorical(i !== undefined && i < 12 ? i : hashString(name));
}
