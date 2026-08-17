import { formatDateTime, timeAgo } from '@/utils/date';

export function ColumnCreatedAt({
  children,
  exact = false,
}: {
  children: Date | string;
  // Show the exact timestamp inline instead of relative "X days ago". Used by
  // the Profiles "Last seen" column: it's a sortable analytical column, and
  // relative labels ("5 days ago" for two rows an hour apart) make the sort
  // order look wrong even when it's correct. Relative stays the default
  // elsewhere (friendlier for non-sorted tables).
  exact?: boolean;
}) {
  const date = typeof children === 'string' ? new Date(children) : children;

  if (exact) {
    return <div className="text-muted-foreground">{formatDateTime(date)}</div>;
  }

  return (
    <div className="relative">
      <div className="absolute inset-0 opacity-0 group-hover/row:opacity-100 transition-opacity duration-100">
        {formatDateTime(date)}
      </div>
      <div className="text-muted-foreground group-hover/row:opacity-0 transition-opacity duration-100">
        {timeAgo(date)}
      </div>
    </div>
  );
}

ColumnCreatedAt.size = 150;
