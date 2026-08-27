# SampleFlow 1.0

SampleFlow 是部署在公司服务器上的销售到样业绩与目标管理 Web 系统。轻流继续作为订单来源，销售助理逐条录入；系统以不可变事件记录首次入账、营业额修改、暂停、重启和首次计入。

## Windows 开发

1. 启动 Docker Desktop。
2. 双击根目录 `start_all.bat`。
3. 浏览器打开 `http://localhost:5174`；前端和后端均支持热更新。

开发演示账号等于角色代码，例如 `sales_assistant`、`sales_manager`、`hr`、`general_manager`、`system_admin`，统一密码为 `SampleFlow@2026`。

## 验证

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Linux 生产部署见 `docs/deployment.md`，业务范围和验收标准见 `docs/v1-scope.md`，统一领域语言见 `CONTEXT.md`，架构决策见 `docs/adr/`。
