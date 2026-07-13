import { ProjectLink } from '@/components/links';
import { SerieIcon } from '@/components/report-chart/common/serie-icon';
import { useProfilesSort } from '@/hooks/use-profiles-sort';
import { formatDateTime, formatTime } from '@/utils/date';
import { getProfileName } from '@/utils/getters';
import type { ColumnDef } from '@tanstack/react-table';
import { isToday } from 'date-fns';
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';

import type { IServiceProfile } from '@openpanel/db';

import { ColumnCreatedAt } from '@/components/column-created-at';
import { ProfileAvatar } from '../profile-avatar';

// Clickable "Last seen" header — toggles created_at asc/desc, Mixpanel-style.
function LastSeenHeader() {
  const { dir, toggleDir } = useProfilesSort();
  return (
    <button
      type="button"
      onClick={toggleDir}
      className="group flex items-center gap-1 select-none hover:text-foreground"
      title={`Sorted ${dir === 'desc' ? 'newest first' : 'oldest first'} — click to flip`}
    >
      Last seen
      {dir === 'desc' ? (
        <ArrowDownIcon className="size-3.5 opacity-70" />
      ) : (
        <ArrowUpIcon className="size-3.5 opacity-70" />
      )}
    </button>
  );
}

export function useColumns(type: 'profiles' | 'power-users') {
  const columns: ColumnDef<IServiceProfile>[] = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => {
        const profile = row.original;
        return (
          <ProjectLink
            href={`/profiles/${profile.id}`}
            className="flex items-center gap-2 font-medium"
            title={getProfileName(profile, false)}
          >
            <ProfileAvatar size="sm" {...profile} />
            {getProfileName(profile)}
          </ProjectLink>
        );
      },
    },
    {
      accessorKey: 'email',
      header: 'Email',
      cell: ({ row }) => <span className="truncate">{row.original.email}</span>,
    },
    {
      accessorKey: 'id',
      header: 'Distinct ID',
      cell: ({ row }) => (
        <span className="truncate font-mono text-xs text-muted-foreground">
          {row.original.id}
        </span>
      ),
    },
    {
      accessorKey: 'createdAt',
      // Sortable only on the profiles list (power-users uses a different query).
      header: type === 'profiles' ? () => <LastSeenHeader /> : 'Last seen',
      size: ColumnCreatedAt.size,
      cell: ({ row }) => (
        <ColumnCreatedAt>{row.original.createdAt}</ColumnCreatedAt>
      ),
    },
    {
      accessorKey: 'country',
      header: 'Country',
      cell({ row }) {
        const { country } = row.original.properties;
        return (
          <div className="flex min-w-0 items-center gap-2">
            <SerieIcon name={country} />
            <span className="truncate">{country}</span>
          </div>
        );
      },
    },
    {
      accessorKey: 'region',
      header: 'Region',
      cell: ({ row }) => (
        <span className="truncate">{row.original.properties.region}</span>
      ),
    },
    {
      accessorKey: 'city',
      header: 'City',
      cell: ({ row }) => (
        <span className="truncate">{row.original.properties.city}</span>
      ),
    },
  ];

  if (type === 'power-users') {
    columns.unshift({
      accessorKey: 'count',
      header: 'Events',
      cell: ({ row }) => {
        const profile = row.original;
        // @ts-expect-error
        return <div>{profile.count}</div>;
      },
    });
  }

  return columns;
}
