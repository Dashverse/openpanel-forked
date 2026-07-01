import { useDispatch, useSelector } from '@/redux';
import { LockIcon, XIcon } from 'lucide-react';

import { PropertyPicker } from '@/components/property-picker';
import { useAppParams } from '@/hooks/use-app-params';
import { addHoldProperty, removeHoldProperty } from '../reportSlice';

export function ReportHoldProperties() {
  const { projectId } = useAppParams();
  const holdProperties = useSelector((state) => state.report.holdProperties);
  const dispatch = useDispatch();

  return (
    <div>
      <h3 className="mb-2 font-medium">Hold Property Constant</h3>
      <div className="flex flex-col gap-2">
        {holdProperties.map((prop) => (
          <div
            key={prop}
            className="flex items-center gap-2 rounded-lg border bg-def-100 p-2 px-4"
          >
            <LockIcon className="size-3" />
            <span className="flex-1 text-sm">
              {prop.split('.').pop() ?? prop}
            </span>
            <button
              type="button"
              onClick={() => dispatch(removeHoldProperty(prop))}
              className="text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}

        <PropertyPicker
          projectId={projectId}
          categories={['event']}
          exclude={holdProperties}
          onSelect={(action) => {
            dispatch(addHoldProperty(action.value));
          }}
        >
          <button
            type="button"
            className="flex h-8 items-center gap-1 rounded-md border border-border bg-card px-2 text-sm font-medium leading-none"
          >
            <LockIcon size={12} /> Hold property constant
          </button>
        </PropertyPicker>
      </div>
    </div>
  );
}
