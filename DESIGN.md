---
version: alpha
name: "SampleFlow"
description: "以不可变业绩账本为核心的中文销售运营后台，强调责任、顺序与可追溯性。"
colors:
  navy: "#14243A"
  primary: "#2F6FED"
  success: "#1D9B84"
  danger: "#B83A3A"
  warning: "#AD6D00"
  text: "#14243A"
  muted: "#66758A"
  border: "#DFE5EC"
  canvas: "#F5F7FA"
  surface: "#FFFFFF"
typography:
  sans:
    fontFamily: '"Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif'
  data:
    fontFamily: '"Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif'
rounded:
  sm: "0.3125rem"
  DEFAULT: "0.4375rem"
  md: "0.5rem"
  lg: "0.625rem"
spacing:
  control-height: "2.5rem"
  page-inline: "2.375rem"
  panel-gap: "1.25rem"
components:
  button: {}
  input: {}
  table: {}
  dialog: {}
  status: {}
---

# SampleFlow Design System

## Overview

### Creative North Star

界面参考企业内部的“蓝色审计账簿”：克制、精确、可逐行核对。信息顺序本身就是视觉结构，事件编号、金额正负、状态和责任人比装饰更重要。

### Product context and register

- **受众与主要任务：** 中文环境中的销售助理、销售管理、人事和系统管理员；高频定位订单、核对业绩链路并执行权限内操作。
- **目标市场与证据：** 当前产品文案、角色和业务规则均面向中国企业内部使用；权威业务语义见 `CONTEXT.md` 与 `docs/adr/`。
- **语言策略：** 当前界面仅简体中文，日期按业务规则使用 `Asia/Shanghai`，金额按人民币显示。
- **使用场景：** 桌面浏览器为主，同时保证窄屏可查看和执行关键操作；台账信息密度高。
- **界面语域：** 产品后台。任务清晰度、熟悉度和审计可信度优先于品牌表达。
- **识别元素：** 不可变事件链使用稳定序号形成“账簿流水线”，让计算顺序一眼可追踪。
- **克制边界：** 表单、权限、金额与状态不使用装饰性动效、渐变或模糊玻璃效果。
- **反例：** 不做营销落地页式大留白，不用无意义渐变卡片，不用仅靠颜色表达财务或审批状态。
- **令牌所有权：** 现有运行时 CSS `apps/web/src/styles.css` 是规范值来源；本文件镜像并解释已接受的共享值。功能改动不迁移令牌所有权。

## Colors

深蓝 `navy` 表达审计与责任，`primary` 仅用于当前导航和主要安全操作。绿色、红色、琥珀色分别用于成功、失败/负向和警示，始终配合文字。`surface` 与细边框建立层级，不以阴影堆叠普通内容。

## Typography

界面使用现有中文系统字体栈，避免远程字体造成延迟和指标跳动。标题通过字号与字重建立层级；表格、日期、序号和金额保持可扫描的紧凑数字排版。正文不使用全大写或装饰性斜体。

## Layout

桌面保持 224px 固定侧栏和自然文档滚动；内容页使用现有 38px 横向留白与 20px 面板间距。数据表在窄屏保留语义表格并横向滚动，不静默隐藏列。对话框在视口内滚动，标题和关闭入口持续可达。

## Elevation & Depth

静态面板以白色表面和 `border` 分层；仅模态层使用遮罩与阴影表达临时任务上下文。表头或关键控制可用实色背景保持滚动时可读，禁止多层浮卡。

## Shapes

控件使用 7—8px 圆角，表格面板保持直角或轻微圆角。状态标签可用胶囊形，但普通按钮不能全部胶囊化。Lucide 图标统一细线风格并与文字标签共同出现。

## Components

### Foundational visual states

交互控件必须有默认、悬停、键盘焦点、按下、禁用和忙碌状态。错误使用持久文本；加载保留内容框架并避免闪烁。`prefers-reduced-motion` 下移除位移动效。

### Buttons and actions

一个决策区域只保留一个高强调主操作。图标按钮必须有中文可访问名称；忙碌时尺寸不变且阻止重复提交。危险或权限操作不与普通主操作混用视觉意图。

### Navigation and data display

侧栏保持现有深蓝语汇。台账使用原生表格、明确列名和横向滚动；订单编号是识别列。事件详情按服务端稳定序号展示发生日、操作时刻、差额、投影状态、原因、操作者和组织快照；历史原始行明确标注状态未推断。记账治理工作台以核对、关账、更正和历史审查三类并列区域呈现，不把职责分离隐藏在通用操作中。

### Forms and overlays

字段使用可点击的真实标签和应用自有错误文本。原生日期与选择框只在接受 Windows/浏览器平台弹层时使用。搜索必须可清除、IME 安全并防止旧响应覆盖。模态框管理焦点、Escape、Tab 循环和触发点恢复。

### Iconography

使用项目既有 Lucide React，常规尺寸 16—18px，线性图标不独立承载业务含义。

### Motion

仅用 160—250ms 状态过渡反馈悬停、焦点和模态进入；不为表格刷新逐行动画。减少动态偏好下只保留必要的瞬时状态变化。

### Content and data visualization

文案使用用户能识别的业务动词，如“确认入账”“整单暂停”“订单重启”。金额统一人民币格式，负数同时使用负号和语义色；操作时间明确时区语义，不把业务日期冒充真实操作时间。

## Do's and Don'ts

- **Do:** 用事件序号和完整文本证明账本顺序、责任与结果。
- **Do:** 沿用运行时令牌、原生语义元素和现有紧凑后台密度。
- **Don't:** 允许前端伪造操作月、组织快照或可执行状态。
- **Don't:** 用装饰性卡片、颜色或动画遮蔽金额、权限和错误信息。
