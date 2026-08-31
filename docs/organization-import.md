# 历史人员与组织初始化

组织初始化是独立的一次性作业，不随 API 启动或容器重启执行。原始工作簿和人事确认文件不得提交 Git、写入镜像或输出到日志。

组织工作簿与业绩导入共用安全门禁：压缩文件不超过 20 MiB、ZIP 条目不超过 256 个、单条目解压后不超过 32 MiB、解压后总计不超过 64 MiB。

## 1. 只读预检

```powershell
npm.cmd run organization:preflight --workspace @sampleflow/api -- --source "D:\受控目录\来源.xlsx"
```

命令只读取工作簿并输出文件 SHA-256、人员数、历史业绩人员数、组织数、额外人员和阻断原因。没有负责人映射时退出码为 `2`，不会连接或修改数据库。

## 2. 人事确认映射

映射文件使用 UTF-8 JSON，必须记录来源、确认人和确认日期。人员姓名必须已经出现在工作簿的 `组别` 表中。

```json
{
  "source": "人事确认单编号或受控文件标识",
  "confirmedBy": "确认人姓名",
  "confirmedAt": "2026-08-27",
  "groupLeaders": [
    {
      "departmentName": "销售一部",
      "groupName": "业务一组",
      "personName": "已确认组长姓名",
      "effectiveFrom": "2026-01-01"
    }
  ],
  "departmentSupervisors": [
    {
      "departmentName": "销售一部",
      "personName": "已确认主管姓名",
      "effectiveFrom": "2026-01-01"
    }
  ]
}
```

再次预检会输出来源文件和映射文件各自的 SHA-256。缺少任一历史小组组长、部门主管，存在重复负责人、未知人员或负责人日期晚于历史事件日期时，预检必须失败。

```powershell
npm.cmd run organization:preflight --workspace @sampleflow/api -- --source "D:\受控目录\来源.xlsx" --mapping "D:\受控目录\负责人映射.json"
```

## 3. 显式应用

真实数据库执行属于生产数据变更，必须取得单独授权。执行时必须逐字回填最近一次预检输出的两个哈希：

```powershell
npm.cmd run organization:preflight --workspace @sampleflow/api -- --source "D:\受控目录\来源.xlsx" --mapping "D:\受控目录\负责人映射.json" --apply --confirm-source-sha256 "<来源哈希>" --confirm-mapping-sha256 "<映射哈希>"
```

作业在单个数据库事务和咨询锁内：建立全部人员身份，只为 59 名历史业绩人员建立基准任职，建立负责人职责，回填历史订单和事件的稳定标识，并核对事件数量与金额。额外人员只建立身份，不自动建立任职或账号。

相同来源和相同映射重复执行会安全跳过；相同来源改用不同映射会阻断并报告差异，不覆盖已固化的历史归属。发现未解析事件、跨部门关系、重叠任职或金额变化时整批回滚。
