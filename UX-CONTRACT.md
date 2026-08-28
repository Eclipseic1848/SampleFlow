# UX Contract

## Product context

- Audience: 销售助理、销售管理、人事、总经理和系统管理员。
- Primary jobs: 定位并维护业绩台账、核对不可变事件、管理目标与组织权限。
- Target market(s): 中国企业内部使用。
- Active locales: `zh-CN`。
- Language/content register and native-review policy: 简体中文、直接的业务动词；业务负责人验收业务含义。
- Timezone/calendar policy: 公历；业务日与服务端操作时间按 `Asia/Shanghai`，绝对时间保留时区。
- Accessibility target: WCAG 2.2 AA。

## Business-context sources

| Domain / scope | Authoritative source | Source type | Reviewed date |
|---|---|---|---|
| Permission model | `CONTEXT.md`; ADR-0003、0016、0018 | Domain context / ADR | 2026-08-27 |
| Performance lifecycle | ADR-0001、0005、0017、0021 | ADR | 2026-08-27 |
| Account security | ADR-0015、0026、0027 | ADR | 2026-08-27 |
| Import lifecycle | ADR-0022 | ADR | 2026-08-27 |
| Goal lifecycle and allocation | `CONTEXT.md`; ADR-0004、0010、0011 | Domain context / ADR | 2026-08-27 |

## Visual contract

- Project `DESIGN.md`: `DESIGN.md`。
- Token ownership model: 既有运行时 CSS 为规范来源，`DESIGN.md` 镜像已接受值。
- Runtime design-system/token source: `apps/web/src/styles.css`。
- Mapping/export/adapters: CSS 自定义属性直接供 React 页面类名消费。
- Token drift gate: 类型检查、构建、浏览器验收和 premium 静态审计。
- Supported themes: 当前仅浅色内容区与深色侧栏。
- Design-context owner/review policy: 系统级视觉决定需产品负责人确认；功能任务沿用既有令牌。

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | 原生 `select` | 既有表单与本合同 | native | 键盘与浏览器 E2E |
| Date | 原生 `input[type=date]` | `CONTEXT.md` 日期语义 | native | 本地化、键盘与 E2E |
| Form | `Field` + `business-form` | `apps/web/src/App.tsx` | create / edit | 验证 E2E |
| Scrollbar | 全局应用样式 | `apps/web/src/styles.css` | stable-gutter geometry | computed style / browser |
| CRUD | 页面列表 + 共享 `Modal` | 本合同与 API 状态机 | return-to-list / stay-read-only | full-flow E2E |

当前没有批量选择或 Toast；不得在单页建立同名局部替代。若后续引入，先确定共享所有者。

## Component behavior

| Component | Default | Hover | Focus | Active | Disabled | Busy | Error |
|---|---|---|---|---|---|---|---|
| Button | 文字说明动作 | 语义色加深 | 可见焦点环 | 轻微按下 | 降低强调且不可触发 | 尺寸稳定并阻止重复 | 相邻持久文本 |
| Icon button | 必须有名称 | 边框/底色反馈 | 可见焦点环 | 按下反馈 | 不可触发 | 保留尺寸 | 相邻持久文本 |
| Input | 真实标签 | 边框反馈 | 蓝色焦点环 | n/a | 明确只读/禁用 | 搜索保留装饰槽 | 文本说明纠正方式 |
| Search | 可清除、300ms 防抖、IME 安全 | 同 Input | 清除后恢复输入焦点 | Enter 立即查询 | 无权限时不显示 | 保留旧结果并标记加载 | 可重试且不丢查询 |
| Table/list | 语义表格 | 行操作可识别 | 行内按钮可见焦点 | n/a | n/a | 表头和框架稳定 | 区分失败、空集和无结果 |

## Dataset navigation

