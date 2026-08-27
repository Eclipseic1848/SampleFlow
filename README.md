# SampleFlow

SampleFlow 是销售到样业绩与目标管理 Web 系统的技术原型。正式交付目标仍是公司 Linux 服务器上的多用户 Web 系统，但当前版本尚未完成业务闭环、端到端验收或生产部署验收，不能作为正式生产 1.0 使用。

## 当前状态

- 已具备账号登录、订单与不可变业绩事件、目标流程、组织维护、看板和导出等基础骨架。
- 已导入本地 `原始数据1.xlsx` 的 2026 年 1—8 月明细，但历史人员尚未与系统账号和有效组织任职建立完整映射。
- 2026-08-27 严格审计确认了权限、组织、目标流程、历史订单调整、首次改密及部署链路等 P0 缺口。
- 当前阶段是“审计完成，v1.1 Gate A 尚未开始”。权威交接状态见 [`handoff.md`](handoff.md)，执行路线见 [GitHub Roadmap #18](https://github.com/Eclipseic1848/SampleFlow/issues/18)。

## Windows 开发

1. 启动 Docker Desktop。
2. 双击根目录 `start_all.bat`。
3. 浏览器打开 `http://localhost:5174`；前端和后端均支持热更新。

本地演示账号名等于角色代码，例如 `sales_assistant`、`sales_manager`、`hr`、`general_manager`、`system_admin`，统一初始密码为 `SampleFlow@2026`。这些仅用于本地开发；当前服务端尚未完整强制首次改密，严禁将演示凭据用于生产。

## 基础验证

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

这些命令通过只代表基础工程检查，不代表业务验收或生产就绪。开发说明见 [`docs/development.md`](docs/development.md)；领域语言见 [`CONTEXT.md`](CONTEXT.md)；架构决策见 [`docs/adr/`](docs/adr/)；计划中的 1.0 范围基线见 [`docs/v1-scope.md`](docs/v1-scope.md)。当前生产部署链路已知不可用于全新克隆，详见 [`docs/deployment.md`](docs/deployment.md)。
