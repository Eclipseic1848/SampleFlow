# Windows 开发运行

双击项目根目录的 `start_all.bat`，脚本会依次：

1. 检查 Docker 和 Node.js；
2. 首次运行时安装 npm 依赖；
3. 启动 PostgreSQL 16 开发容器并等待端口就绪；
4. 执行数据库迁移、开发种子和幂等历史数据导入；
5. 启动后端自动重载和前端热更新；
6. 打开 `http://localhost:5174`。

开发端口：

- 前端：`5174`
- 后端 API：`3000`
- PostgreSQL：`55432`

退出前后端时，在运行 `start_all.bat` 的终端按 `Ctrl+C`。如需停止开发数据库，运行 `stop_all.bat`；该操作保留数据库数据卷。

开发演示账号与角色代码一致，例如销售助理账号为 `sales_assistant`。所有演示账号的初始密码均为 `SampleFlow@2026`，这些账号不会在生产初始化流程中创建。
