## Agent skills

### Issue tracker

任务在 Eclipseic1848/SampleFlow 的 GitHub Issues 中管理；默认只读，任何创建、编辑、评论、标签、关闭等远程写入都需要用户明确授权。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix` 五类标准标签。详见 `docs/agents/triage-labels.md`。

### Domain docs

本项目采用 single-context：先读取 `handoff.md`，再按任务读取根目录 `CONTEXT.md` 和 `docs/adr/`。详见 `docs/agents/domain.md`。
