# SampleFlow

[![SampleFlow quality gate](https://github.com/Eclipseic1848/SampleFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Eclipseic1848/SampleFlow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

SampleFlow 是面向销售到样业务的业绩与目标管理 Web 系统。它将角色权限、带生效日期的组织任职、不可变业绩事件、目标实名确认与审批和受控 Excel 导入放在同一套可审计流程中。

> 当前成熟度：P0 与可自动验收的 P1 桌面 Web／仓库工程能力已完成；真实组织数据落库、业务 UAT 和公司服务器生产验收仍是人工 Gate，完成前不能视为生产系统。

## 核心能力

- 系统账号、首次改密、会话安全和角色权限矩阵。
- 部门、小组、人员身份和带有效期的组织任职。
- 以“分子”Sheet3 字段为准的订单台账与只追加、不覆盖的业绩事件链；关键识别/操作列固定，中间字段可横向滚动；负数系统营业额明确标记为“应收未收”。
- 所有数据表格和可增长业务清单统一分页：默认 20 条，可选 10／20／50／100 条，并可直接点击页码；订单、审计和分析穿透使用 URL 快照保持跨页结果稳定。
- 按事件发生日期固化人员及组织快照，保留调组前后的历史归属。
- 省份与客户单位分析支持按月、按年汇总和穿透，未取得来源证据的维度明确显示为待补齐。
- 分层目标下达、责任人实名确认、总经理/人事审批和修改申请。
- 人工录入与受控 `.xlsx` 导入；标准模板覆盖日期、客户单位、省份、组织、服务类型、备注及协作分配，预检、确认、回滚和幂等证据分离。
- PostgreSQL、React、Fastify 和 Docker Compose 组成的模块化单体。

## 项目状态

- GitHub Issue #1—#9 的 P0 工作已关闭；P1 当前状态以 `handoff.md` 与 Roadmap #18 为准。
- `main` 受保护，Pull Request 必须通过 `Typecheck, test, build and audit`。
- 经明确授权后，本地开发库已完成真实历史工作簿的来源核对、4,701 条分析维度补齐和旧迁移日期偏移修复；原文件、行级业务数据和备份不在仓库中，这不代表业务 UAT 或生产迁移完成。
- P1 产品化与人工验收由 [Roadmap #18](https://github.com/Eclipseic1848/SampleFlow/issues/18) 跟踪；当前产品仅验收 1024px/1280px 桌面 Web，移动端 #57 已取消；未完成项只剩真实数据 UAT 与公司服务器验收。
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

在“订单业绩 → Excel 导入”下载标准模板。标准模板只读取名为“分子”的工作表，表头与原始 Sheet3 业务字段一致；一行代表一笔新订单，订单编号同时作为稳定来源标识。上传后先预检，只有获授权角色显式确认才写入正式账本。专用历史导入仍使用独立配置，并要求来源哈希、逐月基线、组织映射和重复检测。

`系统营业额` 允许为负，负数表示应收未收。填写协作人时必须同时填写 0—1 之间的协作比例；个人、组别和部门业绩按比例拆分，公司总额不重复增加。完整规则见 [`docs/performance-import.md`](docs/performance-import.md)。

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
