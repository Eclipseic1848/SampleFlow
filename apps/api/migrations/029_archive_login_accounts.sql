-- 删除登录入口时保留人员身份和历史业务引用；旧版本也不能启用已删除账号。
alter table users add column deleted_at timestamptz;
alter table users add constraint users_deleted_inactive check (deleted_at is null or not is_active);
