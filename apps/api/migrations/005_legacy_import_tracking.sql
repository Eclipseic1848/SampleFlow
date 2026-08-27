create table legacy_import_runs (
  id bigint generated always as identity primary key,
  source_file text not null,
  source_sha256 text not null unique,
  source_rows integer not null check (source_rows >= 0),
  imported_orders integer not null check (imported_orders >= 0),
  imported_events integer not null check (imported_events >= 0),
  imported_at timestamptz not null default now()
);

create unique index performance_events_source_row_uidx
on performance_events (source_row_number)
where source_row_number is not null;