- Admin tables: 使用服务端边界；订单页 P0 仅提供最大 100 条的服务端精确/模糊定位，完整分页属于 Issue #11。
- Exploratory lists: 当前无。
- URL state: 订单已提交搜索写入 `orderSearch` 查询参数；无路由库时使用 History API，并响应浏览器前进/后退。
- Page size: 订单 P0 临时上限 100；不得声称完整分页。
- Empty/no-results/error/loading treatment: 分别说明“暂无数据”“没有匹配结果”“加载失败可刷新”；后台刷新保留既有结果。
- Back/scroll restoration: 搜索由 URL 恢复；页面保留自然文档滚动。
- Selection scope: 当前不提供批量选择。

## Flow ledger

| Operation | Trigger | Pending | Success destination | Success feedback | Failure recovery | Focus outcome | Source ref |
|---|---|---|---|---|---|---|---|
| Create order | 录入新订单 | 稳定忙碌按钮 | 订单列表 | 刷新后出现新行 | 对话框保留输入与错误 | 返回列表 | ADR-0005 |
| Controlled Excel import | 销售助理/组长选择已批准配置和 `.xlsx` | 先上传并完整预检；确认时悲观等待 | 订单列表 | 组长确认后刷新账本 | 保留文件和行级报告；阻断批次不可确认；警告逐项确认 | 返回订单列表 | ADR-0022、0027 |
| Append event | 确认追加事件 | 稳定忙碌按钮与幂等键 | 订单列表 | 重载服务端投影 | 对话框保留输入与错误，可安全重试 | 返回对应订单上下文 | ADR-0001、0005、0017 |
| Confirm/close period | 组长提交核对 / 人事关闭 | 禁止重复提交 | 治理工作台 | 刷新期间状态与版本 | 保留说明并显示服务端职责冲突 | 原操作区域 | ADR-0017 |
| Controlled correction | 组长申请 / 人事审批 / 组长执行 | 悲观等待；执行使用幂等键 | 治理工作台或执行对话框 | 刷新申请状态和订单投影 | 失败保留金额与原因；过期或撤销不可执行 | 返回对应申请 | ADR-0017 |
| Resolve legacy review | 组长提交结论 / 人事审批 | 原订单保持锁定 | 治理工作台 | 追加独立解析事件并刷新订单 | 驳回仍保持原始事件和待核状态 | 返回对应核对记录 | ADR-0021 |
| Create and sign goal | 有权上级从组织选择器下达 / 责任人签名 | 禁止重复提交，保留表单 | 目标台账 | 刷新具体版本状态 | 保留选择与安全业务错误；父目标变化时重新选择 | 返回目标行 | ADR-0004、0011 |
| Approve goal | 总经理处理顶层 / 人事最终审批 | 悲观等待并锁定版本 | 审批中心 | 刷新并移除已完成待办 | 冲突时保留意见并重新读取 | 返回审批行 | ADR-0004、0011 |
| Change and link goals | 责任人申请 / 直属上级填金额 / 责任人重签 / 人事审批 / 本级负责人联动选择 | 当前生效目标保持不变 | 审批中心 | 新版本生效并生成逐级联动待办 | 拒绝、撤回、失效和并发冲突均保留记录 | 返回对应申请或联动行 | ADR-0004、0010 |
| Search | 订单搜索输入/Enter | 保留旧表格并宣布加载 | 同页 URL 状态 | 结果计数 | 保留查询并提供刷新 | 输入框或结果表 | Issue #4 |
| Cancel/back | 取消/关闭 | 无 | 原列表 | 无 | 未提交表单直接关闭 | 恢复触发按钮 | 既有页面模式 |

## Navigation and responsive behavior

- Route document title policy: 当前单页应用使用 `SampleFlow`；引入正式路由时采用“页面 — SampleFlow”。
- Route error / 403 page behavior: API 403 显示明确权限边界，不把无权限伪装为空数据。
- Breadcrumb/tab/route-state policy: 当前侧栏是单页视图切换；搜索状态使用 URL 参数。
- Sidebar/drawer/bottom-sheet transformation: 桌面侧栏在窄屏收为图标栏并保留可访问名称。
- Responsive table strategy: 保留原生表格和横向滚动，不静默丢列。
- Truncation/full-value access: 关键订单号、原因和事件值允许换行或进入详情查看。
- Focus restoration and sticky-obstruction policy: 模态关闭回到触发点；焦点不得被侧栏或模态标题遮挡。

