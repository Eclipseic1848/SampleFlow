# Linux 服务器部署

1. 安装 Docker Engine 与 Docker Compose 插件。
2. 将项目复制到服务器，在根目录把 `.env.example` 复制为 `.env`，并将 `POSTGRES_PASSWORD` 改为长随机密码。
3. 执行 `docker compose up -d --build`。
4. 浏览器访问 `http://服务器地址:8080`；可通过 `WEB_PORT` 修改对外端口。

API 容器启动时会先执行幂等数据库迁移，再按文件哈希导入 2026 年 1—8 月历史明细。同一源文件不会重复导入。PostgreSQL 数据保存在 `sampleflow_pgdata` 卷中。

正式上线前应在公司网关配置 HTTPS、数据库卷备份和仅内网访问策略。上述基础设施配置需要服务器管理员根据公司环境完成。
