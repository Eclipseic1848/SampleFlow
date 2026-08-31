# SampleFlow

[![P0 quality gate](https://github.com/Eclipseic1848/SampleFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Eclipseic1848/SampleFlow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

SampleFlow 是面向销售到样业务的业绩与目标管理 Web 系统。它将角色权限、带生效日期的组织任职、不可变业绩事件、目标签名审批和受控 Excel 导入放在同一套可审计流程中。

> 当前成熟度：P0 工程与功能门禁已完成，可用于隔离的内部功能验收；尚未完成真实组织数据落库、业务 UAT 或公司服务器生产部署，不能视为生产系统。

## 核心能力

- 系统账号、首次改密、会话安全和角色权限矩阵。
- 部门、小组、人员身份和带有效期的组织任职。
- 订单台账与只追加、不覆盖的业绩事件链。
- 按事件发生日期固化人员及组织快照，保留调组前后的历史归属。
- 分层目标下达、责任人签名、总经理/人事审批和修改申请。
- 人工录入与受控 `.xlsx` 导入；预检、逐月核对、确认、回滚和幂等证据分离。
- PostgreSQL、React、Fastify 和 Docker Compose 组成的模块化单体。

## 项目状态

- GitHub Issue #1—#9 的 P0 工作已关闭。
- `main` 受保护，Pull Request 必须通过 `Typecheck, test, build and audit`。
- 真实历史工作簿已在隔离临时数据库完成功能核对；原文件和行级业务数据不在仓库中。
- P1 产品化与部署工作由 [Roadmap #18](https://github.com/Eclipseic1848/SampleFlow/issues/18) 跟踪。
- 当前事实、数据边界和接手步骤以 [`handoff.md`](handoff.md) 为准。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Web | React 19、Vite 8、TypeScript |
| API | Fastify 5、TypeScript |
| 数据库 | PostgreSQL 16 |
| 测试 | Node.js Test Runner、Playwright、隔离 PostgreSQL |
| 运行 | npm workspaces、Docker Compose、Nginx |

要求 Node.js 24 或更高版本、npm 和 Docker。

## Windows 本地开发

```powershell
git clone https://github.com/Eclipseic1848/SampleFlow.git
Set-Location SampleFlow
npm.cmd ci
.\start_all.bat
```

开发入口：

- Web：`http://localhost:5174`
- API：`http://localhost:3000`
- PostgreSQL：`localhost:55432`

`start_all.bat` 会显式执行数据库迁移和开发 seed，但不会自动导入历史业务 Excel。停止前先核对端口和容器，避免影响同机其他项目。更多说明见 [`docs/development.md`](docs/development.md)。

## 验证

在 Windows PowerShell 中运行：

```powershell
npm.cmd run verify
```

该命令执行类型检查、API/浏览器测试、生产构建、生产依赖审计和 Compose 配置校验。绿色结果是工程证据，不代表生产部署、真实数据迁移或业务 UAT 已完成。

## Excel 导入与数据边界

在“订单业绩 → Excel 导入”下载标准模板。上传后先预检，只有获授权角色显式确认才写入正式账本。专用历史导入还要求来源哈希、逐月基线、组织映射和重复检测。

不要提交、上传到 Issue/PR 或写入日志：

- 真实客户、员工、订单或人事映射；
- 原始 `.xlsx`/`.docx` 业务文件；
- 密码、会话令牌、数据库备份或生产配置；
- 包含敏感信息的截图和测试输出。

导入规则见 [`docs/performance-import.md`](docs/performance-import.md)，组织迁移见 [`docs/organization-import.md`](docs/organization-import.md)。

## 仓库结构

```text
apps/api/        Fastify API、领域服务、迁移和隔离测试
apps/web/        React Web 与 Playwright E2E
docs/adr/        已确认的架构与业务决策
docs/agents/     Issue、标签和领域文档约定
docs/testing/    P0 回归矩阵
```

领域语言见 [`CONTEXT.md`](CONTEXT.md)，部署资格边界见 [`docs/deployment.md`](docs/deployment.md)。

## 参与项目

- 贡献代码前阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md) 和 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
- 一般缺陷与需求使用 [GitHub Issues](https://github.com/Eclipseic1848/SampleFlow/issues)。
- 未公开的安全问题按 [`SECURITY.md`](SECURITY.md) 私密报告，不要创建公开 Issue。

## 许可证

本项目采用 [MIT License](LICENSE)。
