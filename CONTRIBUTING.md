# 为 SampleFlow 贡献

感谢参与 SampleFlow。项目仍处于内部功能验收到产品化之间，贡献应优先保持业务规则、权限边界和真实数据安全。

参与前请阅读 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。安全漏洞不要创建公开 Issue，改用 [`SECURITY.md`](SECURITY.md) 中的私密渠道。

## 开始之前

非琐碎改动应先查找或创建对应 GitHub Issue，并与维护者确认范围。一个 Pull Request 只解决一个明确问题，不顺手重构无关代码。

不得提交：

- 真实 Excel/Word、客户或员工信息、人事映射；
- 密码、令牌、`.env`、数据库备份或生产日志；
- 未脱敏的截图、测试输出或导出文件；
- 未获许可的第三方代码或素材。

## 开发环境

需要 Node.js 24+、npm、Docker 和 Git。

```powershell
git clone https://github.com/Eclipseic1848/SampleFlow.git
Set-Location SampleFlow
npm.cmd ci
.\start_all.bat
```

默认开发端口是 Web 5174、API 3000、PostgreSQL 55432。启动或停止前先核对端口与容器，避免影响其他项目。

## 分支与实现

1. 从最新 `main` 创建短生命周期分支。
2. 先用测试复现缺陷或固定新行为。
3. 选择最小、可回滚、符合现有模块边界的改动。
4. 业务含义或难逆设计发生变化时，更新 `CONTEXT.md` 或新增 ADR。
5. 所有中文文件使用 UTF-8；代码注释使用中文并解释“为什么”。

不要把权限只做在前端；API 直接调用必须执行同样的授权和校验。不要覆盖不可变业绩事件，也不要用当前组织重算历史快照。

## 必需验证

提交前运行：

```powershell
npm.cmd run verify
git diff --check
```

根据改动补充最小回归测试。数据库测试必须使用仓库提供的隔离测试数据库机制，不能连接开发或生产数据库。涉及页面流程时补充或更新 Playwright E2E。

## Pull Request

Pull Request 应包含：

- 关联 Issue 和明确的问题陈述；
- 实际修改内容及未修改的边界；
- 测试命令与可复现结果；
- 数据、权限、迁移或兼容性风险；
- 必要时的截图，但只能使用合成或脱敏数据。

`main` 受保护。Pull Request 必须通过 `Typecheck, test, build and audit`，维护者才会合并。CI 绿色不自动代表业务 UAT、生产迁移或发布获批。

## 提交与许可

提交信息应简短说明意图，例如：

```text
fix: reject overlapping organization memberships
docs: clarify controlled Excel import
```

提交贡献即表示你有权提供这些内容，并同意按仓库的 [MIT License](LICENSE) 许可你的贡献。
