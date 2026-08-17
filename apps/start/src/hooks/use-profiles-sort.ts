import {
  parseAsInteger,
  parseAsString,
  parseAsStringEnum,
  useQueryState,
} from 'nuqs';

const nuqsOptions = { history: 'push' } as const;

export type ProfileCountOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'notBetween';

/**
 * URL state for the Profiles "Last seen" (created_at) column: sort direction and
 * an optional hour-precise window. The window is null by default so nothing is
 * filtered until the user explicitly picks a range — a defaulted window would
 * hide every profile not seen recently.
 */
export function useProfilesSort() {
  const [dir, setDir] = useQueryState(
    'seenSort',
    parseAsStringEnum(['asc', 'desc'])
      .withDefault('desc')
      .withOptions({ ...nuqsOptions, clearOnDefault: false }),
  );
  // DB format 'yyyy-MM-dd HH:mm:ss' — carries hour precision.
  const [seenStart, setSeenStart] = useQueryState(
    'seenStart',
    parseAsString.withOptions(nuqsOptions),
  );
  const [seenEnd, setSeenEnd] = useQueryState(
    'seenEnd',
    parseAsString.withOptions(nuqsOptions),
  );
  // "did event OP N times" threshold for the behavioural filter. Operator +
  // value(s); value2 is only used by between/notBetween. Only meaningful when an
  // event is selected. Default (op unset) reads as "at least 1" = no-op.
  const [countOp, setCountOp] = useQueryState(
    'countOp',
    parseAsStringEnum<ProfileCountOp>([
      'eq',
      'ne',
      'gt',
      'gte',
      'lt',
      'lte',
      'between',
      'notBetween',
    ]).withOptions(nuqsOptions),
  );
  const [countVal, setCountVal] = useQueryState(
    'countVal',
    parseAsInteger.withOptions(nuqsOptions),
  );
  const [countVal2, setCountVal2] = useQueryState(
    'countVal2',
    parseAsInteger.withOptions(nuqsOptions),
  );

  return {
    dir,
    toggleDir: () => setDir(dir === 'desc' ? 'asc' : 'desc'),
    setDir,
    seenStart,
    seenEnd,
    setSeenRange: (start: string | null, end: string | null) => {
      setSeenStart(start);
      setSeenEnd(end);
    },
    countOp,
    setCountOp,
    countVal,
    setCountVal,
    countVal2,
    setCountVal2,
  };
}
