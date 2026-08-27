---
status: accepted
---

# 使用 Docker Compose 部署到公司 Linux 服务器

SampleFlow 1.0 的生产环境为公司 Linux 服务器，使用 Docker Compose 编排应用及其依赖。Windows 仅作为本地开发环境，生产运行不依赖 Windows 桌面程序、批处理文件或人工保持终端窗口开启。

## Consequences

- 生产交付必须包含可复现的容器构建文件、Compose 配置、环境变量模板、数据库迁移入口、健康检查和部署说明。
- 生产数据必须使用持久化卷或受管数据库保存，删除或重建应用容器不得导致业务数据丢失。
- `start_all.bat` 只负责 Windows 开发体验；生产环境使用 Linux 部署和运维命令，两者共享同一套业务代码与数据库结构。
- 上线前必须验证服务器架构、端口、磁盘、备份位置、访问入口和 HTTPS 终止方式。
