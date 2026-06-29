import { useDispatch } from '@/redux';
import { cn } from '@/utils/cn';
import { DatabaseIcon } from 'lucide-react';

import type { IChartEvent } from '@openpanel/validation';

import { changeEvent } from '../reportSlice';
import { PropertiesCombobox } from './PropertiesCombobox';

interface EventPropertiesComboboxProps {
  event: IChartEvent;
}

// Property picker for the property_* segments. Uses the shared PropertiesCombobox
// (same UI as the filter / breakdown / per-user pickers) scoped to event
// properties, instead of the basic flat combobox.
export function EventPropertiesCombobox({
  event,
}: EventPropertiesComboboxProps) {
  const dispatch = useDispatch();

  return (
    <PropertiesCombobox
      event={event}
      mode="events"
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
      {(setOpen) => (
        <button
          type="button"
          onClick={() => setOpen((p) => !p)}
          className={cn(
            'flex items-center gap-1 rounded-md border border-border p-1 px-2 text-sm font-medium leading-none',
            !event.property && 'border-destructive text-destructive',
          )}
        >
          <DatabaseIcon size={12} />{' '}
          {event.property ? `Property: ${event.property}` : 'Select property'}
        </button>
      )}
    </PropertiesCombobox>
  );
}
