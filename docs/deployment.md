# Linux 服务器部署与数据库恢复

> **本文档不构成上线授权。** 公司服务器、正式秘密、HTTPS、真实数据和生产切换仍须人工批准。仓库门禁只证明隔离环境中的首装、升级、备份、新库恢复和登录链路可执行。

## 安全边界

- API 使用容器内 `node` 用户，Web 使用 UID/GID 101；API 不直接暴露，只允许 Web 经专用代理网段访问。
- API `/api/health` 是 liveness，`/api/ready` 同时检查数据库连接和 schema；Web `/healthz` 只检查静态服务。
- 正式 HTTPS 在公司批准的入口层终止。仓库内 HTTP Nginx 不发送 HSTS。
- 数据库使用互不相同的管理员、迁移、应用和只读备份账号。管理员账号不提供给 API。
- API 日志不记录请求体、查询参数、业务对象或秘密；`/internal/metrics` 只允许受控内部网络采集。

## 部署前准备

要求 Docker Engine、Compose v2、足够磁盘空间和一个不与现有网络冲突的专用 `/24` 网段。复制 `.env.example` 为 `.env`，至少替换以下值：

- `APP_ORIGINS`：正式 Web Origin。
- `SAMPLEFLOW_PROXY_SUBNET`：只承载本项目 Web 反向代理的网段，禁止 `0.0.0.0/0`。
- `POSTGRES_PASSWORD`、`DB_MIGRATION_PASSWORD`、`DB_APP_PASSWORD`、`DB_BACKUP_PASSWORD`：四个不同的随机秘密。
- `POSTGRES_*`、`DB_MIGRATION_*`、`DB_APP_*`、`DB_BACKUP_*`：经批准的不同账号。
- `DATABASE_OPERATION_UID`、`DATABASE_OPERATION_GID`：部署账号的 `id -u` 和 `id -g`，不得使用 root；备份目录必须由该账号拥有并可写。
- `BACKUP_DIRECTORY`：宿主机绝对备份目录；正式备份不得留在仓库或容器可写层。

保护 `.env` 和备份目录，只允许部署账号及备份系统读取。不要把秘密写进 Git、命令行参数、工单或日志。

## 首次部署

```sh
docker compose build api web
docker compose up -d --wait db
docker compose --profile operations run --rm db-provision-roles
docker compose --profile operations run --rm db-migrate
docker compose --profile operations run --rm admin-bootstrap
docker compose up -d --wait api web
curl --fail http://127.0.0.1:${WEB_PORT:-8080}/api/ready
```

`admin-bootstrap` 只显示一次临时密码；立即放入批准的秘密管理系统，并用浏览器完成真实登录和改密。首次部署还须人工确认 HTTPS、入口层不能绕过 Web、正式 Secure Cookie、监控采集和告警通知。

## 备份

备份要求 Web/API 已停止，防止业务写入穿过一致性检查。每次使用新的文件名；作业拒绝覆盖已有备份。

```sh
export BACKUP_DIRECTORY=/srv/sampleflow/backups
export BACKUP_FILE_NAME=sampleflow-$(date -u +%Y%m%dT%H%M%SZ).dump
mkdir -p "$BACKUP_DIRECTORY"
docker compose stop web api
docker compose --profile operations run --rm db-backup
ls -l "$BACKUP_DIRECTORY/$BACKUP_FILE_NAME" \
  "$BACKUP_DIRECTORY/$BACKUP_FILE_NAME.sha256" \
  "$BACKUP_DIRECTORY/$BACKUP_FILE_NAME.summary" \
  "$BACKUP_DIRECTORY/$BACKUP_FILE_NAME.summary.sha256"
```

四个文件必须一起保留：PostgreSQL custom archive、archive SHA-256、稳定业务摘要、摘要 SHA-256。随后由批准的备份系统加密复制到异机位置，并按公司确定的 RPO、RTO 和保留期管理；这些生产参数不能由仓库默认值代替。

## 升级

1. 记录当前 Git 提交、镜像标识、数据库名和可用回退版本。
2. 按“备份”章节停写并生成升级前备份；先在新库完成一次恢复验证。
3. 检出批准的目标提交并构建镜像。
4. 执行角色配置和迁移；迁移命令可安全重跑。
5. 启动并验证 readiness、真实管理员登录和关键业务页面。

