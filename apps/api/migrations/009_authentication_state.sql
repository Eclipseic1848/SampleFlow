create table auth_login_throttles (
  scope text not null check (scope in ('account', 'ip')),
  throttle_key text not null,
  window_started_at timestamptz not null,
  failure_count integer not null check (failure_count >= 0),
  blocked_until timestamptz,
  updated_at timestamptz not null,
  primary key (scope, throttle_key)
);

create index auth_login_throttles_blocked_until_idx
on auth_login_throttles (blocked_until)
where blocked_until is not null;

update users
set temporary_password_expires_at = now() + interval '24 hours'
where must_change_password and temporary_password_expires_at is null;

update sessions
set revoked_at = now()
where revoked_at is null and csrf_token_hash is null;
