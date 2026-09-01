# Linux 服务器部署状态

> **本文档不构成上线授权。** Compose 已将常驻服务与一次性作业分离；公司服务器、正式秘密、HTTPS、备份恢复和监控告警仍属 Issue #15 及独立人工门禁。

## 容器与 HTTP 安全边界

- API 以 Node 镜像内置的 `node` 用户运行，Web 以 unprivileged Nginx 的 UID/GID 101 运行；两者均不得以 UID 0 启动。
- 隔离默认上限为 API `1 CPU / 512 MiB`、Web `0.5 CPU / 128 MiB`、PostgreSQL `2 CPU / 1 GiB`。所有 Compose 服务的 `json-file` 日志轮转为 `10m × 5`；公司服务器验收时只能基于实测收紧或调整。
- API `/api/health` 是不访问数据库的 liveness；`/api/ready` 同时检查数据库连接和 schema 版本。API 容器以 readiness 判定健康。Web `/healthz` 只验证静态服务自身，不把 API 或数据库状态伪装成 Web liveness。
- Web 为浏览器唯一入口并覆盖传入的 `X-Forwarded-For`、`X-Forwarded-Proto`；API 不得直接暴露。Compose 只让 Web 与 API 进入 `SAMPLEFLOW_PROXY_SUBNET` 专用 `/24` 网络，并把同一网段传给 API 的 `TRUST_PROXY_CIDR`；部署前须选择不冲突的专用网段，禁止使用 `0.0.0.0/0` 或包含不受信主机的网段。
- 正式 HTTPS 由公司批准的入口层终止，再转发到 Web；入口层负责证书、TLS 策略和 HSTS。仓库内 HTTP Nginx 故意不发送 HSTS。上线验收必须确认浏览器只走 HTTPS、生产 Secure Cookie 生效，且入口不绕过 Web 直连 API。
- Web 响应设置同源 CSP、`nosniff`、`no-referrer`、禁用摄像头／麦克风／定位及 `same-origin` opener；地图缓存响应保留同一组安全头。

## 已验证范围

- 2026-08-28，提交 `940e156` 的全量 `npm.cmd run verify` 通过：API 113/113、Web E2E 9/9、类型检查、生产构建、生产依赖审计和 Compose 配置均通过。
- 从该提交创建的本地 Git 干净克隆不含原始业务 Excel/Word，仅含公开标准模板；API/Web 镜像可从干净克隆构建。
- 独立 Compose 项目 `sfissue9940e156` 在未占用的 `18081` 端口完成空库启动：18 个迁移由显式 `db-migrate` 作业执行，API 与 PostgreSQL 健康，`/api/ready` 返回 200。
- 空系统的账号、订单、业绩事件和导入批次计数均为 0；验收完成后独立容器和数据卷已全部移除。
- 运行中 API 镜像不含 `.xlsx`、`.xls` 或 `.docx`；Web 镜像仅含 `SampleFlow标准业绩导入模板.xlsx`。

以上是本地干净克隆部署证据，不等于公司服务器或生产部署验收。

## 已知阻塞

1. 真实历史 Excel 的逐月基准核验、受控预检、4,701 事件／2,850 订单／14,675,659.07 元正式导入及重跑幂等仍属生产数据人工门禁；不能用合成测试替代。
2. 历史组织负责人及生效日期仍需人事提供权威映射，详见 Issue #3。
3. 数据库角色分离已具备仓库内隔离测试；正式账号、秘密轮换和公司服务器验收仍未执行。
4. 尚未完成首次生产部署、升级、备份和恢复演练。
5. 尚未确定域名、HTTPS 终止、内网访问范围、密钥托管、备份保留期和监控告警。

## 恢复部署资格的入口

- Issue #9 的代码、干净克隆、镜像和空系统证据已经完成；取得真实数据和人事映射授权后，执行真实历史迁移验收。
- 随后完成 [Issue #15](https://github.com/Eclipseic1848/SampleFlow/issues/15) 的生产安全、备份恢复、可观测性与公司服务器部署验收。
- 所有上线动作仍需服务器环境、正式凭据和发布范围的单独人工批准。

完成上述验收前，Windows 本地开发方式见 [`development.md`](development.md)。

## 数据库角色配置

生产数据库使用三个不同登录账号：迁移账号拥有数据库结构，应用账号仅有业务表 DML，备份账号仅有读取权限。数据库管理员账号只用于显式配置这些角色，不提供给 API。

首次安装和既有库升级都按以下顺序显式执行。角色配置同时设置现有对象和迁移账号未来创建对象的权限：

```sh
docker compose stop api
docker compose --profile operations run --rm db-provision-roles
docker compose --profile operations run --rm db-migrate
docker compose up -d db api web
```

执行前必须在部署环境注入 `POSTGRES_*` 管理凭据，以及账号名、密码均互不相同的 `DB_MIGRATION_*`、`DB_APP_*`、`DB_BACKUP_*` 凭据。首次安装时 `docker compose stop api` 是无操作；既有库升级必须先停止 API，并先完成备份和恢复路径验证。角色配置命令可重复执行；它不迁移业务数据、不初始化管理员，也不执行备份。回退时保持 API 停止，恢复原连接凭据和升级前备份，不删除现有角色或数据。
