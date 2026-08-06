import { isNumber } from 'mathjs';

export const round = (num: number, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round((num + Number.EPSILON) * factor) / factor;
};

export const average = (arr: (number | null)[], includeZero = false) => {
  const filtered = arr.filter(
    (n): n is number =>
      isNumber(n) &&
      !Number.isNaN(n) &&
      Number.isFinite(n) &&
      (includeZero || n !== 0),
  );
  const avg = filtered.reduce((p, c) => p + c, 0) / filtered.length;
  return Number.isNaN(avg) ? 0 : avg;
};

export const sum = (arr: (number | null | undefined)[]): number =>
  round(arr.filter(isNumber).reduce((acc, item) => acc + item, 0));

// Fold instead of `Math.min(...arr)` — spreading a large array (e.g. a
// high-cardinality breakdown's flattened data points) exceeds V8's argument
// limit and throws "Maximum call stack size exceeded". reduce() has no such cap.
// Empty-input semantics preserved: min([]) -> Infinity, max([]) -> -Infinity
// (matching Math.min()/Math.max()).
export const min = (arr: (number | null | undefined)[]): number =>
  arr.filter(isNumber).reduce((m, n) => (n < m ? n : m), Number.POSITIVE_INFINITY);

export const max = (arr: (number | null | undefined)[]): number =>
  arr.filter(isNumber).reduce((m, n) => (n > m ? n : m), Number.NEGATIVE_INFINITY);

export const isFloat = (n: number) => n % 1 !== 0;

export const ifNaN = <T extends number>(
  n: number | null | undefined,
  defaultValue: T,
): T => (Number.isNaN(n) ? defaultValue : (n as T));
