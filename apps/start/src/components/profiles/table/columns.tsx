import { ProjectLink } from '@/components/links';
import { SerieIcon } from '@/components/report-chart/common/serie-icon';
import { formatDateTime, formatTime } from '@/utils/date';
import { getProfileName } from '@/utils/getters';
import type { ColumnDef } from '@tanstack/react-table';
import { isToday } from 'date-fns';

import type { IServiceProfile } from '@openpanel/db';

import { ColumnCreatedAt } from '@/components/column-created-at';
import { ProfileAvatar } from '../profile-avatar';

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
      header: 'Last seen',
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
