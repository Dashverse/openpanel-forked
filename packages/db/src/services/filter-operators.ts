import sqlstring from 'sqlstring';

// Full operator support for a value filter, shared by the profiles behavioural
// filter and cohort event-property criteria. `col` is the SQL expression the
// operator compares (e.g. `property_value`, `properties['x']`, a bare column).
//
// Fixes the old "every unhandled operator falls through to IN" bug — e.g.
// `doesNotContain` used to emit `col IN (...)`, the exact OPPOSITE set.
export function operatorClause(
  col: string,
  operator: string | undefined,
  values: (string | number | boolean | null)[],
): string {
  const trimmed = values.map((v) => String(v).trim());
  const esc = (v: string) => sqlstring.escape(v);
  const inList = trimmed.map(esc).join(', ');
  const anyLike = (pat: (v: string) => string) =>
    `(${trimmed.map((v) => `${col} LIKE ${esc(pat(v))}`).join(' OR ')})`;
  switch (operator) {
    case 'isNot':
      return `${col} NOT IN (${inList})`;
    case 'contains':
      return anyLike((v) => `%${v}%`);
    case 'doesNotContain':
      // Reject rows matching ANY excluded value -> AND (OR would admit a value
      // that contains one of the excluded patterns but not the others).
      return `(${trimmed.map((v) => `${col} NOT LIKE ${esc(`%${v}%`)}`).join(' AND ')})`;
    case 'startsWith':
      return anyLike((v) => `${v}%`);
    case 'endsWith':
      return anyLike((v) => `%${v}`);
    case 'regex':
      return `(${trimmed.map((v) => `match(${col}, ${esc(v)})`).join(' OR ')})`;
    case 'isNull':
      return `(${col} = '' OR ${col} IS NULL)`;
    case 'isNotNull':
      return `(${col} != '' AND ${col} IS NOT NULL)`;
    case 'gt':
      return `(${trimmed.map((v) => `toFloat64OrZero(${col}) > toFloat64(${esc(v)})`).join(' OR ')})`;
    case 'lt':
      return `(${trimmed.map((v) => `toFloat64OrZero(${col}) < toFloat64(${esc(v)})`).join(' OR ')})`;
    case 'gte':
      return `(${trimmed.map((v) => `toFloat64OrZero(${col}) >= toFloat64(${esc(v)})`).join(' OR ')})`;
    case 'lte':
      return `(${trimmed.map((v) => `toFloat64OrZero(${col}) <= toFloat64(${esc(v)})`).join(' OR ')})`;
    default: // 'is' and any unknown operator
      return `${col} IN (${inList})`;
  }
}
