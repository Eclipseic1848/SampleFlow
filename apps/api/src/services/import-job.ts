import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Database } from "../db.js";
import { AccountingPeriodError, accountingMonth, assertAccountingPeriodOpen, consumeApprovedCorrection, lockApprovedCorrection } from "../modules/accounting-periods.js";
import { resolveOrganization, type OrganizationSnapshot } from "../modules/organization.js";
import { decidePerformanceEvent, PerformanceRuleError, type PerformanceCommand, type PerformanceState } from "../domain/performance.js";

export type ImportEventType = "initial" | "revenue_change" | "pause" | "restart" | "first_include" | "legacy_adjustment";

export type ImportSourceRow = Readonly<{
  sheet: string;
  rowNumber: number;
  businessSequence?: number;
  correctionRequestId?: number;
  sourceRecordId?: string;
  orderNo: string;
  occurredOn: string;
  customerName: string;
  customerUnit: string;
  businessRegionSourceText: string;
  salespersonSourceKey: string;
  serviceType: string;
  eventType: string;
  amount: number;
  reason: string;
}>;

type ImportIssue = Readonly<{
  rowNumber: number;
  code: string;
  severity: "blocking" | "warning" | "info";
  message: string;
}>;

type NormalizedRow = Omit<ImportSourceRow, "eventType"> & Readonly<{
  eventType: ImportEventType;
  sourceKey: string;
  duplicateFingerprint: string;
  businessRegionCode: string;
  personId: string;
  organization: OrganizationSnapshot;
}>;

type ExistingImportRecord = Readonly<{
  eventId: string;
  sourceKey: string | null;
  importBatchId: string | null;
  reconciliationId: string | null;
  duplicateFingerprint: string | null;
  sourcePayloadFingerprint: string | null;
}>;

type ImportConfigRow = {
  id: string;
  config_key: string;
  status: string;
  required_columns: string[];
  allowed_event_types: ImportEventType[];
  business_region_mapping: Record<string, string>;
  allow_legacy_source_key: boolean;
  fixed_event_type: "legacy_adjustment" | null;
};

export class ImportJobError extends Error {}

