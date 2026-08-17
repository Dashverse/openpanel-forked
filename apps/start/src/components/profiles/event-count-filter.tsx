import type { ProfileCountOp } from '@/hooks/use-profiles-sort';

// Short, inline-reading labels: "did X <label> N times".
const OPERATORS: { value: ProfileCountOp; label: string }[] = [
  { value: 'gte', label: 'at least' },
  { value: 'gt', label: 'more than' },
  { value: 'eq', label: 'exactly' },
  { value: 'lte', label: 'at most' },
  { value: 'lt', label: 'less than' },
  { value: 'ne', label: 'not equal to' },
  { value: 'between', label: 'between' },
  { value: 'notBetween', label: 'not between' },
];

const inputCls =
  'h-8 w-16 rounded-md border bg-card px-2 text-center tabular-nums text-foreground';

/**
 * "did event <operator> N times" control for the Profiles behavioural filter.
 * Operates over the audience "profiles who did the event" — so "less than 3"
 * means "did it 1-2 times", not "including profiles that never did it".
 */
export function EventCountFilter({
  operator,
  value,
  value2,
  onOperatorChange,
  onValueChange,
  onValue2Change,
}: {
  operator: ProfileCountOp;
  value: number;
  value2: number;
  onOperatorChange: (op: ProfileCountOp) => void;
  onValueChange: (n: number) => void;
  onValue2Change: (n: number) => void;
}) {
  const isRange = operator === 'between' || operator === 'notBetween';

  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground">
      <select
        value={operator}
        onChange={(e) => onOperatorChange(e.target.value as ProfileCountOp)}
        className="h-8 rounded-md border bg-card px-2 text-foreground"
        aria-label="Count comparison"
      >
        {OPERATORS.map((op) => (
          <option key={op.value} value={op.value}>
            {op.label}
          </option>
        ))}
      </select>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) =>
          onValueChange(
            Math.max(0, Number(e.target.value.replace(/[^0-9]/g, '')) || 0),
          )
        }
        className={inputCls}
        aria-label="Number of times"
      />
      {isRange && (
        <>
          <span>and</span>
          <input
            type="text"
            inputMode="numeric"
            value={value2}
            onChange={(e) =>
              onValue2Change(
                Math.max(0, Number(e.target.value.replace(/[^0-9]/g, '')) || 0),
              )
            }
            className={inputCls}
            aria-label="Upper bound"
          />
        </>
      )}
      <span>times</span>
    </div>
  );
}