## Overlays and feedback

- Dialog primitive: 共享 `Modal`，拥有焦点进入、Tab 循环、Escape、背景隔离和触发点恢复。
- Destructive confirmation levels: 当前事件为不可变财务写入，使用明确“确认追加事件”并等待服务器确认；不使用浏览器原生对话框。
- Toast placement/duration/deduplication: 当前未建立共享 Toast；关键结果保留在页面/对话框中。
- Alert/banner scope and persistence: 表单错误留在表单，权限限制留在页面。
- Tooltip delay/dismissal: 当前不依赖工具提示传递必要信息。
- Unsaved-changes behavior: 当前短表单关闭即放弃未提交值；长流程若引入须建立共享离开保护。
- Layer/z-index contract: 模态遮罩高于应用外壳；不嵌套模态。

## Async and resilience

- Mutation default: 金额、权限和审批写入均采用悲观确认。
- Idempotency and duplicate-submit policy: 业绩事件每次提交使用稳定幂等键，忙碌时禁用重复提交；未知结果可用相同键重试。
- Auto-save/draft recovery: 当前不自动保存。
- Offline/read-stale/write behavior: 读取刷新时可保留旧内容；写失败保留输入，不离线排队。
- Retry/backoff/timeout behavior: 只自动取消过期搜索；财务写入不自动重复。
- Version conflict and multi-tab behavior: 服务端锁、状态机与幂等约束为准，前端成功后重新读取。
- Session expiry/re-authentication: 401 回到登录流程；403 显示权限或首次改密门禁。
- Long-running progress and return path: 当前无长任务。
- Stale-request cancellation/invalidation and pending-state ownership: 搜索使用 `AbortController`；最新查询拥有加载状态。
- Dialog/form preservation and retry after mutation failure: 失败保持对话框、原因和金额，使用同一幂等键重试。

## Validation

- Schema/validation layer: 服务端 Zod 是权威；前端提供必要格式提示。
- Trigger timing: 提交时校验，错误字段后续编辑时清除相关提示。
- Error summary/inline policy: 短表单使用表单内持久错误；不得只显示瞬时提示。
- Server error mapping: 显示安全的 API 业务消息，不呈现堆栈或原始数据库错误。
- Sensitive-value handling: 密码默认遮蔽且不写入 URL、日志或持久客户端存储。
- `noValidate`, first-invalid focus, duplicate-submit prevention, unsaved changes, and submit recovery: 产品表单使用 `noValidate`；写入按钮有忙碌状态；失败保留非敏感输入。

## Permission and clipboard

- Permission UI strategy: 无权限导航隐藏；可读不可写页面保留数据并说明角色边界；服务端始终重新授权。
- Clipboard copy policy: 当前无共享复制功能。
- Disabled-state explanation: 业务状态不允许操作时显示文本原因，不只禁用按钮。

## Verification

- Required static commands: Web/API 类型检查、Web 构建、项目测试、premium strict audit。
- Browser/device/locale/theme matrix: Chromium 桌面与 390px 窄屏、`zh-CN`、当前主题。
- Accessibility checks: 键盘搜索、清除、模态焦点循环/Escape、语义表格和可访问名称。
- Component-state/visual regression coverage: 项目当前无 Storybook；关键状态由 Playwright E2E 覆盖。
- Canonical sibling flow used for comparison: 账号管理列表与共享 `Modal` 表单。
- CRUD full-flow evidence: `apps/web/e2e/login.spec.ts` 中订单事件链与组长核对、HR 关账、更正审批用例。
- Failure-path evidence: API 账本治理集成测试与浏览器无结果/非法状态检查。
