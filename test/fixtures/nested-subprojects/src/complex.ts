function check(value: number): boolean {
  return value > 1;
}

function report(value: number): void {
  console.log(value);
}

/** Three callbacks with one `if` each: the callbacks are functions of their own. */
export function summarize(values: number[]): number {
  values.forEach((v) => {
    if (check(v)) report(v);
  });
  const doubled = values.map((v) => {
    if (v > 10) return v;
    return v * 2;
  });
  return doubled.filter((v) => {
    if (v === 0) return false;
    return true;
  }).length;
}
