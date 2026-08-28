# Linux 服务器部署状态

> **本文档不构成上线授权。** Compose 已将常驻服务与一次性作业分离，但备份恢复、安全加固和公司服务器验收仍属 Issue #15 及独立人工门禁。

## 已验证范围

- 2026-08-27 本地 TypeScript 生产构建通过。
- `docker compose config` 包含常驻 `api`/`web` 以及 `operations` profile 下的显式作业。
- PostgreSQL 16 开发容器可运行。

以上结果不等于生产部署验收。镜像构建和空库启动证据须以当次 CI/验收记录为准。

## 已知阻塞

1. Issue #9 的实现仍处于未提交工作区；尚未以 GitHub 干净克隆验证无原始 Excel 的镜像构建、空库迁移和空系统启动，本地镜像构建也因 Docker Hub EOF 未完成。
2. 数据库迁移账户与应用运行账户尚未分离。
3. 尚未完成首次生产部署、升级、备份和恢复演练。
4. 尚未确定域名、HTTPS 终止、内网访问范围、密钥托管、备份保留期和监控告警。

## 恢复部署资格的入口

- 先完成 [Issue #9](https://github.com/Eclipseic1848/SampleFlow/issues/9) 的提交后干净克隆、镜像和空系统验收，再完成 [Issue #15](https://github.com/Eclipseic1848/SampleFlow/issues/15) 的生产安全、备份恢复、可观测性与部署验收。
- 所有上线动作仍需服务器环境、正式凭据和发布范围的单独人工批准。

完成上述验收前，Windows 本地开发方式见 [`development.md`](development.md)。
