#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf '%s\n' "[数据库备份恢复] $1" >&2
  exit 2
}

require() {
  [[ -n "${!1:-}" ]] || fail "必须显式设置 $1"
}

require_identifier() {
  require "$1"
  [[ "${!1}" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || fail "$1 必须是最长 63 字节的小写 PostgreSQL 标识符"
}

require_source() {
  for name in SOURCE_DB_HOST SOURCE_DB_PORT SOURCE_DB_NAME SOURCE_DB_USER SOURCE_DB_PASSWORD; do require "$name"; done
  require_identifier SOURCE_DB_NAME
}

database_summary() {
  local host="$1" port="$2" database="$3" user="$4" password="$5"
  PGPASSWORD="$password" psql -X -qAt --set ON_ERROR_STOP=1 \
    --host="$host" --port="$port" --dbname="$database" --username="$user" <<'SQL'
begin isolation level repeatable read read only;
select 'schema_migrations|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from schema_migrations t;
select 'app_metadata|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from app_metadata t;
select 'roles|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from roles t;
select 'users|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from users t;
select 'user_roles|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from user_roles t;
select 'people|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from people t;
select 'org_units|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from org_units t;
select 'org_assignments|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from org_assignments t;
select 'org_memberships|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from org_memberships t;
select 'org_responsibilities|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from org_responsibilities t;
select 'performance_orders|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from performance_orders t;
select 'performance_events|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from performance_events t;
select 'performance_event_analysis_dimensions|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from performance_event_analysis_dimensions t;
select 'goals|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from goals t;
select 'goal_versions|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from goal_versions t;
select 'goal_approvals|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from goal_approvals t;
select 'goal_change_requests|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from goal_change_requests t;
select 'goal_linkage_decisions|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from goal_linkage_decisions t;
select 'accounting_periods|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from accounting_periods t;
select 'accounting_period_closures|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from accounting_period_closures t;
select 'accounting_correction_requests|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from accounting_correction_requests t;
select 'historical_order_reviews|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from historical_order_reviews t;
select 'import_configs|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from import_configs t;
select 'import_batches|'||count(*)||'|'||md5(coalesce(string_agg(((to_jsonb(t)-'source_bytes')||jsonb_build_object('source_bytes_md5',md5(source_bytes)))::text,E'\n' order by ((to_jsonb(t)-'source_bytes')||jsonb_build_object('source_bytes_md5',md5(source_bytes)))::text),'')) from import_batches t;
select 'import_batch_rows|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from import_batch_rows t;
select 'legacy_import_runs|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from legacy_import_runs t;
select 'organization_import_runs|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from organization_import_runs t;
select 'legacy_event_import_reconciliations|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from legacy_event_import_reconciliations t;
select 'legacy_event_source_evidence|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from legacy_event_source_evidence t;
select 'legacy_event_analysis_dimension_backfills|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from legacy_event_analysis_dimension_backfills t;
select 'audit_logs|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from audit_logs t;
select 'sequences|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''))
from (select schemaname,sequencename,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value from pg_sequences where schemaname='public') t;
commit;
SQL
}

source_summary() {
  database_summary "$SOURCE_DB_HOST" "$SOURCE_DB_PORT" "$SOURCE_DB_NAME" "$SOURCE_DB_USER" "$SOURCE_DB_PASSWORD"
}

backup() {
  require_source
  require BACKUP_FILE
  [[ "$BACKUP_FILE" == /* ]] || fail "BACKUP_FILE 必须是容器内绝对路径"
  local directory filename temporary before after sha summary_sha lock lock_created=0 outputs_owned=0 committed=0 output
  directory="$(dirname "$BACKUP_FILE")"
  filename="$(basename "$BACKUP_FILE")"
  [[ "$filename" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || fail "备份文件名只能包含字母、数字、点、下划线和连字符"
  [[ -d "$directory" ]] || fail "备份目录不存在"
  temporary="$BACKUP_FILE.partial.$$"
  before="$BACKUP_FILE.summary.before.$$"
  after="$BACKUP_FILE.summary.after.$$"
  sha="$BACKUP_FILE.sha256.partial.$$"
  summary_sha="$BACKUP_FILE.summary.sha256.partial.$$"
  lock="$BACKUP_FILE.lock"
  cleanup_backup() {
    local status="$1" cleanup_failed=0
    if [[ "$lock_created" == 1 ]]; then
      if ! rm -f -- "$temporary" "$before" "$after" "$sha" "$summary_sha"; then
        printf '%s\n' "[数据库备份恢复] CLEANUP_FAILED：无法删除本次备份临时文件" >&2
        cleanup_failed=1
      fi
      if [[ "$outputs_owned" == 1 && "$committed" != 1 ]]; then
        if ! rm -f -- "$BACKUP_FILE" "$BACKUP_FILE.sha256" "$BACKUP_FILE.summary" "$BACKUP_FILE.summary.sha256"; then
          printf '%s\n' "[数据库备份恢复] CLEANUP_FAILED：无法删除本次未完成备份" >&2
          cleanup_failed=1
        fi
      fi
      if ! rmdir -- "$lock"; then
        printf '%s\n' "[数据库备份恢复] CLEANUP_FAILED：无法释放备份锁 $lock" >&2
        cleanup_failed=1
      fi
    fi
    [[ "$cleanup_failed" == 0 ]] || return 3
    return "$status"
  }
  trap 'cleanup_backup "$?"' EXIT

  mkdir -- "$lock" 2>/dev/null || fail "备份路径已存在或正在由其他进程写入：$filename"
  lock_created=1
  for output in "$BACKUP_FILE" "$BACKUP_FILE.sha256" "$BACKUP_FILE.summary" "$BACKUP_FILE.summary.sha256"; do
    [[ ! -e "$output" ]] || fail "拒绝覆盖已有文件：$(basename "$output")"
  done
  outputs_owned=1
  rm -f -- "$temporary" "$before" "$after" "$sha" "$summary_sha"

  source_summary > "$before"
  PGPASSWORD="$SOURCE_DB_PASSWORD" pg_dump --format=custom --compress=6 --no-owner \
    --host="$SOURCE_DB_HOST" --port="$SOURCE_DB_PORT" --dbname="$SOURCE_DB_NAME" --username="$SOURCE_DB_USER" \
    --file="$temporary"
  pg_restore --list "$temporary" > /dev/null
  source_summary > "$after"
  if ! cmp -s "$before" "$after"; then
    diff -u "$before" "$after" >&2 || true
    fail "来源库在备份期间发生变化，备份已拒绝"
  fi

  printf '%s  %s\n' "$(sha256sum "$temporary" | cut -d' ' -f1)" "$filename" > "$sha"
  printf '%s  %s\n' "$(sha256sum "$before" | cut -d' ' -f1)" "$filename.summary" > "$summary_sha"
  mv -- "$temporary" "$BACKUP_FILE"
  mv -- "$before" "$BACKUP_FILE.summary"
  mv -- "$sha" "$BACKUP_FILE.sha256"
  mv -- "$summary_sha" "$BACKUP_FILE.summary.sha256"
  committed=1
  printf '%s\n' "[数据库备份恢复] 备份、SHA-256 与来源摘要已生成：$filename"
  cleanup_backup 0
  trap - EXIT
}

restore_new() {
  require_source
  require BACKUP_FILE
  local name input
  for name in TARGET_DB_HOST TARGET_DB_PORT TARGET_DB_ADMIN_NAME TARGET_DB_ADMIN_USER TARGET_DB_ADMIN_PASSWORD TARGET_DB_NAME TARGET_DB_OWNER TARGET_DB_OWNER_PASSWORD TARGET_DB_APP_USER TARGET_DB_BACKUP_USER; do require "$name"; done
  require_identifier TARGET_DB_ADMIN_NAME
  require_identifier TARGET_DB_NAME
  require_identifier TARGET_DB_OWNER
  require_identifier TARGET_DB_APP_USER
  require_identifier TARGET_DB_BACKUP_USER
  [[ "$TARGET_DB_OWNER" != "$TARGET_DB_APP_USER" && "$TARGET_DB_OWNER" != "$TARGET_DB_BACKUP_USER" && "$TARGET_DB_APP_USER" != "$TARGET_DB_BACKUP_USER" ]] || fail "目标迁移、应用和备份账号必须不同"
  [[ "$BACKUP_FILE" == /* ]] || fail "BACKUP_FILE 必须是容器内绝对路径"
  local filename source_database source_server target_server existing role_count summary_file target_created=0 committed=0
  filename="$(basename "$BACKUP_FILE")"
  [[ "$filename" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || fail "备份文件名只能包含字母、数字、点、下划线和连字符"
  for input in "$BACKUP_FILE" "$BACKUP_FILE.sha256" "$BACKUP_FILE.summary" "$BACKUP_FILE.summary.sha256"; do
    [[ -f "$input" && ! -L "$input" ]] || fail "备份或清单缺失：$(basename "$input")"
  done
  [[ "$(<"$BACKUP_FILE.sha256")" == "$(sha256sum "$BACKUP_FILE" | cut -d' ' -f1)  $filename" ]] || fail "备份 SHA-256 校验失败"
  [[ "$(<"$BACKUP_FILE.summary.sha256")" == "$(sha256sum "$BACKUP_FILE.summary" | cut -d' ' -f1)  $filename.summary" ]] || fail "摘要 SHA-256 校验失败"
  pg_restore --list "$BACKUP_FILE" > /dev/null || fail "备份不是可解析的 PostgreSQL custom 格式"

  source_database="$(PGPASSWORD="$SOURCE_DB_PASSWORD" psql -X -qAt --set ON_ERROR_STOP=1 --host="$SOURCE_DB_HOST" --port="$SOURCE_DB_PORT" --dbname="$SOURCE_DB_NAME" --username="$SOURCE_DB_USER" --command='select current_database()')"
  [[ "$source_database" == "$SOURCE_DB_NAME" ]] || fail "来源连接未指向显式来源库"
  source_server="$(PGPASSWORD="$SOURCE_DB_PASSWORD" psql -X -qAt --set ON_ERROR_STOP=1 --host="$SOURCE_DB_HOST" --port="$SOURCE_DB_PORT" --dbname="$SOURCE_DB_NAME" --username="$SOURCE_DB_USER" --command="select coalesce(inet_server_addr()::text,'local')||':'||inet_server_port()")"
  target_server="$(PGPASSWORD="$TARGET_DB_ADMIN_PASSWORD" psql -X -qAt --set ON_ERROR_STOP=1 --host="$TARGET_DB_HOST" --port="$TARGET_DB_PORT" --dbname="$TARGET_DB_ADMIN_NAME" --username="$TARGET_DB_ADMIN_USER" --command="select coalesce(inet_server_addr()::text,'local')||':'||inet_server_port()")"
  [[ "$source_server|$SOURCE_DB_NAME" != "$target_server|$TARGET_DB_NAME" ]] || fail "来源库与目标库不能相同"

  existing="$(PGPASSWORD="$TARGET_DB_ADMIN_PASSWORD" psql -X -qAt --set ON_ERROR_STOP=1 --host="$TARGET_DB_HOST" --port="$TARGET_DB_PORT" --dbname="$TARGET_DB_ADMIN_NAME" --username="$TARGET_DB_ADMIN_USER" --command="select 1 from pg_database where datname='$TARGET_DB_NAME'")"
  [[ -z "$existing" ]] || fail "目标数据库已存在，恢复只允许创建新库"
  role_count="$(PGPASSWORD="$TARGET_DB_ADMIN_PASSWORD" psql -X -qAt --set ON_ERROR_STOP=1 --host="$TARGET_DB_HOST" --port="$TARGET_DB_PORT" --dbname="$TARGET_DB_ADMIN_NAME" --username="$TARGET_DB_ADMIN_USER" --command="select count(*) from pg_roles where rolname in ('$TARGET_DB_OWNER','$TARGET_DB_APP_USER','$TARGET_DB_BACKUP_USER')")"
  [[ "$role_count" == 3 ]] || fail "目标迁移、应用或备份角色不存在"

  summary_file="$(mktemp "${TMPDIR:-/tmp}/sampleflow-target-summary.XXXXXX")"
  cleanup_restore() {
    local status="$1" cleanup_failed=0
    rm -f -- "$summary_file" || cleanup_failed=1
    if [[ "$target_created" == 1 && "$committed" != 1 ]]; then
      if ! PGPASSWORD="$TARGET_DB_ADMIN_PASSWORD" dropdb --force --host="$TARGET_DB_HOST" --port="$TARGET_DB_PORT" --username="$TARGET_DB_ADMIN_USER" --maintenance-db="$TARGET_DB_ADMIN_NAME" "$TARGET_DB_NAME"; then
        printf '%s\n' "[数据库备份恢复] CLEANUP_FAILED：未能删除未完成目标库 $TARGET_DB_NAME，请立即隔离并人工清理" >&2
        cleanup_failed=1
      fi
    fi
    [[ "$cleanup_failed" == 0 ]] || return 3
    return "$status"
  }
  trap 'cleanup_restore "$?"' EXIT

  PGPASSWORD="$TARGET_DB_ADMIN_PASSWORD" createdb --host="$TARGET_DB_HOST" --port="$TARGET_DB_PORT" --username="$TARGET_DB_ADMIN_USER" \
    --maintenance-db="$TARGET_DB_ADMIN_NAME" --owner="$TARGET_DB_OWNER" "$TARGET_DB_NAME"
  target_created=1
  PGPASSWORD="$TARGET_DB_OWNER_PASSWORD" pg_restore --exit-on-error --single-transaction --no-owner \
    --host="$TARGET_DB_HOST" --port="$TARGET_DB_PORT" --dbname="$TARGET_DB_NAME" --username="$TARGET_DB_OWNER" "$BACKUP_FILE"
  PGPASSWORD="$TARGET_DB_ADMIN_PASSWORD" psql -X -qAt --set ON_ERROR_STOP=1 \
    --host="$TARGET_DB_HOST" --port="$TARGET_DB_PORT" --dbname="$TARGET_DB_ADMIN_NAME" --username="$TARGET_DB_ADMIN_USER" <<SQL
revoke all on database $TARGET_DB_NAME from public;
grant connect,create,temp on database $TARGET_DB_NAME to $TARGET_DB_OWNER;
grant connect on database $TARGET_DB_NAME to $TARGET_DB_APP_USER,$TARGET_DB_BACKUP_USER;
SQL
  database_summary "$TARGET_DB_HOST" "$TARGET_DB_PORT" "$TARGET_DB_NAME" "$TARGET_DB_OWNER" "$TARGET_DB_OWNER_PASSWORD" > "$summary_file"
  cmp -s "$BACKUP_FILE.summary" "$summary_file" || fail "恢复库 schema、关键数量或稳定摘要与来源不一致"
  committed=1
  printf '%s\n' "[数据库备份恢复] 已恢复并校验新目标库：$TARGET_DB_NAME"
  cleanup_restore 0
  trap - EXIT
}

case "${1:-}" in
  backup) backup ;;
  restore-new) restore_new ;;
  summary) require_source; source_summary ;;
  *) fail "用法：database-operations.sh backup|restore-new|summary" ;;
esac
