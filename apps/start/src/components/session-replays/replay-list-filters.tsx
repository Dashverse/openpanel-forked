import { Button } from '@/components/ui/button';
import { ComboboxAdvanced } from '@/components/ui/combobox-advanced';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { eventQueryFiltersParser } from '@/hooks/use-event-query-filters';
import { useTRPC } from '@/integrations/trpc/react';
import {
  type ReplaySessionFilterField,
  type ReplaySort,
  replaySessionFilterFields,
  replaySessionNumericFields,
  replaySortOptions,
} from '@openpanel/constants';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, XIcon } from 'lucide-react';
import {
  parseAsInteger,
  parseAsStringLiteral,
  useQueryState,
} from 'nuqs';
import { useMemo } from 'react';

const nuqsOptions = { history: 'push' } as const;

export const REPLAY_DAY_OPTIONS = [1, 3, 7, 14, 30, 90] as const;
const DEFAULT_REPLAY_DAYS = 7;

/** Minimum recording length presets (seconds). 0 = any. */
const DURATION_PRESETS = [
  { value: 'any', label: 'Any length', ms: undefined },
  { value: '30s', label: '≥ 30 sec', ms: 30_000 },
  { value: '1m', label: '≥ 1 min', ms: 60_000 },
  { value: '5m', label: '≥ 5 min', ms: 300_000 },
  { value: '15m', label: '≥ 15 min', ms: 900_000 },
  { value: '30m', label: '≥ 30 min', ms: 1_800_000 },
] as const;
type DurationPreset = (typeof DURATION_PRESETS)[number]['value'];

type SessionFilterOperator =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'doesNotContain'
  | 'gte'
  | 'lte';

export type ReplaySessionFilterState = {
  id: string;
  name: ReplaySessionFilterField;
  operator: SessionFilterOperator;
  value: string[];
};

const isField = (v: string): v is ReplaySessionFilterField =>
  v in replaySessionFilterFields;

/**
 * URL state for the Session Replays list: window, sort, minimum length and
 * session-property filters. Returns the tRPC input fragment to spread into
 * session.list / session.replayCount.
 */
export function useReplayListState() {
  const [sort, setSort] = useQueryState(
    'sort',
    parseAsStringLiteral(
      Object.keys(replaySortOptions) as ReplaySort[],
    )
      .withDefault('newest')
      .withOptions(nuqsOptions),
  );
  const [days, setDays] = useQueryState(
    'days',
    parseAsInteger.withDefault(DEFAULT_REPLAY_DAYS).withOptions(nuqsOptions),
  );
  const [duration, setDuration] = useQueryState(
    'len',
    parseAsStringLiteral(DURATION_PRESETS.map((d) => d.value))
      .withDefault('any')
      .withOptions(nuqsOptions),
  );
  const [rawFilters, setRawFilters] = useQueryState(
    'sf',
    eventQueryFiltersParser.withDefault([]).withOptions(nuqsOptions),
  );

  const sessionFilters = useMemo<ReplaySessionFilterState[]>(
    () =>
      rawFilters
        .filter((f) => isField(f.name))
        .map((f) => ({
          id: f.id,
          name: f.name as ReplaySessionFilterField,
          operator: f.operator as SessionFilterOperator,
          value: f.value.map(String),
        })),
    [rawFilters],
  );

  const setSessionFilters = (next: ReplaySessionFilterState[]) =>
    setRawFilters(next.length ? next : null);

  const minMs = DURATION_PRESETS.find((d) => d.value === duration)?.ms;

  const queryInput = {
    replayDays: days,
    replaySort: sort,
    minReplayDurationMs: minMs,
    // Incomplete rows (no values yet) are ignored until filled in.
    replaySessionFilters: sessionFilters
      .filter((f) => f.value.some((v) => v !== ''))
      .map(({ name, operator, value }) => ({ name, operator, value })),
  };

  return {
    sort,
    setSort,
    days,
    setDays,
    duration,
    setDuration,
    sessionFilters,
    setSessionFilters,
    queryInput,
  };
}

type ListState = ReturnType<typeof useReplayListState>;

