# Issue Tracker：GitHub

本项目的任务和 Roadmap 位于：

- 仓库：`Eclipseic1848/SampleFlow`
- Tracker：GitHub Issues
- 操作工具：`gh` CLI

## 权限边界

读取 Issue、标签、评论和依赖关系属于只读核对，可以直接执行。

以下操作属于 GitHub 远程写入，必须事先获得用户明确授权：

- 创建或编辑 Issue
- 添加评论
- 创建、应用或移除标签
- 创建或修改 Issue 依赖关系
- 分配负责人
- 关闭或重新打开 Issue
- 创建、编辑或合并 Pull Request
- 修改分支保护、仓库可见性或其他仓库设置

对一个 Issue 的实现授权不自动包含上述远程操作。

## 读取约定

- 读取 Issue：`gh issue view <number> --comments`
- 列出 Issue：使用 `gh issue list` 并同时读取正文、标签和评论
- 读取前实时确认状态，不依赖 handoff 中的旧快照
- GitHub Issue 和 PR 共用编号时，先确认对象类型

## 写入约定

Skill 要求“发布到 Issue Tracker”时，应先展示拟发布内容并等待用户批准；批准后才创建或更新 GitHub Issue。

多行正文优先通过 UTF-8 临时文件和 `--body-file` 传递，避免 PowerShell 转义破坏中文内容。

## Pull Request 作为需求入口

PRs as a request surface：no。

外部 PR 不自动进入需求 triage 流程。

## 依赖关系

优先使用 GitHub 原生 Issue dependencies 表达 blocking edges。

如果原生依赖不可用，可在 Issue 正文顶部使用：

`Blocked by: #<number>, #<number>`

创建或修改依赖关系仍属于远程写入，必须先获得用户授权。
