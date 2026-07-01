import { Button } from '@/components/ui/button';
import { Command, CommandInput, CommandItem } from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useCohorts } from '@/hooks/use-cohorts';
import { useEventProperties } from '@/hooks/use-event-properties';
import { cn } from '@/utils/cn';
import {
  DatabaseIcon,
  Loader2,
  type LucideIcon,
  RefreshCwIcon,
  UserIcon,
  UsersIcon,
} from 'lucide-react';
import VirtualList from 'rc-virtual-list';
import { type ReactNode, useMemo, useState } from 'react';

type Category = 'event' | 'profile' | 'cohort';

export interface PropertyAction {
  value: string;
  label: string;
  description: string;
  cohortId?: string;
}

interface PropertyPickerProps {
  projectId: string;
  event?: string;
  exclude?: string[];
  onSelect: (action: PropertyAction) => void;
  children: ReactNode;
}

const CATEGORIES: { id: Category; label: string; icon: LucideIcon }[] = [
  { id: 'event', label: 'Event properties', icon: DatabaseIcon },
  { id: 'profile', label: 'Profile properties', icon: UserIcon },
  { id: 'cohort', label: 'Cohorts', icon: UsersIcon },
];

export function PropertyPicker({
  projectId,
  event,
  exclude = [],
  onSelect,
  children,
}: PropertyPickerProps) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category>('event');
  const [search, setSearch] = useState('');

  const {
    items: properties,
    isLoading: isLoadingProperties,
    isError: isErrorProperties,
    refetch: refetchProperties,
  } = useEventProperties({ event, projectId });
  const {
    items: cohorts,
    isLoading: isLoadingCohorts,
    isError: isErrorCohorts,
    refetch: refetchCohorts,
  } = useCohorts({ projectId, includeCount: false }, { enabled: open });

  const shouldShowProperty = (property: string) =>
    !exclude.find((ex) =>
      ex.endsWith('*') ? property.startsWith(ex.slice(0, -1)) : property === ex,
    );

  const eventActions = useMemo<PropertyAction[]>(
    () =>
      properties
        .filter(
          (property) =>
            !property.startsWith('profile') && shouldShowProperty(property),
        )
        .map((property) => ({
          value: property,
          label: property.split('.').pop() ?? property,
          description: property.split('.').slice(0, -1).join('.'),
        })),
    [properties, exclude],
  );

  const profileActions = useMemo<PropertyAction[]>(
    () =>
      properties
        .filter(
          (property) =>
            property.startsWith('profile') && shouldShowProperty(property),
        )
        .map((property) => ({
          value: property,
          label: property.split('.').pop() ?? property,
          description: property.split('.').slice(0, -1).join('.'),
        })),
    [properties, exclude],
  );

  const cohortActions = useMemo<PropertyAction[]>(
    () =>
      cohorts.map((cohort) => ({
        value: `cohort:${cohort.id}`,
        label: cohort.name,
        description: cohort.description || `${cohort.profileCount || 0} users`,
        cohortId: cohort.id,
      })),
    [cohorts],
  );

  const actions =
    category === 'event'
      ? eventActions
      : category === 'profile'
        ? profileActions
        : cohortActions;

  const filteredActions = actions.filter(
    (action) =>
      action.label.toLowerCase().includes(search.toLowerCase()) ||
      action.description.toLowerCase().includes(search.toLowerCase()),
  );

  const isLoading =
    category === 'cohort' ? isLoadingCohorts : isLoadingProperties;
  const isError = category === 'cohort' ? isErrorCohorts : isErrorProperties;
  const refetch = category === 'cohort' ? refetchCohorts : refetchProperties;
  const label = category === 'cohort' ? 'cohorts' : 'properties';

  const handleSelect = (action: PropertyAction) => {
    setOpen(false);
    onSelect(action);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setCategory('event');
          setSearch('');
        }
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          className="w-[34em] max-sm:max-w-[100vw] p-0"
          align="start"
        >
          <div className="flex">
            <div className="flex w-40 shrink-0 flex-col gap-0.5 border-r p-1">
              {CATEGORIES.map(({ id, label: title, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setCategory(id);
                    setSearch('');
                  }}
                  className={cn(
                    'flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                    category === id
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{title}</span>
                </button>
              ))}
            </div>
            <div className="min-w-0 flex-1">
              <Command shouldFilter={false}>
                <CommandInput
                  placeholder="Search"
                  value={search}
                  onValueChange={setSearch}
                />
                {isLoading && actions.length === 0 ? (
                  <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading {label}…
                  </div>
                ) : isError && actions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
                    <span>Failed to load {label}.</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => refetch()}
                    >
                      <RefreshCwIcon className="mr-2 h-3 w-3" />
                      Refresh
                    </Button>
                  </div>
                ) : filteredActions.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    No {label} found
                  </div>
                ) : (
                  <VirtualList
                    height={300}
                    data={filteredActions}
                    itemHeight={44}
                    itemKey="value"
                  >
                    {(action) => (
                      <CommandItem
                        key={action.value}
                        value={action.value}
                        onSelect={() => handleSelect(action)}
                        className="col cursor-pointer items-start gap-px"
                      >
                        <div className="font-medium">{action.label}</div>
                        {action.description && (
                          <div className="text-xs text-muted-foreground">
                            {action.description}
                          </div>
                        )}
                      </CommandItem>
                    )}
                  </VirtualList>
                )}
              </Command>
            </div>
          </div>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
