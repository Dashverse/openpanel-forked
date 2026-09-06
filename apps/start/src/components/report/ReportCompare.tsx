import { useDispatch, useSelector } from '@/redux';
import { GitCompareArrowsIcon } from 'lucide-react';
import { Combobox } from '../ui/combobox';
import { changeComparison } from './reportSlice';

export function ReportCompare({ className }: { className?: string }) {
  const dispatch = useDispatch();
  const { chartType, comparison } = useSelector((state) => state.report);
  if (chartType !== 'linear') return null;

  return (
    <Combobox
      icon={GitCompareArrowsIcon}
      className={className}
      placeholder="Display"
      searchable={false}
      value={comparison === 'overall' ? 'overall' : 'none'}
      onChange={(value) => dispatch(changeComparison(value))}
      items={[
        { label: 'None', value: 'none' },
        { label: 'Overall', value: 'overall' },
      ]}
    />
  );
}
