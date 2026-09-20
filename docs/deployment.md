# Linux 服务器部署与数据库恢复

> **本文档不构成上线授权。** 公司服务器、正式秘密、HTTPS、真实数据和生产切换仍须人工批准。仓库门禁只证明隔离环境中的首装、升级、备份、新库恢复和登录链路可执行。

## 安全边界

- API 使用容器内 `node` 用户，Web 使用 UID/GID 101；API 不直接暴露，只允许 Web 经专用代理网段访问。
- API `/api/health` 是 liveness，`/api/ready` 同时检查数据库连接和 schema；Web `/healthz` 只检查静态服务。
- 正式 HTTPS 在公司批准的入口层终止。仓库内 HTTP Nginx 不发送 HSTS。
- 数据库使用互不相同的管理员、迁移、应用和只读备份账号。管理员账号不提供给 API。
- API 日志不记录请求体、查询参数、业务对象或秘密；`/internal/metrics` 只允许受控内部网络采集。

## Windows 本机公网试用入口

当前已有环境使用 `node scripts/acceptance.mjs start|stop|check|open`，并同时加载 `docker-compose.yml` 与 `docker-compose.acceptance.yml`。不要在现有库重复执行 `init`，也不要省略验收覆盖文件重建 Web。

桌面 `SampleFlow启动公网验收.cmd` 是一键启动／恢复入口：未运行时启动 Docker Desktop，等待本机 Linux 引擎，复用既有数据卷与验收镜像启动四个服务；不构建、不拉新镜像、不迁移、不导入、不改密码。需要已有 Node 24、Docker Desktop、cloudflared、项目依赖及 Playwright Chromium；缺失时停止并提示，不以空库代替恢复。更换程序版本或首次部署仍由维护人员按独立流程处理。

启动器使用回环端口 `18081` 做进程互斥；电脑重启后锁自动释放。它核对隧道 PID、可执行文件、目标端口及创建时间，再查询 cloudflared 动态回环 metrics 的 `/ready`，不以“进程存在”代表连接正常。健康隧道复用网址，失效隧道安全回收并重建。新 URL 会更新精确 `APP_ORIGINS`，重建 API／入口／Web，数据库不重建；入口会话需要重新验证，业务数据和密码保留。

本机保护检查与真实 Chromium 公网入口、系统登录页、API readiness、业务未登录 401 和入口退出检查通过后，才把最新地址写到 `.sampleflow/acceptance/url.txt`。隧道在后台独立运行，可以关闭启动窗口；不会安装开机任务、更改电源、系统代理、DNS 或防火墙。cloudflared 使用 `auto` 协议与自带轮转日志（`tunnel-logs/cloudflared.log`，1MB／最多 5 个轮转文件；另保留上一启动日志）。网络故障时不关闭 TLS 或放宽权限。

Quick Tunnel 重建后地址会变化，不保证旧链接继续有效或客户所有网络可达。负责人必须把本次检查通过的链接发给客户，并请客户在实际办公网／手机网络验收；长期固定地址另行配置域名与 Named Tunnel 或公司服务器。[Cloudflare Quick Tunnel 限制](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

入口通过独立 Node 标准库服务与 Nginx `auth_request` 验证 8 小时会话，不使用会与业务 401 冲突的 HTTP Basic Auth。入口仅挂载盐化密码摘要与允许来源，使用内部网络、只读文件系统、非 root 用户，不连接数据库、不发布端口；静态页面和 API 同受保护，业务 401/403 原样返回，入口故障时拒绝放行。

`configure-entry` 只从本机私密文件重新生成配置；随后须使用完整 Compose 参数重建 `acceptance-gate web` 才生效。入口服务重启会清除入口会话，不清空业务数据。共享电脑先退出系统，再到 `/_entry/logout` 撤销本浏览器入口会话。完整操作见桌面指南和 `handoff.md` 的“当前运行环境与操作入口”。

最小回归：`node --test scripts/acceptance-startup.test.mjs scripts/acceptance-gate.test.mjs scripts/container-contract.test.mjs`；已有验收镜像时再运行 `node --test scripts/acceptance-gate-runtime.test.mjs`，使用临时容器和模拟 API，不连接真实库。启动测试模拟 Docker 未就绪、就绪和超时，不停止宿主 Docker。原生表单页使用 `Referrer-Policy: same-origin` 保留严格来源校验；业务页面响应头不变。[Origin 与表单来源说明](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin)

## 部署前准备

要求 Docker Engine、Compose v2、足够磁盘空间和一个不与现有网络冲突的专用 `/24` 网段。复制 `.env.example` 为 `.env`，至少替换以下值：

- `APP_ORIGINS`：正式 Web Origin。
- `WEB_BIND_ADDRESS`：无外部入口层时为 `0.0.0.0`；由同机反向代理或 Tunnel 转发时应设为 `127.0.0.1`。
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

## 周期维护

由公司批准的外部调度器每天执行一次维护作业；Compose 只提供可重复执行的一次性任务，不内置调度：

```sh
docker compose --profile operations run --rm maintenance-cleanup
```

作业删除过期或撤销后已保留 30 天的会话，以及最后更新超过 30 天且已不再封禁的登录限流记录。运维负责人须监控退出状态与清理数量，并按公司安全策略批准保留期变更；不得用宿主机脚本直接删除数据库记录。

## 备份

备份要求 Web/API 已停止，防止业务写入穿过一致性检查。每次使用新的文件名；作业拒绝覆盖已有备份。

```sh
set -e
export BACKUP_DIRECTORY=/srv/sampleflow/backups
export BACKUP_FILE_NAME=sampleflow-$(date -u +%Y%m%dT%H%M%SZ).dump
mkdir -p "$BACKUP_DIRECTORY"
docker compose stop web api
docker compose --profile operations run --rm db-backup
ls -l "$BACKUP_DIRECTORY/$BACKUP_FILE_NAME" \
  "$BACKUP_DIRECTORY/$BACKUP_FILE_NAME.sha256" \
  "$BACKUP_DIRECTORY/$BACKUP_FILE_NAME.summary" \
  "$BACKUP_DIRECTORY/$BACKUP_FILE_NAME.summary.sha256"
docker compose up -d --wait api web
curl --fail http://127.0.0.1:${WEB_PORT:-8080}/api/ready
```

四个文件必须一起保留：PostgreSQL custom archive、archive SHA-256、稳定业务摘要、摘要 SHA-256。随后由批准的备份系统加密复制到异机位置，并按公司确定的 RPO、RTO 和保留期管理；这些生产参数不能由仓库默认值代替。备份和校验完成前任一步失败时，`set -e` 会让 Web/API 保持停止。若启动或 readiness 检查失败，立即执行 `docker compose stop web api`，告警并保全现场，再由负责人决定恢复路径。

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