```sh
docker compose build api web
docker compose --profile operations run --rm db-provision-roles
docker compose --profile operations run --rm db-migrate
docker compose --profile operations run --rm db-migrate
docker compose up -d --wait api web
curl --fail http://127.0.0.1:${WEB_PORT:-8080}/api/ready
```

若 readiness 或登录失败，保持 Web/API 停止，不要继续写入，不要尝试向下迁移。

## 恢复到新库

恢复永不覆盖来源库或已有目标库。`RESTORE_DB_NAME` 必须是新的小写 PostgreSQL 标识符；恢复作业只读挂载备份目录，并校验 archive、两个 SHA-256 和业务摘要。

```sh
export BACKUP_DIRECTORY=/srv/sampleflow/backups
export BACKUP_FILE_NAME=sampleflow-20260901T120000Z.dump
export RESTORE_DB_NAME=sampleflow_restore_20260901
docker compose stop web api
docker compose --profile operations run --rm db-restore-new
```

恢复成功后，用应用账号连接新库运行当前 API，验证 `/api/ready`、真实登录和关键查询；同时确认应用账号不能建表、备份账号不能写数据、`PUBLIC` 没有数据库 `CONNECT`。验证失败时保持新库隔离，不切换来源库。

## 回退

回退使用“升级前备份恢复成新库 + 上一个已验证应用版本”，不覆盖或删除升级后的库：

1. 停止 Web/API，保留升级后数据库供调查。
2. 按上节把升级前备份恢复为新的回退库并完成验证。
3. 将 `.env` 的 `POSTGRES_DB` 指向已验证回退库，切换到记录的上一个应用提交或镜像。
4. 重建/重启 API 与 Web，再验证 readiness、真实登录和关键业务页面。
5. 仅在批准切流后恢复访问；任何旧库删除都属于另一次不可逆人工门禁。

## 轮换数据库秘密

保持数据库管理员连接可用，先停止 Web/API；为迁移、应用、备份账号分别生成新的不同秘密并更新批准的秘密管理系统和 `.env`，再执行：

```sh
docker compose --profile operations run --rm db-provision-roles
docker compose up -d --force-recreate --wait api web
curl --fail http://127.0.0.1:${WEB_PORT:-8080}/api/ready
```

完成真实登录和一次备份验证后，从秘密管理系统中移除已失效的旧版本。管理员秘密通过批准的数据库管理通道单独轮换；不要把秘密放进 shell 参数或日志。

## 故障排查

- `SCHEMA_OUTDATED`：API 使用的 schema 旧于代码；停止 API，核对目标数据库后重跑 `db-migrate`。
- `备份路径已存在或正在由其他进程写入`：确认没有运行中的备份；只删除经核实属于失败作业的同名 `.lock` 目录，或改用新文件名。
- `SHA-256 校验失败` / `不是可解析的 PostgreSQL custom 格式`：隔离该备份，从可信副本重新取得四个文件。
- `目标数据库已存在`：改用全新目标名；不要覆盖、删除或复用现有库。
- `目标迁移、应用或备份角色不存在`：先对明确的目标执行 `db-provision-roles`，不要临时提升应用账号。
- `恢复数据摘要不一致`：保持目标库隔离，核对来源备份和并发写入；不得切流。
- `CLEANUP_FAILED`：立即停止后续动作，按错误中的精确对象人工核对；不得执行宽泛 `docker system prune`、删卷或删目录。
- readiness 失败：查看 `docker compose ps` 与 API JSON 日志，核对数据库名、角色、schema 和代理网段；不要用 liveness 代替 readiness。

## 自动门禁与生产门禁

`npm run test:container-runtime` 会使用随机 Compose 项目、空闲端口、专用网络、临时卷和临时备份目录，完成旧 schema 启动、真实升级、ready/smoke、备份、新库恢复、权限和恢复库登录；成功或失败都只清理该次创建的资源。CI 显式运行同一门禁。

这不等于生产验收。公司服务器、域名/HTTPS、正式秘密托管、真实历史数据、监控告警、异机备份、RPO/RTO、保留期和最终切流仍须人工确认。

Windows 本地开发方式见 [`development.md`](development.md)。
