---
status: accepted
---

# 开发与生产统一使用 PostgreSQL

SampleFlow 1.0 在 Windows 开发环境和 Linux 生产环境统一使用 PostgreSQL 16，不使用 SQLite 作为开发替代。Windows 开发时由 `start_all.bat` 启动 PostgreSQL 容器；Linux 生产环境由 Docker Compose 管理 PostgreSQL，并使用持久化存储保存正式数据。

## Consequences

- 数据库约束、事务、并发和查询行为可以在开发阶段按生产环境真实验证。
- `start_all.bat` 必须检查 Docker 是否可用，启动数据库并等待健康检查通过后，再启动后端和前端开发服务。
- 生产 Compose 配置必须配置持久化卷、健康检查、非默认凭据和备份入口；重建应用容器不得删除业务数据。
- 数据库结构变更必须通过可重复执行的迁移管理，不能依赖人工修改生产表。
- 本地首次启动可能需要下载 PostgreSQL 镜像和安装项目依赖，启动脚本必须显示进度及失败原因。
