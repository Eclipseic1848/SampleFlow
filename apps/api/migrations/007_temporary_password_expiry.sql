alter table users
add column temporary_password_expires_at timestamptz;

create index users_temporary_password_expiry_idx
on users (temporary_password_expires_at)
where must_change_password;
