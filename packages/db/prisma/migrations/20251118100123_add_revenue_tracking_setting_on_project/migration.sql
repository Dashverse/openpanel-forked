create table cohorts
(
    id                uuid         default gen_random_uuid() not null
        primary key,
    name              text                                   not null,
    description       text,
    projectId        text                                   not null
        references projects
            on update cascade on delete cascade,
    definition        jsonb                                  not null,
    isStatic         boolean      default false             not null,
    computeOnDemand boolean      default false             not null,
    profileCount     integer      default 0                 not null,
    lastComputedAt  timestamp(3),
    createdAt        timestamp(3) default CURRENT_TIMESTAMP not null,
    updatedAt        timestamp(3) default CURRENT_TIMESTAMP not null
);

alter table cohorts
    owner to postgres;

create index cohorts_project_id_idx
    on cohorts (projectId);