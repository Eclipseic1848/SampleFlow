create table app_metadata (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

