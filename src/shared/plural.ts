/** `1 skill`, `2 skills`, `2 branches` (pass the plural form when it is not the word plus "s"). */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
