import { PropertyPicker } from '@/components/property-picker';
import { useAppParams } from '@/hooks/use-app-params';
import { useDispatch } from '@/redux';
import { cn } from '@/utils/cn';
import { DatabaseIcon } from 'lucide-react';

import type { IChartEvent } from '@openpanel/validation';

import { changeEvent } from '../reportSlice';

interface EventPropertiesComboboxProps {
  event: IChartEvent;
}

// Property picker for the property_* segments. Uses the shared two-pane
// PropertyPicker scoped to the event's own properties.
export function EventPropertiesCombobox({
  event,
}: EventPropertiesComboboxProps) {
  const { projectId } = useAppParams();
  const dispatch = useDispatch();

  return (
    <PropertyPicker
      projectId={projectId}
      event={event.name}
      categories={['event']}
      onSelect={(action) => {
        dispatch(
          changeEvent({
            ...event,
            property: action.value,
            type: 'event',
          }),
        );
      }}
    >
      <button
        type="button"
        className={cn(
          'flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium leading-none text-muted-foreground transition-colors hover:bg-def-200 hover:text-foreground',
          !event.property && 'text-destructive hover:text-destructive',
        )}
      >
        <DatabaseIcon size={12} /> {event.property || 'Select property'}
      </button>
    </PropertyPicker>
  );
}