/** Window · sort · minimum length — one compact row of selects. */
export function ReplayListToolbar({ state }: { state: ListState }) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      <Select
        value={String(state.days)}
        onValueChange={(v) => state.setDays(Number(v))}
      >
        <SelectTrigger className="h-8 px-2 text-xs" aria-label="Date range">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {REPLAY_DAY_OPTIONS.map((d) => (
            <SelectItem key={d} value={String(d)} className="text-xs">
              {d === 1 ? 'Last 24 hours' : `Last ${d} days`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={state.sort}
        onValueChange={(v) => state.setSort(v as ReplaySort)}
      >
        <SelectTrigger className="h-8 px-2 text-xs" aria-label="Sort by">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(replaySortOptions) as ReplaySort[]).map((s) => (
            <SelectItem key={s} value={s} className="text-xs">
              {replaySortOptions[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={state.duration}
        onValueChange={(v) => state.setDuration(v as DurationPreset)}
      >
        <SelectTrigger className="h-8 px-2 text-xs" aria-label="Recording length">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DURATION_PRESETS.map((d) => (
            <SelectItem key={d.value} value={d.value} className="text-xs">
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const TEXT_OPERATORS: { value: SessionFilterOperator; label: string }[] = [
  { value: 'is', label: 'is' },
  { value: 'isNot', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'doesNotContain', label: 'not contains' },
];
const NUMBER_OPERATORS: { value: SessionFilterOperator; label: string }[] = [
  { value: 'gte', label: '≥' },
  { value: 'lte', label: '≤' },
];

function SessionFilterRow({
  projectId,
  days,
  filter,
  onChange,
  onRemove,
}: {
  projectId: string;
  days: number;
  filter: ReplaySessionFilterState;
  onChange: (next: ReplaySessionFilterState) => void;
  onRemove: () => void;
}) {
  const trpc = useTRPC();
  const numeric = replaySessionNumericFields.includes(filter.name);
  const boolean = filter.name === 'isBounce';
  const pickList =
    !numeric &&
    !boolean &&
    (filter.operator === 'is' || filter.operator === 'isNot');

  const valuesQuery = useQuery({
    ...trpc.session.replayFilterValues.queryOptions({
      projectId,
      field: filter.name,
      replayDays: days,
    }),
    enabled: pickList,
    staleTime: 5 * 60 * 1000,
  });

  const operators = numeric ? NUMBER_OPERATORS : TEXT_OPERATORS;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-background p-2">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {replaySessionFilterFields[filter.name]}
        </span>
        {!boolean && (
          <Select
            value={filter.operator}
            onValueChange={(v) =>
              onChange({ ...filter, operator: v as SessionFilterOperator })
            }
          >
            <SelectTrigger className="h-7 w-auto gap-1 px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operators.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onRemove}
          aria-label={`Remove ${replaySessionFilterFields[filter.name]} filter`}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      {boolean ? (
        <Select
          value={filter.value[0] ?? ''}
          onValueChange={(v) => onChange({ ...filter, value: [v] })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true" className="text-xs">
              Bounced only
            </SelectItem>
            <SelectItem value="false" className="text-xs">
              Not bounced
            </SelectItem>
          </SelectContent>
        </Select>
      ) : pickList ? (
        <ComboboxAdvanced
          size="sm"
          className="w-full"
          placeholder={valuesQuery.isLoading ? 'Loading…' : 'Any value'}
          value={filter.value}
          onChange={(value) =>
            onChange({ ...filter, value: value.map(String) })
          }
          items={(valuesQuery.data ?? []).map((v) => ({
            value: v.value,
            label: `${v.value} (${v.count.toLocaleString()})`,
          }))}
          maxVisibleChips={2}
        />
      ) : (
        <Input
          id={`replay-sf-${filter.id}`}
          type={numeric ? 'number' : 'text'}
          min={numeric ? 0 : undefined}
          value={filter.value[0] ?? ''}
          onChange={(e) => onChange({ ...filter, value: [e.target.value] })}
          placeholder={numeric ? 'Number' : 'Text'}
          className="h-8 text-xs"
        />
      )}
    </div>
  );
}

/** "Session properties" card — same shape as the event filters card above it. */
export function ReplaySessionFiltersCard({
  projectId,
  state,
}: {
  projectId: string;
  state: ListState;
}) {
  const { sessionFilters, setSessionFilters } = state;
  const used = new Set(sessionFilters.map((f) => f.name));
  const addable = (
    Object.keys(replaySessionFilterFields) as ReplaySessionFilterField[]
  ).filter((f) => !used.has(f));

  const add = (name: ReplaySessionFilterField) =>
    setSessionFilters([
      ...sessionFilters,
      {
        id: name,
        name,
        operator: replaySessionNumericFields.includes(name) ? 'gte' : 'is',
        value: [],
      },
    ]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <span className="text-[10px] font-semibold uppercase text-muted-foreground">
        Session properties
      </span>
      {sessionFilters.map((f, i) => (
        <SessionFilterRow
          key={f.id}
          projectId={projectId}
          days={state.days}
          filter={f}
          onChange={(next) =>
            setSessionFilters(
              sessionFilters.map((x, j) => (j === i ? next : x)),
            )
          }
          onRemove={() =>
            setSessionFilters(sessionFilters.filter((_, j) => j !== i))
          }
        />
      ))}
      {addable.length > 0 && (
        <div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                icon={PlusIcon}
                className="border-dashed"
              >
                Add
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
              {addable.map((f) => (
                <DropdownMenuItem key={f} onSelect={() => add(f)} className="text-xs">
                  {replaySessionFilterFields[f]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