function warningConfirmationKey(issue: ImportIssue): string {
  return `${issue.rowNumber}:${issue.code}`;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourcePayloadFingerprint(row: ImportSourceRow): string {
  return sha256(JSON.stringify([
    row.orderNo, row.occurredOn, row.businessSequence ?? null, row.correctionRequestId ?? null, row.customerName, row.customerUnit, row.businessRegionSourceText,
    row.salespersonSourceKey, row.serviceType, row.eventType, row.amount, row.reason,
  ]));
}

function sameOrganizationSnapshot(left: OrganizationSnapshot, right: OrganizationSnapshot): boolean {
  return left.personId === right.personId
    && left.salespersonName === right.salespersonName
    && left.departmentId === right.departmentId
    && left.departmentName === right.departmentName
    && left.groupId === right.groupId
    && left.groupName === right.groupName
    && left.leaderPersonId === right.leaderPersonId
    && left.leaderName === right.leaderName
    && left.supervisorPersonId === right.supervisorPersonId
    && left.supervisorName === right.supervisorName;
}

async function loadExistingImportRecords(database: Pick<PoolClient, "query">, rows: readonly NormalizedRow[]): Promise<ExistingImportRecord[]> {
  if (!rows.length) return [];
  const sourceKeys = rows.map((row) => row.sourceKey);
  const orderNos = [...new Set(rows.map((row) => row.orderNo))];
  const existing = await database.query<{
    event_id: string;
    source_key: string | null;
    import_batch_id: string | null;
    reconciliation_id: string | null;
    duplicate_fingerprint: string | null;
    normalized_data: ImportSourceRow | null;
    order_no: string;
    occurred_on: string;
    salesperson_source_key: string | null;
    delta_amount: string;
    reason: string | null;
  }>(
    `select event.id::text event_id,coalesce(event.source_key,source_evidence.source_key) source_key,
            event.import_batch_id::text,reconciliation.id::text reconciliation_id,
            batch_row.duplicate_fingerprint,batch_row.normalized_data,
            performance_order.qingflow_order_no order_no,event.occurred_on::text,
            salesperson.source_key salesperson_source_key,event.delta_amount::text,event.reason
     from performance_events event
     join performance_orders performance_order on performance_order.id=event.order_id
     left join people salesperson on salesperson.id=event.salesperson_person_id
     left join legacy_event_source_evidence source_evidence on source_evidence.event_id=event.id
     left join import_batch_rows batch_row
       on batch_row.batch_id=event.import_batch_id and batch_row.source_key=event.source_key
     left join legacy_event_import_reconciliations reconciliation on reconciliation.event_id=event.id
     where coalesce(event.source_key,source_evidence.source_key)=any($1::text[])
        or performance_order.qingflow_order_no=any($2::text[])`,
    [sourceKeys, orderNos],
  );
  return existing.rows.map((record) => ({
    eventId: record.event_id,
    sourceKey: record.source_key,
    importBatchId: record.import_batch_id,
    reconciliationId: record.reconciliation_id,
    duplicateFingerprint: record.duplicate_fingerprint ?? (record.salesperson_source_key
      ? sha256(JSON.stringify([
        record.order_no,
        String(record.occurred_on).slice(0, 10),
        record.salesperson_source_key,
        Number(record.delta_amount),
        record.reason ?? "",
      ]))
      : null),
    sourcePayloadFingerprint: record.normalized_data ? sourcePayloadFingerprint(record.normalized_data) : null,
  }));
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function businessDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function comparableOrderNo(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s/gu, "");
}

function commandFromImportRow(row: NormalizedRow): PerformanceCommand | null {
  if (row.eventType === "initial") return { type: "initial", amount: row.amount };
  if (row.eventType === "revenue_change") return { type: "revenue_change", newAmount: row.amount };
  if (row.eventType === "first_include") return { type: "first_include", amount: row.amount };
  if (row.eventType === "pause" || row.eventType === "restart") return { type: row.eventType };
  return null;
}

function compareImportRows(left: NormalizedRow, right: NormalizedRow): number {
  return left.occurredOn.localeCompare(right.occurredOn)
    || (left.businessSequence ?? Number.MAX_SAFE_INTEGER) - (right.businessSequence ?? Number.MAX_SAFE_INTEGER)
    || left.rowNumber - right.rowNumber;
}

function validateBusinessSequences(rows: readonly NormalizedRow[], issues: ImportIssue[], existingByDate: ReadonlyMap<string, readonly (number | null)[]> = new Map()): void {
  const byDate = new Map<string, NormalizedRow[]>();
  for (const row of rows) byDate.set(row.occurredOn, [...(byDate.get(row.occurredOn) ?? []), row]);
  for (const sameDayRows of byDate.values()) {
    const existingSequences = existingByDate.get(sameDayRows[0]!.occurredOn) ?? [];
    const supplied = sameDayRows.some((row) => row.businessSequence !== undefined);
    if (sameDayRows.length + existingSequences.length < 2 && !supplied) continue;
    const sequences = [...existingSequences, ...sameDayRows.map((row) => row.businessSequence)].sort((left, right) => (left ?? 0) - (right ?? 0));
    const valid = sequences.every((sequence, index) => sequence === index + 1);
    if (!valid) addIssue(issues, sameDayRows[0]!, "BUSINESS_SEQUENCE_REQUIRED", "同一订单同一天有多条事件时，业务顺序必须从 1 开始连续且唯一");
  }
}

async function validateOrderSequenceAgainstLedger(
  database: Pick<PoolClient, "query">,
  orderNo: string,
  rows: readonly NormalizedRow[],
  issues: ImportIssue[],
): Promise<void> {
  const history = await database.query<{ occurred_on: string; source_business_sequence: number | null }>(
    `select event.occurred_on::text,event.source_business_sequence
     from performance_events event join performance_orders performance_order on performance_order.id=event.order_id
     where performance_order.qingflow_order_no=$1 and event.event_type<>'legacy_adjustment' order by event.occurred_on,event.order_sequence`,
    [orderNo],
  );
  const existingByDate = new Map<string, (number | null)[]>();
  for (const event of history.rows) {
    const date = String(event.occurred_on).slice(0, 10);
    existingByDate.set(date, [...(existingByDate.get(date) ?? []), event.source_business_sequence]);
  }
  validateBusinessSequences(rows, issues, existingByDate);
  const latestExistingDate = history.rows.at(-1)?.occurred_on;
  if (latestExistingDate) {
    for (const row of rows) if (row.occurredOn < String(latestExistingDate).slice(0, 10)) {
      addIssue(issues, row, "EVENT_CHAIN_OUT_OF_ORDER", "不可在已有业务事件之前插入历史事件");
    }
  }
}

function simulateOrderRows(initialState: PerformanceState, rows: readonly NormalizedRow[], issues: ImportIssue[]): void {
  let state = initialState;
  for (const row of [...rows].sort(compareImportRows)) {
    const command = commandFromImportRow(row);
    if (!command) continue;
    try {
      state = decidePerformanceEvent(state, command).next;
    } catch (error) {
      const reason = error instanceof PerformanceRuleError ? error.message : "事件链无效";
      addIssue(issues, row, "EVENT_CHAIN_INVALID", `事件链预演失败：${reason}`);
    }
  }
}

function addIssue(issues: ImportIssue[], row: ImportSourceRow, code: string, message: string) {
  issues.push({ rowNumber: row.rowNumber, code, severity: "blocking", message });
}

function addWarning(issues: ImportIssue[], row: ImportSourceRow, code: string, message: string) {
  issues.push({ rowNumber: row.rowNumber, code, severity: "warning", message });
}

function addInfo(issues: ImportIssue[], row: ImportSourceRow, code: string, message: string) {
  issues.push({ rowNumber: row.rowNumber, code, severity: "info", message });
}

async function loadApprovedConfig(database: Database, configId: string): Promise<ImportConfigRow> {
  const result = await database.query<ImportConfigRow>(
    `select id::text,config_key,status,required_columns,allowed_event_types,business_region_mapping,allow_legacy_source_key,fixed_event_type
     from import_configs where id=$1`,
    [configId],
  );
  const config = result.rows[0];
  if (!config || config.status !== "approved") throw new ImportJobError("只能使用已批准的导入配置");
  return config;
}

async function normalizeRow(
  database: Database,
  config: ImportConfigRow,
  sourceHash: string,
  row: ImportSourceRow,
  issues: ImportIssue[],
): Promise<NormalizedRow | null> {
  for (const field of config.required_columns) {
    const value = row[field as keyof ImportSourceRow];
    if (value === undefined || value === null || value === "" || (typeof value === "number" && Number.isNaN(value))) {
      addIssue(issues, row, "REQUIRED_FIELD_MISSING", `配置要求的必填字段 ${field} 不能为空`);
    }
  }
  const supportedEventTypes: readonly ImportEventType[] = ["initial", "revenue_change", "pause", "restart", "first_include", "legacy_adjustment"];
  const eventType = supportedEventTypes.includes(row.eventType as ImportEventType) ? row.eventType as ImportEventType : null;
  if (!eventType) addIssue(issues, row, "EVENT_TYPE_INVALID", "事件类型不受支持");
  else if (!config.allowed_event_types.includes(eventType)) addIssue(issues, row, "EVENT_TYPE_NOT_ALLOWED", "当前获批导入配置不允许该事件类型");
  if (row.businessSequence !== undefined && (!Number.isInteger(row.businessSequence) || row.businessSequence < 1)) {
    addIssue(issues, row, "BUSINESS_SEQUENCE_INVALID", "业务顺序必须是从 1 开始的正整数");
  }
  if (row.correctionRequestId !== undefined && (!Number.isInteger(row.correctionRequestId) || row.correctionRequestId < 1)) {
    addIssue(issues, row, "CORRECTION_REQUEST_INVALID", "更正授权标识必须是正整数");
  }
  if (!row.orderNo || row.orderNo.length > 100 || row.orderNo !== row.orderNo.trim() || /[\u0000-\u001f\u007f]/.test(row.orderNo)) {
    addIssue(issues, row, "ORDER_NO_INVALID", "订单编号必须是无首尾空格和控制字符的精确文本");
  }
  if (row.sourceRecordId !== undefined && (!row.sourceRecordId || row.sourceRecordId.length > 200)) {
    addIssue(issues, row, "SOURCE_RECORD_ID_INVALID", "来源记录标识必须是 1 至 200 个字符");
  }
  if (!row.customerName || row.customerName.length > 200) addIssue(issues, row, "CUSTOMER_NAME_INVALID", "客户姓名必须是 1 至 200 个字符");
  if (!row.customerUnit || row.customerUnit.length > 300) addIssue(issues, row, "CUSTOMER_UNIT_INVALID", "客户单位必须是 1 至 300 个字符");
  if (!row.businessRegionSourceText || row.businessRegionSourceText.length > 100) addIssue(issues, row, "BUSINESS_REGION_SOURCE_INVALID", "业务区域原文必须是 1 至 100 个字符");
  if (!row.salespersonSourceKey || row.salespersonSourceKey.length > 200) addIssue(issues, row, "PERSON_SOURCE_KEY_INVALID", "业务员来源标识必须是 1 至 200 个字符");
  if (row.serviceType.length > 200) addIssue(issues, row, "SERVICE_TYPE_INVALID", "服务类型不能超过 200 个字符");
  if (row.reason.length > 500) addIssue(issues, row, "REASON_INVALID", "原因不能超过 500 个字符");
  if (!validDate(row.occurredOn) || row.occurredOn > businessDate()) {
    addIssue(issues, row, "OCCURRED_ON_INVALID", "发生日期无效或晚于当前业务日");
  }
  const centValue = row.amount * 100;
  if (!Number.isFinite(row.amount) || Math.abs(row.amount) > 99_999_999_999.99 || Math.abs(centValue - Math.round(centValue)) > 1e-7) {
    addIssue(issues, row, "AMOUNT_INVALID", "金额必须是有效的两位小数范围数字");
  }
  if ((row.eventType === "initial" || row.eventType === "revenue_change") && row.amount < 0) {
    addIssue(issues, row, "INITIAL_AMOUNT_NEGATIVE", "首次订单金额不能为负数");
  }
  if (row.eventType === "first_include" && row.amount <= 0) addIssue(issues, row, "FIRST_INCLUDE_AMOUNT_INVALID", "首次计入金额必须大于零");
  if ((row.eventType === "pause" || row.eventType === "restart") && row.amount !== 0) addIssue(issues, row, "STATE_EVENT_AMOUNT_INVALID", "暂停或重启事件的金额必须为 0");
  if (row.eventType === "legacy_adjustment" && config.fixed_event_type !== "legacy_adjustment") {
    addIssue(issues, row, "LEGACY_EVENT_NOT_ALLOWED", "legacy_adjustment 只能来自人事批准的专用历史配置");
  }
  const businessRegionCode = config.business_region_mapping[row.businessRegionSourceText];
  if (!businessRegionCode) addIssue(issues, row, "BUSINESS_REGION_UNMAPPED", "业务区域原文没有已批准的精确映射");
  if (!row.sourceRecordId && !config.allow_legacy_source_key) {
    addIssue(issues, row, "SOURCE_RECORD_ID_REQUIRED", "当前导入配置要求稳定来源记录标识");
  }

  const person = await database.query<{ id: string }>(
    "select id::text from people where source_key=$1",
    [row.salespersonSourceKey],
  );
  if (person.rowCount !== 1) addIssue(issues, row, "PERSON_NOT_FOUND", "业务员来源标识无法唯一解析");

  let organization: OrganizationSnapshot | null = null;
  if (person.rows[0] && validDate(row.occurredOn)) {
    try {
      organization = await resolveOrganization(database, person.rows[0].id, row.occurredOn);
    } catch {
      addIssue(issues, row, "ORGANIZATION_NOT_RESOLVED", "发生日期找不到唯一有效组织任职及负责人");
    }
  }
  if (!businessRegionCode || !person.rows[0] || !organization || !eventType) return null;

  const sourceKey = row.sourceRecordId
    ? `${config.config_key}:${row.sourceRecordId}`
    : `legacy:${sourceHash}:${row.sheet}:${row.rowNumber}`;
  const duplicateFingerprint = sha256(JSON.stringify([
    row.orderNo,
    row.occurredOn,
    row.salespersonSourceKey,
    row.amount,
    row.reason,
  ]));
  return { ...row, eventType, sourceKey, duplicateFingerprint, businessRegionCode, personId: person.rows[0].id, organization };
}

export async function preflightImportRows(database: Database, input: Readonly<{
  actorUserId: string;
  configId: string;
  sourceFileName: string;
  sourceBytes: Uint8Array;
  rows: readonly ImportSourceRow[];
}>) {
  const operator = await database.query(
    "select 1 from user_roles where user_id=$1 and role_code=any($2::text[])",
    [input.actorUserId, ["sales_assistant", "sales_assistant_leader"]],
  );
  if (!operator.rowCount) throw new ImportJobError("仅业绩数据维护角色可以运行导入预检");
  const config = await loadApprovedConfig(database, input.configId);
  const sourceHash = sha256(input.sourceBytes);
  const issues: ImportIssue[] = [];
  const normalized: NormalizedRow[] = [];
  const seenSourceKeys = new Set<string>();
  const orderFacts = new Map<string, NormalizedRow>();
  const orderNumberForms = new Map<string, string>();
  const initialOrderNos = new Set<string>();
  const reconciliationSourceKeys = new Set<string>();

  for (const row of input.rows) {
    const rowIssuesBefore = issues.length;
    const value = await normalizeRow(database, config, sourceHash, row, issues);
    if (!value || issues.length !== rowIssuesBefore) continue;
    if (seenSourceKeys.has(value.sourceKey)) addIssue(issues, row, "SOURCE_KEY_DUPLICATE", "批次内来源记录标识重复");
    seenSourceKeys.add(value.sourceKey);
    const comparable = comparableOrderNo(value.orderNo);
    const priorOrderNumberForm = orderNumberForms.get(comparable);
    if (priorOrderNumberForm && priorOrderNumberForm !== value.orderNo) {
      addIssue(issues, row, "ORDER_NO_VARIANT", `订单编号与批次内“${priorOrderNumberForm}”仅大小写、空格或全半角不同`);
    } else {
      orderNumberForms.set(comparable, value.orderNo);
    }
    if (value.eventType === "initial") {
      if (initialOrderNos.has(value.orderNo)) addIssue(issues, row, "MULTIPLE_INITIAL_EVENTS", "同一订单在一个批次中只能有一条 initial 事件");
      initialOrderNos.add(value.orderNo);
    }

    const priorFacts = orderFacts.get(value.orderNo);
    const differences = priorFacts ? batchOrderFactDifferences(priorFacts, value) : [];
    if (differences.length) addIssue(issues, row, "ORDER_FACT_CONFLICT", `同一订单在批次内的基础事实字段差异：${differences.join("、")}`);
    else orderFacts.set(value.orderNo, value);
    normalized.push(value);
  }

  if (normalized.length) {
    const existing = await loadExistingImportRecords(database, normalized);
    const exactDuplicates = new Set<string>();
    for (const row of normalized) {
      const sameSource = existing.find((duplicate) => duplicate.sourceKey === row.sourceKey);
      if (sameSource) {
        const samePayload = sameSource.sourcePayloadFingerprint
          ? sameSource.sourcePayloadFingerprint === sourcePayloadFingerprint(row)
          : sameSource.duplicateFingerprint === row.duplicateFingerprint;
        if (!samePayload) {
          addIssue(issues, row, "SOURCE_RECORD_CONFLICT", "稳定来源记录标识已存在，但本次载荷与原记录不一致");
        } else if (row.eventType === "legacy_adjustment" && !sameSource.importBatchId && !sameSource.reconciliationId) {
          reconciliationSourceKeys.add(row.sourceKey);
          addInfo(issues, row, "LEGACY_EVENT_RECONCILIATION", "既有历史事件将关联本次受控批次并补齐业务区域，原事件保持不变");
        } else {
          exactDuplicates.add(row.sourceKey);
        }
        continue;
      }
      if (existing.some((duplicate) => duplicate.duplicateFingerprint === row.duplicateFingerprint)) {
        addIssue(issues, row, "CROSS_FILE_DUPLICATE_CANDIDATE", "发现跨文件疑似重复记录，必须回到权威来源核实");
      }
    }
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const row = normalized[index]!;
      if (!exactDuplicates.has(row.sourceKey)) continue;
      addInfo(issues, row, "SOURCE_RECORD_ALREADY_IMPORTED", "来源记录已入账，本次将幂等跳过");
      normalized.splice(index, 1);
    }
  }

  const initialRows = normalized.filter((row) => row.eventType === "initial");
  const existingOrderFacts = new Map<string, Record<string, unknown>>();
  if (normalized.length) {
    const existingFacts = await database.query<Record<string, unknown>>(
      `select qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
              salesperson_person_id::text,service_type,source_received_on::text,original_amount::text,
              current_revenue::text,counted_amount::text,lifecycle_state
       from performance_orders where qingflow_order_no=any($1::text[])`,
      [[...new Set(normalized.map((row) => row.orderNo))]],
    );
    const byOrderNo = new Map(existingFacts.rows.map((item) => [String(item.qingflow_order_no), item]));
    for (const [orderNo, item] of byOrderNo) existingOrderFacts.set(orderNo, item);
    for (const row of normalized) {
      const existing = byOrderNo.get(row.orderNo);
      if (!existing) continue;
      const differences = orderFactDifferences(existing, row);
      if (differences.length) addIssue(issues, row, "ORDER_FACT_CONFLICT", `订单 ${row.orderNo} 基础事实字段差异：${differences.join("、")}`);
    }
  }
  if (initialRows.length) {
    const existingVariants = await database.query<{ qingflow_order_no: string }>(
      `select qingflow_order_no from performance_orders
       where regexp_replace(lower(normalize(qingflow_order_no,NFKC)),'[[:space:]]+','','g')=any($1::text[])`,
      [[...new Set(initialRows.map((row) => comparableOrderNo(row.orderNo)))]],
    );
    for (const row of initialRows) {
      const variant = existingVariants.rows.find((order) => comparableOrderNo(order.qingflow_order_no) === comparableOrderNo(row.orderNo)
        && order.qingflow_order_no !== row.orderNo);
      if (variant) addIssue(issues, row, "ORDER_NO_VARIANT", `订单编号与已有订单“${variant.qingflow_order_no}”仅大小写、空格或全半角不同`);
    }
    const existingOrders = await database.query<{ qingflow_order_no: string }>(
      "select qingflow_order_no from performance_orders where qingflow_order_no=any($1::text[])",
      [initialRows.map((row) => row.orderNo)],
    );
    const existingOrderNos = new Set(existingOrders.rows.map((order) => order.qingflow_order_no));
    for (const row of initialRows) {
      if (existingOrderNos.has(row.orderNo)) addIssue(issues, row, "INITIAL_ORDER_ALREADY_EXISTS", "已有订单不能再次追加 initial 事件");
    }
  }

  const normalGroups = new Map<string, NormalizedRow[]>();
  for (const row of normalized) {
    if (row.eventType !== "legacy_adjustment") normalGroups.set(row.orderNo, [...(normalGroups.get(row.orderNo) ?? []), row]);
  }
  for (const [orderNo, rows] of normalGroups) {
    await validateOrderSequenceAgainstLedger(database, orderNo, rows, issues);
    const existing = existingOrderFacts.get(orderNo);
    if (existing?.lifecycle_state === "historical_review_required") {
      addIssue(issues, rows[0]!, "EVENT_CHAIN_INVALID", "历史待核订单完成核对前不能导入新的业务事件");
      continue;
    }
    const initialState: PerformanceState = existing
      ? { currentRevenue: Number(existing.current_revenue), countedAmount: Number(existing.counted_amount), lifecycle: existing.lifecycle_state as PerformanceState["lifecycle"] }
      : { currentRevenue: 0, countedAmount: 0, lifecycle: "draft" };
    simulateOrderRows(initialState, rows, issues);
  }

  for (const row of normalized) {
    if (reconciliationSourceKeys.has(row.sourceKey)) continue;
    const period = await database.query<{ status: string }>("select status from accounting_periods where period_month=$1", [accountingMonth(row.occurredOn)]);
    const closed = period.rows[0]?.status === "closed";
    if (!closed) {
      if (row.correctionRequestId !== undefined) addIssue(issues, row, "CORRECTION_REQUEST_NOT_NEEDED", "开放期间不能使用历史更正授权");
      continue;
    }
    if (row.eventType === "legacy_adjustment" || row.eventType === "initial" || row.correctionRequestId === undefined) {
      addIssue(issues, row, "CLOSED_PERIOD_AUTHORIZATION_REQUIRED", "关闭期间导入必须提供匹配的一次性历史更正授权");
      continue;
    }
    const correction = await database.query(
      `select 1 from accounting_correction_requests request_row
       join performance_orders performance_order on performance_order.id=request_row.order_id
       join people actor on actor.user_id=$2
       where request_row.id=$1 and performance_order.qingflow_order_no=$3 and request_row.event_type=$4
         and request_row.occurred_on=$5 and request_row.period_month=$6 and request_row.status='approved'
         and request_row.expires_at>now() and request_row.reviewed_by_person_id is distinct from actor.id`,
      [row.correctionRequestId, input.actorUserId, row.orderNo, row.eventType, row.occurredOn, accountingMonth(row.occurredOn)],
    );
    if (!correction.rowCount) addIssue(issues, row, "CLOSED_PERIOD_AUTHORIZATION_INVALID", "历史更正授权不存在、已失效或与订单事件日期不匹配");
  }

  const legacyGroups = new Map<string, NormalizedRow[]>();
  for (const row of normalized) {
    if (row.eventType === "legacy_adjustment" && !reconciliationSourceKeys.has(row.sourceKey)) {
      legacyGroups.set(row.orderNo, [...(legacyGroups.get(row.orderNo) ?? []), row]);
    }
  }
  if (legacyGroups.size) {
    const existingOrders = await database.query<{ qingflow_order_no: string; counted_amount: string; event_count: number; lifecycle_state: string }>(
      `select qingflow_order_no,counted_amount::text,lifecycle_state,
              (select count(*)::int from performance_events where order_id=performance_orders.id) event_count
       from performance_orders where qingflow_order_no=any($1::text[])`,
      [[...legacyGroups.keys()]],
    );
    const existingByOrder = new Map(existingOrders.rows.map((order) => [order.qingflow_order_no, order]));
    for (const [orderNo, rows] of legacyGroups) {
      const existing = existingByOrder.get(orderNo);
      const batchTotal = Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
      const finalTotal = Math.round((Number(existing?.counted_amount ?? 0) + batchTotal) * 100) / 100;
      const eventCount = Number(existing?.event_count ?? 0) + rows.length;
      if (existing?.lifecycle_state === "historical_review_required" || finalTotal < 0 || (finalTotal === 0 && eventCount > 1)) {
        addWarning(issues, rows[0]!, "HISTORICAL_REVIEW_REQUIRED", `订单 ${orderNo} 入账后仍需历史异常核对`);
      }
    }
  }

  const blocking = issues.filter((issue) => issue.severity === "blocking").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const rowsToImport = normalized.filter((row) => !reconciliationSourceKeys.has(row.sourceKey));
  const orders = new Set(rowsToImport.map((row) => row.orderNo)).size;
  const totalAmount = Math.round(rowsToImport.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
  const client = await database.connect();
  let batchId = "";
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('sampleflow:performance-import-preflight'))");
    const batch = await client.query<{ id: string }>(
      `insert into import_batches(config_id,source_file_name,source_sha256,source_bytes,status,uploaded_by,
         row_count,order_count,event_count,reconciliation_count,total_amount,warning_count,blocking_count,anomalies)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) returning id::text`,
      [input.configId, input.sourceFileName, sourceHash, Buffer.from(input.sourceBytes), blocking ? "blocked" : "preflight_ready",
       input.actorUserId, input.rows.length, orders, rowsToImport.length, reconciliationSourceKeys.size, totalAmount, warnings, blocking, JSON.stringify(issues)],
    );
    batchId = batch.rows[0]!.id;
    for (const row of normalized) {
      const rowIssues = issues.filter((issue) => issue.rowNumber === row.rowNumber);
      await client.query(
        `insert into import_batch_rows(batch_id,source_sheet,source_row_number,source_key,duplicate_fingerprint,normalized_data,issues)
         values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
        [batchId, row.sheet, row.rowNumber, row.sourceKey, row.duplicateFingerprint, JSON.stringify(row), JSON.stringify(rowIssues)],
      );
    }
    await client.query(
      `insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data)
       values($1,'import.batch_preflighted','import_batch',$2,jsonb_build_object('sourceSha256',$3::text,'status',$4::text,'rowCount',$5::int,'blockingCount',$6::int))`,
      [input.actorUserId, batchId, sourceHash, blocking ? "blocked" : "preflight_ready", input.rows.length, blocking],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    if (error instanceof AccountingPeriodError) throw new ImportJobError(error.message);
    throw error;
  } finally {
    client.release();
  }
  return {
    batchId,
    status: blocking ? "blocked" as const : "preflight_ready" as const,
    sourceSha256: sourceHash,
    issues,
    summary: { rows: input.rows.length, orders, events: rowsToImport.length, reconciliations: reconciliationSourceKeys.size, totalAmount, blocking, warnings },
  };
}

async function assertLeader(client: PoolClient, actorUserId: string): Promise<string> {
  const role = await client.query<{ person_id: string | null }>(
    `select people.id::text as person_id from user_roles
     join people on people.user_id=user_roles.user_id
     where user_roles.user_id=$1 and user_roles.role_code='sales_assistant_leader'`,
    [actorUserId],
  );
  if (!role.rowCount) throw new ImportJobError("仅销售助理组长可以确认导入批次");
  if (!role.rows[0]!.person_id) throw new ImportJobError("导入确认账号必须绑定稳定人员身份");
  return role.rows[0]!.person_id;
}

function orderFactDifferences(existing: Record<string, unknown>, row: NormalizedRow): string[] {
  const differences: string[] = [];
  if (existing.customer_name !== row.customerName) differences.push("customerName");
  if (existing.customer_unit !== row.customerUnit) differences.push("customerUnit");
  if (!(row.eventType === "legacy_adjustment" && existing.business_region_source_text == null)
      && existing.business_region_source_text !== row.businessRegionSourceText) differences.push("businessRegionSourceText");
  if (!(row.eventType === "legacy_adjustment" && existing.business_region_code == null)
      && existing.business_region_code !== row.businessRegionCode) differences.push("businessRegionCode");
  if (String(existing.salesperson_person_id) !== row.personId) differences.push("salespersonPersonId");
  if (String(existing.service_type ?? "") !== row.serviceType) differences.push("serviceType");
  if (row.eventType === "initial") {
    if (String(existing.source_received_on).slice(0, 10) !== row.occurredOn) differences.push("sourceReceivedOn");
    if (Number(existing.original_amount) !== row.amount) differences.push("originalAmount");
  }
  return differences;
}

function batchOrderFactDifferences(left: NormalizedRow, right: NormalizedRow): string[] {
  const differences: string[] = [];
  if (left.customerName !== right.customerName) differences.push("customerName");
  if (left.customerUnit !== right.customerUnit) differences.push("customerUnit");
  if (left.businessRegionSourceText !== right.businessRegionSourceText) differences.push("businessRegionSourceText");
  if (left.businessRegionCode !== right.businessRegionCode) differences.push("businessRegionCode");
  if (left.personId !== right.personId) differences.push("salespersonPersonId");
  if (left.serviceType !== right.serviceType) differences.push("serviceType");
  return differences;
}

async function insertEvent(
  client: PoolClient,
  batchId: string,
  orderId: string,
  row: NormalizedRow,
  actorUserId: string,
  eventType: ImportEventType,
  deltaAmount: number,
  resultingCurrentRevenue: number,
  resultingCountedAmount: number,
) {
  const inserted = await client.query<{ id: string }>(
    `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
       accounting_month,occurred_on,reason,salesperson_name,department_name,group_name,leader_name,supervisor_name,
       created_by,salesperson_person_id,department_unit_id,group_unit_id,leader_person_id,supervisor_person_id,
       import_batch_id,source_file_sha256,source_sheet,source_row_number,source_record_id,source_key,source_business_sequence)
     select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,b.source_sha256,$21,$22,$23,$24,$25
     from import_batches b where b.id=$20 returning id::text`,
    [orderId, eventType, deltaAmount, resultingCurrentRevenue, resultingCountedAmount, accountingMonth(row.occurredOn), row.occurredOn,
     row.reason, row.organization.salespersonName, row.organization.departmentName, row.organization.groupName,
     row.organization.leaderName, row.organization.supervisorName, actorUserId, row.organization.personId,
     row.organization.departmentId, row.organization.groupId, row.organization.leaderPersonId,
     row.organization.supervisorPersonId, batchId, row.sheet, row.rowNumber, row.sourceRecordId ?? null, row.sourceKey, row.businessSequence ?? null],
  );
  return inserted.rows[0]!.id;
}

export async function confirmImportBatch(database: Database, batchId: string, actorUserId: string, confirmedWarnings: readonly string[], ipAddress = "127.0.0.1") {
  const client = await database.connect();
  let ledgerAttempted = false;
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('sampleflow:performance-import'))");
    const actorPersonId = await assertLeader(client, actorUserId);
    const now = new Date();
    const found = await client.query<{
      status: string;
      warning_count: number;
      anomalies: ImportIssue[];
      imported_orders: number;
      imported_events: number;
      reconciled_events: number;
    }>(
      `select status,warning_count,anomalies,order_count as imported_orders,event_count as imported_events,
              reconciliation_count as reconciled_events
       from import_batches where id=$1 for update`,
      [batchId],
    );
    const batch = found.rows[0];
    if (!batch) throw new ImportJobError("导入批次不存在");
    if (batch.status === "imported") {
      await client.query("rollback");
      return { batchId, replayed: true, orders: batch.imported_orders, events: batch.imported_events, reconciliations: batch.reconciled_events };
    }
    if (batch.status === "blocked") throw new ImportJobError("导入批次存在阻断错误，不能确认");
    if (batch.status !== "preflight_ready") throw new ImportJobError("导入批次当前状态不能确认");
    const warningKeys = batch.anomalies.filter((issue) => issue.severity === "warning").map(warningConfirmationKey);
    if (warningKeys.some((key) => !confirmedWarnings.includes(key))) throw new ImportJobError("必须逐项确认全部预检警告");

    const loaded = await client.query<{ id: string; normalized_data: NormalizedRow }>(
      "select id::text,normalized_data from import_batch_rows where batch_id=$1 order by source_sheet,source_row_number",
      [batchId],
    );
    const preflightRows = loaded.rows.map((item) => item.normalized_data);
    ledgerAttempted = true;
    const currentOrganizations = new Map<string, Promise<OrganizationSnapshot>>();
    for (const row of preflightRows) {
      const key = `${row.personId}:${row.occurredOn}`;
      const current = currentOrganizations.get(key) ?? resolveOrganization(client, row.personId, row.occurredOn);
      currentOrganizations.set(key, current);
      try {
        if (!sameOrganizationSnapshot(await current, row.organization)) {
          throw new ImportJobError(`第 ${row.rowNumber} 行预检后的组织关系已变化，请重新预检`);
        }
      } catch (error) {
        if (error instanceof ImportJobError) throw error;
        throw new ImportJobError(`第 ${row.rowNumber} 行预检后的组织关系已变化，请重新预检`);
      }
    }
    const concurrentDuplicates = await loadExistingImportRecords(client, preflightRows);
    const existingBySourceKey = new Map(concurrentDuplicates.flatMap((item) => item.sourceKey ? [[item.sourceKey, item] as const] : []));
    const duplicateFingerprints = new Set(concurrentDuplicates.flatMap((item) => item.duplicateFingerprint ? [item.duplicateFingerprint] : []));
    const reconciliationRows: Array<{ row: NormalizedRow; eventId: string; batchRowId: string }> = [];
    const rows = preflightRows.filter((row) => {
      if (existingBySourceKey.has(row.sourceKey)) {
        const existingRecord = existingBySourceKey.get(row.sourceKey)!;
        const samePayload = existingRecord.sourcePayloadFingerprint
          ? existingRecord.sourcePayloadFingerprint === sourcePayloadFingerprint(row)
          : existingRecord.duplicateFingerprint === row.duplicateFingerprint;
        if (!samePayload) {
          throw new ImportJobError(`确认时发现稳定来源记录载荷不一致：第 ${row.rowNumber} 行`);
        }
        if (row.eventType === "legacy_adjustment" && !existingRecord.importBatchId && !existingRecord.reconciliationId) {
          const batchRowId = loaded.rows.find((item) => item.normalized_data.sourceKey === row.sourceKey)?.id;
          if (!batchRowId) throw new ImportJobError(`第 ${row.rowNumber} 行缺少核对来源证据`);
          reconciliationRows.push({ row, eventId: existingRecord.eventId, batchRowId });
        }
        return false;
      }
      if (duplicateFingerprints.has(row.duplicateFingerprint)) throw new ImportJobError(`确认时发现跨文件疑似重复记录：第 ${row.rowNumber} 行`);
      return true;
    });
    const groups = new Map<string, NormalizedRow[]>();
    for (const row of rows) groups.set(row.orderNo, [...(groups.get(row.orderNo) ?? []), row]);
    let importedOrders = 0;
    let importedEvents = 0;
    let reconciledEvents = 0;

    for (const reconciliation of reconciliationRows) {
      const existing = await client.query<Record<string, unknown>>(
        `select event.id::text,event.event_type,event.import_batch_id::text,event.order_id::text,
                performance_order.customer_name,performance_order.customer_unit,
                performance_order.business_region_source_text,performance_order.business_region_code,
                performance_order.salesperson_person_id::text,performance_order.service_type,
                performance_order.source_received_on::text,performance_order.original_amount::text
         from performance_events event join performance_orders performance_order on performance_order.id=event.order_id
         left join legacy_event_source_evidence source_evidence on source_evidence.event_id=event.id
         where event.id=$1 and coalesce(event.source_key,source_evidence.source_key)=$2 for update of performance_order`,
        [reconciliation.eventId, reconciliation.row.sourceKey],
      );
      const event = existing.rows[0];
      if (!event || event.event_type !== "legacy_adjustment" || event.import_batch_id) {
        throw new ImportJobError(`第 ${reconciliation.row.rowNumber} 行既有历史事件状态已变化，请重新预检`);
      }
      const differences = orderFactDifferences(event, reconciliation.row);
      if (differences.length) throw new ImportJobError(`订单基础事实冲突：${reconciliation.row.orderNo}；字段差异：${differences.join("、")}`);
      if (event.business_region_source_text == null && event.business_region_code == null) {
        await client.query(
          `update performance_orders set business_region_source_text=$2,business_region_code=$3
           where id=$1 and business_region_source_text is null and business_region_code is null`,
          [event.order_id, reconciliation.row.businessRegionSourceText, reconciliation.row.businessRegionCode],
        );
      }
      await client.query(
        `insert into legacy_event_import_reconciliations(event_id,batch_id,batch_row_id,reconciled_by,source_operator_status)
         values($1,$2,$3,$4,'unknown')`,
        [reconciliation.eventId, batchId, reconciliation.batchRowId, actorUserId],
      );
      reconciledEvents += 1;
    }

    for (const [orderNo, orderRows] of groups) {
      orderRows.sort(compareImportRows);
      const first = orderRows[0]!;
      const allLegacy = orderRows.every((row) => row.eventType === "legacy_adjustment");
      const existing = await client.query<Record<string, unknown>>(
        `select id::text,customer_name,customer_unit,business_region_source_text,business_region_code,salesperson_person_id::text,service_type,
                source_received_on::text,original_amount::text,
                current_revenue::text,counted_amount::text,lifecycle_state,
                (select count(*)::int from performance_events where order_id=performance_orders.id) as event_count
         from performance_orders where qingflow_order_no=$1 for update`,
        [orderNo],
      );
      let orderId: string;
      let counted = 0;
      let state: PerformanceState = { currentRevenue: 0, countedAmount: 0, lifecycle: "draft" };
      let priorEventCount = 0;
      let preserveHistoricalReview = false;
      if (existing.rows[0]) {
        const differences = orderFactDifferences(existing.rows[0], first);
        if (differences.length) throw new ImportJobError(`订单基础事实冲突：${orderNo}；字段差异：${differences.join("、")}`);
        orderId = String(existing.rows[0].id);
        counted = Number(existing.rows[0].counted_amount);
        if (!allLegacy) {
          if (existing.rows[0].lifecycle_state === "historical_review_required") throw new ImportJobError(`历史待核订单不能导入新的业务事件：${orderNo}`);
          state = {
            currentRevenue: Number(existing.rows[0].current_revenue),
            countedAmount: Number(existing.rows[0].counted_amount),
            lifecycle: existing.rows[0].lifecycle_state as PerformanceState["lifecycle"],
          };
        }
        priorEventCount = Number(existing.rows[0].event_count);
        preserveHistoricalReview = existing.rows[0].lifecycle_state === "historical_review_required";
      } else {
        const total = Math.round(orderRows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
        const lifecycle = allLegacy
          ? total > 0 ? "active" : orderRows.length === 1 && total === 0 ? "zero" : "historical_review_required"
          : "draft";
        const inserted = await client.query<{ id: string }>(
          `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
             salesperson_person_id,salesperson_name,service_type,source_received_on,original_amount,current_revenue,counted_amount,
             lifecycle_state,created_by,posted_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,0,$11,$12,now()) returning id::text`,
          [orderNo, first.customerName, first.customerUnit, first.businessRegionSourceText, first.businessRegionCode,
           first.organization.personId, first.organization.salespersonName, first.serviceType || null, first.occurredOn,
           Math.max(0, first.amount), lifecycle, actorUserId],
        );
        orderId = inserted.rows[0]!.id;
        importedOrders += 1;
      }
      if (!allLegacy) {
        const sequenceIssues: ImportIssue[] = [];
        await validateOrderSequenceAgainstLedger(client, orderNo, orderRows, sequenceIssues);
        if (sequenceIssues.length) throw new ImportJobError(`确认时事件顺序已变化，请重新预检：${sequenceIssues[0]!.message}`);
      }
      for (const row of orderRows) {
        let correction = null;
        if (row.correctionRequestId !== undefined) {
          correction = await lockApprovedCorrection(client, row.correctionRequestId, Number(orderId), row.eventType, actorPersonId, now);
          if (correction.periodMonth !== accountingMonth(row.occurredOn) || String(correction.occurredOn).slice(0, 10) !== row.occurredOn) {
            throw new ImportJobError(`第 ${row.rowNumber} 行更正授权与发生日期不匹配`);
          }
        } else {
          await assertAccountingPeriodOpen(client, accountingMonth(row.occurredOn));
        }
        let eventId: string;
        if (row.eventType === "legacy_adjustment") {
          counted = Math.round((counted + row.amount) * 100) / 100;
          eventId = await insertEvent(client, batchId, orderId, row, actorUserId, row.eventType, row.amount, Math.max(0, counted), counted);
        } else {
          const command = commandFromImportRow(row)!;
          let decision;
          try {
            decision = decidePerformanceEvent(state, command);
          } catch (error) {
            const reason = error instanceof PerformanceRuleError ? error.message : "事件链无效";
            throw new ImportJobError(`第 ${row.rowNumber} 行事件链已变化，请重新预检：${reason}`);
          }
          eventId = await insertEvent(client, batchId, orderId, row, actorUserId, decision.eventType, decision.deltaAmount,
            decision.next.currentRevenue, decision.next.countedAmount);
          state = decision.next;
        }
        if (correction) await consumeApprovedCorrection(client, correction, actorUserId, actorPersonId, eventId, now, ipAddress);
        importedEvents += 1;
      }
      const lifecycle = allLegacy
        ? preserveHistoricalReview
          ? "historical_review_required"
          : counted > 0 ? "active" : priorEventCount + orderRows.length === 1 && counted === 0 ? "zero" : "historical_review_required"
        : state.lifecycle;
      const currentRevenue = allLegacy ? Math.max(0, counted) : state.currentRevenue;
      const countedAmount = allLegacy ? counted : state.countedAmount;
      await client.query(
        "update performance_orders set current_revenue=$2,counted_amount=$3,lifecycle_state=$4 where id=$1",
        [orderId, currentRevenue, countedAmount, lifecycle],
      );
    }
    await client.query(
      "update import_batches set status='imported',confirmed_by=$2,confirmed_at=now(),order_count=$3,event_count=$4,reconciliation_count=$5 where id=$1",
      [batchId, actorUserId, importedOrders, importedEvents, reconciledEvents],
    );
    await client.query(
      `insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data)
       values($1,'import.batch_confirmed','import_batch',$2,jsonb_build_object('orders',$3::int,'events',$4::int,'reconciliations',$5::int))`,
      [actorUserId, batchId, importedOrders, importedEvents, reconciledEvents],
    );
    await client.query("commit");
    return { batchId, replayed: false, orders: importedOrders, events: importedEvents, reconciliations: reconciledEvents };
  } catch (error) {
    await client.query("rollback");
    if (ledgerAttempted) {
      await database.query(
        `update import_batches set status='failed',anomalies=anomalies||$2::jsonb
         where id=$1 and status='preflight_ready'`,
        [batchId, JSON.stringify([{ code: "CONFIRM_FAILED", severity: "blocking", message: "数据库或并发冲突，整批已回滚" }])],
      );
    }
    if (error instanceof AccountingPeriodError) throw new ImportJobError(error.message);
    throw error;
  } finally {
    client.release();
  }
}
