import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Database } from "../db.js";
import { isSignedMoney, postgresBigintIdSchema } from "../validation.js";
import { businessDate } from "../domain/business-time.js";
import { AccountingPeriodError, accountingMonth, consumeApprovedCorrection, lockApprovedCorrection } from "../modules/accounting-periods.js";
import type { OrganizationSnapshot } from "../modules/organization.js";
import { decidePerformanceEvent, PerformanceRuleError, type PerformanceCommand, type PerformanceState } from "../domain/performance.js";
import { recordEventAnalysisDimensions } from "../modules/event-analysis-dimensions.js";

export type ImportEventType = "initial" | "revenue_change" | "pause" | "restart" | "first_include" | "legacy_adjustment";

export type ImportSourceRow = Readonly<{
  sheet: string;
  rowNumber: number;
  businessSequence?: number;
  correctionRequestId?: string;
  sourceRecordId?: string;
  sourceMonth?: string;
  orderNo: string;
  occurredOn: string;
  customerName: string;
  customerUnit: string;
  businessRegionSourceText: string;
  salespersonSourceKey: string;
  sourceDepartment?: string;
  sourceGroup?: string;
  serviceType: string;
  collaboratorSourceKey?: string;
  collaborationRatio?: number;
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
  collaboratorPersonId?: string;
  collaboratorOrganization?: OrganizationSnapshot;
}>;

type ExistingImportRecord = Readonly<{
  eventId: string;
  sourceKey: string | null;
  importBatchId: string | null;
  reconciliationId: string | null;
  duplicateFingerprint: string | null;
  sourcePayloadFingerprint: string | null;
}>;

type DimensionBackfillRow = Readonly<{
  sheet: string;
  rowNumber: number;
  sourceKey: string;
  orderNo: string;
  occurredOn: string;
  salespersonSourceKey: string;
  amount: number;
  reason: string;
  businessRegionCode: string;
  businessRegionSourceText: string;
  customerUnit: string;
}>;

type DimensionBackfillTarget = Readonly<{
  event_id: string;
  source_file_sha256: string;
  source_sheet: string;
  source_row_number: string;
  source_key: string;
  event_type: string;
  order_no: string;
  occurred_on: string;
  salesperson_source_key: string | null;
  delta_amount: string;
  reason: string | null;
  business_region_code: string | null;
  business_region_source_text: string | null;
  customer_unit: string | null;
  receipt_source_sha256: string | null;
}>;

export type DimensionBackfillMapping = Readonly<DimensionBackfillRow & {
  eventId: string;
  status: "ready" | "already_mapped";
}>;

export type ImportReconciliationSummary = Readonly<{
  rows: number;
  orders: number;
  events: number;
  totalAmount: number;
  monthly: readonly Readonly<{ month: string; events: number; totalAmount: number }>[];
}>;

type ImportConfigRow = {
  id: string;
  config_key: string;
  status: string;
  required_columns: string[];
  allowed_event_types: ImportEventType[];
  business_region_mapping: Record<string, string>;
  expected_reconciliation: ImportReconciliationSummary | null;
  allow_legacy_source_key: boolean;
  fixed_event_type: "initial" | "legacy_adjustment" | null;
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
    row.orderNo, row.occurredOn, row.sourceMonth ?? null, row.businessSequence ?? null, row.correctionRequestId ?? null, row.customerName, row.customerUnit, row.businessRegionSourceText,
    row.salespersonSourceKey, row.sourceDepartment ?? null, row.sourceGroup ?? null, row.serviceType,
    row.collaboratorSourceKey ?? null, row.collaborationRatio ?? null, row.eventType, row.amount, row.reason,
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

function organizationKey(personId: string, occurredOn: string): string {
  return `${personId}:${occurredOn}`;
}

async function loadOrganizationSnapshots(
  database: Pick<PoolClient, "query">,
  pairs: readonly Readonly<{ personId: string; occurredOn: string }>[],
): Promise<ReadonlyMap<string, OrganizationSnapshot>> {
  const uniquePairs = new Map(pairs.map((pair) => [organizationKey(pair.personId, pair.occurredOn), pair]));
  if (!uniquePairs.size) return new Map();
  const values = [...uniquePairs.values()];
  const result = await database.query<{
    occurred_on: string;
    person_id: string;
    salesperson_name: string;
    department_id: string;
    department_name: string;
    group_id: string;
    group_name: string;
    leader_person_id: string;
    leader_name: string;
    supervisor_person_id: string;
    supervisor_name: string;
  }>(
    `with requested as (
       select * from unnest($1::bigint[],$2::date[]) as input(person_id,occurred_on)
     )
     select requested.occurred_on::text,p.id::text person_id,p.display_name salesperson_name,
            d.id::text department_id,d.name department_name,g.id::text group_id,g.name group_name,
            leader.id::text leader_person_id,leader.display_name leader_name,
            supervisor.id::text supervisor_person_id,supervisor.display_name supervisor_name
     from requested join people p on p.id=requested.person_id
     join org_memberships membership on membership.person_id=p.id
       and membership.effective_from<=requested.occurred_on and (membership.effective_to is null or membership.effective_to>=requested.occurred_on)
     join org_units d on d.id=membership.department_id and d.unit_type='department'
     join org_units g on g.id=membership.group_id and g.unit_type='group' and g.parent_id=d.id
     join org_responsibilities leader_role on leader_role.org_unit_id=g.id and leader_role.responsibility_type='leader'
       and leader_role.effective_from<=requested.occurred_on and (leader_role.effective_to is null or leader_role.effective_to>=requested.occurred_on)
     join people leader on leader.id=leader_role.person_id
     join org_responsibilities supervisor_role on supervisor_role.org_unit_id=d.id and supervisor_role.responsibility_type='supervisor'
       and supervisor_role.effective_from<=requested.occurred_on and (supervisor_role.effective_to is null or supervisor_role.effective_to>=requested.occurred_on)
     join people supervisor on supervisor.id=supervisor_role.person_id`,
    [values.map((pair) => pair.personId), values.map((pair) => pair.occurredOn)],
  );
  return new Map(result.rows.map((row) => [organizationKey(row.person_id, String(row.occurred_on).slice(0, 10)), {
    personId: row.person_id,
    salespersonName: row.salesperson_name,
    departmentId: row.department_id,
    departmentName: row.department_name,
    groupId: row.group_id,
    groupName: row.group_name,
    leaderPersonId: row.leader_person_id,
    leaderName: row.leader_name,
    supervisorPersonId: row.supervisor_person_id,
    supervisorName: row.supervisor_name,
  }]));
}

async function loadPeopleBySourceIdentity(
  database: Pick<PoolClient, "query">,
  sourceIdentities: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const requested = [...new Set(sourceIdentities.filter(Boolean))];
  if (!requested.length) return new Map();
  const result = await database.query<{ id: string; source_key: string; display_name: string }>(
    "select id::text,source_key,display_name from people where source_key=any($1::text[]) or display_name=any($1::text[])",
    [requested],
  );
  const resolved = new Map<string, string>();
  for (const identity of requested) {
    const sourceKeyMatch = result.rows.find((person) => person.source_key === identity);
    if (sourceKeyMatch) {
      resolved.set(identity, sourceKeyMatch.id);
      continue;
    }
    const displayNameMatches = result.rows.filter((person) => person.display_name === identity);
    if (displayNameMatches.length === 1) resolved.set(identity, displayNameMatches[0]!.id);
  }
  return resolved;
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

function compareLegacyProjectionRows(left: NormalizedRow, right: NormalizedRow): number {
  return left.occurredOn.localeCompare(right.occurredOn)
    || left.rowNumber - right.rowNumber
    || left.sheet.localeCompare(right.sheet);
}

function validateBusinessSequences(rows: readonly NormalizedRow[], issues: ImportIssue[], existingByDate: ReadonlyMap<string, readonly (number | null)[]> = new Map()): void {
  const byDate = new Map<string, NormalizedRow[]>();
  for (const row of rows) {
    const sameDayRows = byDate.get(row.occurredOn);
    if (sameDayRows) sameDayRows.push(row);
    else byDate.set(row.occurredOn, [row]);
  }
  for (const sameDayRows of byDate.values()) {
    const existingSequences = existingByDate.get(sameDayRows[0]!.occurredOn) ?? [];
    const supplied = sameDayRows.some((row) => row.businessSequence !== undefined);
    if (sameDayRows.length + existingSequences.length < 2 && !supplied) continue;
    const sequences = [...existingSequences, ...sameDayRows.map((row) => row.businessSequence)].sort((left, right) => (left ?? 0) - (right ?? 0));
    const valid = sequences.every((sequence, index) => sequence === index + 1);
    if (!valid) addIssue(issues, sameDayRows[0]!, "BUSINESS_SEQUENCE_REQUIRED", "同一订单同一天有多条事件时，业务顺序必须从 1 开始连续且唯一");
  }
}

type OrderSequenceEvent = Readonly<{ occurred_on: string; source_business_sequence: number | null }>;

async function loadOrderSequenceHistory(
  database: Pick<PoolClient, "query">,
  orderNos: readonly string[],
): Promise<ReadonlyMap<string, readonly OrderSequenceEvent[]>> {
  if (!orderNos.length) return new Map();
  const history = await database.query<OrderSequenceEvent & { order_no: string }>(
    `select performance_order.qingflow_order_no order_no,event.occurred_on::text,event.source_business_sequence
     from performance_events event join performance_orders performance_order on performance_order.id=event.order_id
     where performance_order.qingflow_order_no=any($1::text[]) and event.event_type<>'legacy_adjustment'
     order by performance_order.qingflow_order_no,event.occurred_on,event.order_sequence`,
    [[...new Set(orderNos)]],
  );
  const byOrder = new Map<string, OrderSequenceEvent[]>();
  for (const event of history.rows) {
    const events = byOrder.get(event.order_no);
    if (events) events.push(event);
    else byOrder.set(event.order_no, [event]);
  }
  return byOrder;
}

function validateOrderSequenceAgainstLedger(
  history: readonly OrderSequenceEvent[],
  rows: readonly NormalizedRow[],
  issues: ImportIssue[],
): void {
  const existingByDate = new Map<string, (number | null)[]>();
  for (const event of history) {
    const date = String(event.occurred_on).slice(0, 10);
    const sequences = existingByDate.get(date);
    if (sequences) sequences.push(event.source_business_sequence);
    else existingByDate.set(date, [event.source_business_sequence]);
  }
  validateBusinessSequences(rows, issues, existingByDate);
  const latestExistingDate = history.at(-1)?.occurred_on;
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

function addIssue(issues: ImportIssue[], row: Readonly<{ rowNumber:number }>, code: string, message: string) {
  issues.push({ rowNumber: row.rowNumber, code, severity: "blocking", message });
}

function addWarning(issues: ImportIssue[], row: Readonly<{ rowNumber:number }>, code: string, message: string) {
  issues.push({ rowNumber: row.rowNumber, code, severity: "warning", message });
}

function addInfo(issues: ImportIssue[], row: Readonly<{ rowNumber:number }>, code: string, message: string) {
  issues.push({ rowNumber: row.rowNumber, code, severity: "info", message });
}

async function loadApprovedConfig(database: Database, configId: string): Promise<ImportConfigRow> {
  const result = await database.query<ImportConfigRow>(
    `select id::text,config_key,status,required_columns,allowed_event_types,business_region_mapping,expected_reconciliation,allow_legacy_source_key,fixed_event_type
     from import_configs where id=$1`,
    [configId],
  );
  const config = result.rows[0];
  if (!config || config.status !== "approved") throw new ImportJobError("只能使用已批准的导入配置");
  return config;
}

function reconciliationSummary(rows: readonly Readonly<{ occurredOn:string; amount:number; orderNo:string }>[]): ImportReconciliationSummary {
  const monthly = new Map<string, { events: number; totalCents: number }>();
  let totalCents = 0;
  for (const row of rows) {
    const month = row.occurredOn.slice(0, 7);
    const current = monthly.get(month) ?? { events: 0, totalCents: 0 };
    current.events += 1;
    current.totalCents += Math.round(row.amount * 100);
    monthly.set(month, current);
    totalCents += Math.round(row.amount * 100);
  }
  return {
    rows: rows.length,
    orders: new Set(rows.map((row) => row.orderNo)).size,
    events: rows.length,
    totalAmount: totalCents / 100,
    monthly: [...monthly.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([month, value]) => ({
      month,
      events: value.events,
      totalAmount: value.totalCents / 100,
    })),
  };
}

function sameReconciliation(left: ImportReconciliationSummary, right: ImportReconciliationSummary): boolean {
  const expectedByMonth = new Map(right.monthly.map((month) => [month.month, month]));
  return left.rows === right.rows
    && left.orders === right.orders
    && left.events === right.events
    && Math.round(left.totalAmount * 100) === Math.round(right.totalAmount * 100)
    && left.monthly.length === right.monthly.length
    && left.monthly.every((month) => {
      const expected = expectedByMonth.get(month.month);
      return expected?.month === month.month
        && expected.events === month.events
        && Math.round(expected.totalAmount * 100) === Math.round(month.totalAmount * 100);
    });
}

function normalizeRow(
  config: ImportConfigRow,
  sourceHash: string,
  row: ImportSourceRow,
  issues: ImportIssue[],
  peopleBySourceKey: ReadonlyMap<string, string>,
  organizations: ReadonlyMap<string, OrganizationSnapshot>,
  today: string,
): NormalizedRow | null {
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
  if (row.correctionRequestId !== undefined && !postgresBigintIdSchema.safeParse(row.correctionRequestId).success) {
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
  if (!validDate(row.occurredOn) || row.occurredOn > today) {
    addIssue(issues, row, "OCCURRED_ON_INVALID", "发生日期无效或晚于当前业务日");
  }
  if (!isSignedMoney(row.amount)) {
    addIssue(issues, row, "AMOUNT_INVALID", "金额必须是有效的两位小数范围数字");
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

  const personId = peopleBySourceKey.get(row.salespersonSourceKey);
  if (!personId) addIssue(issues, row, "PERSON_NOT_FOUND", "业务员来源标识无法唯一解析");
  const organization = personId && validDate(row.occurredOn) ? organizations.get(organizationKey(personId, row.occurredOn)) : undefined;
  if (personId && validDate(row.occurredOn) && !organization) {
    addIssue(issues, row, "ORGANIZATION_NOT_RESOLVED", "发生日期找不到唯一有效组织任职及负责人");
  }
  if (row.sourceMonth !== undefined && validDate(row.occurredOn) && row.sourceMonth !== `${Number(row.occurredOn.slice(5, 7))}月`) {
    addIssue(issues, row, "SOURCE_MONTH_MISMATCH", "收样月份必须与日期月份一致");
  }
  if (organization && row.sourceDepartment !== undefined && row.sourceDepartment !== organization.departmentName) {
    addIssue(issues, row, "SOURCE_DEPARTMENT_MISMATCH", "部门与日期当天的组织任职不一致");
  }
  if (organization && row.sourceGroup !== undefined && row.sourceGroup !== organization.groupName) {
    addIssue(issues, row, "SOURCE_GROUP_MISMATCH", "组别与日期当天的组织任职不一致");
  }
  const hasCollaborator = Boolean(row.collaboratorSourceKey);
  const hasRatio = row.collaborationRatio !== undefined;
  if (hasCollaborator !== hasRatio) addIssue(issues, row, "COLLABORATION_INCOMPLETE", "协作人和协作比例必须同时填写或同时留空");
  if (hasRatio && (!Number.isFinite(row.collaborationRatio) || row.collaborationRatio! <= 0 || row.collaborationRatio! >= 1 || Math.abs(row.collaborationRatio! * 1_000_000 - Math.round(row.collaborationRatio! * 1_000_000)) > 1e-7)) {
    addIssue(issues, row, "COLLABORATION_RATIO_INVALID", "协作比例必须大于 0、小于 1，最多保留六位小数");
  }
  const collaboratorPersonId = hasCollaborator ? peopleBySourceKey.get(row.collaboratorSourceKey!) : undefined;
  if (hasCollaborator && !collaboratorPersonId) addIssue(issues, row, "COLLABORATOR_NOT_FOUND", "协作人来源标识无法唯一解析");
  if (collaboratorPersonId && collaboratorPersonId === personId) addIssue(issues, row, "COLLABORATOR_EQUALS_PRIMARY", "协作人不能与业务员相同");
  const collaboratorOrganization = collaboratorPersonId && validDate(row.occurredOn)
    ? organizations.get(organizationKey(collaboratorPersonId, row.occurredOn))
    : undefined;
  if (collaboratorPersonId && validDate(row.occurredOn) && !collaboratorOrganization) {
    addIssue(issues, row, "COLLABORATOR_ORGANIZATION_NOT_RESOLVED", "发生日期找不到协作人的唯一有效组织任职及负责人");
  }
  if (!businessRegionCode || !personId || !organization || !eventType || (hasCollaborator && (!collaboratorPersonId || !collaboratorOrganization))) return null;

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
  return {
    ...row, eventType, sourceKey, duplicateFingerprint, businessRegionCode, personId, organization,
    ...(collaboratorPersonId && collaboratorOrganization ? { collaboratorPersonId, collaboratorOrganization } : {}),
  };
}

function normalizeDimensionBackfillRow(
  config: ImportConfigRow,
  sourceHash: string,
  row: ImportSourceRow,
  issues: ImportIssue[],
  today: string,
): DimensionBackfillRow | null {
  const before = issues.length;
  if (row.eventType !== "legacy_adjustment") addIssue(issues, row, "DIMENSION_BACKFILL_EVENT_TYPE_INVALID", "历史维度补齐只接受 legacy_adjustment 来源行");
  if (row.sourceRecordId !== undefined) addIssue(issues, row, "DIMENSION_BACKFILL_SOURCE_KEY_INVALID", "历史维度补齐必须使用来源文件哈希、工作表和行号定位");
  if (!row.sheet || !Number.isInteger(row.rowNumber) || row.rowNumber <= 1) addIssue(issues, row, "SOURCE_POSITION_INVALID", "来源工作表和行号无效");
  if (!row.orderNo || row.orderNo.length > 100 || row.orderNo !== row.orderNo.trim() || /[\u0000-\u001f\u007f]/.test(row.orderNo)) {
    addIssue(issues, row, "ORDER_NO_INVALID", "订单编号必须是无首尾空格和控制字符的精确文本");
  }
  if (!validDate(row.occurredOn) || row.occurredOn > today) addIssue(issues, row, "OCCURRED_ON_INVALID", "发生日期无效或晚于当前业务日");
  if (!row.salespersonSourceKey || row.salespersonSourceKey.length > 200) addIssue(issues, row, "PERSON_SOURCE_KEY_INVALID", "业务员来源标识必须是 1 至 200 个字符");
  if (!row.customerUnit || row.customerUnit.length > 300) addIssue(issues, row, "CUSTOMER_UNIT_INVALID", "客户单位必须是 1 至 300 个字符");
  if (!row.businessRegionSourceText || row.businessRegionSourceText.length > 100) addIssue(issues, row, "BUSINESS_REGION_SOURCE_INVALID", "业务区域原文必须是 1 至 100 个字符");
  if (row.reason.length > 500) addIssue(issues, row, "REASON_INVALID", "原因不能超过 500 个字符");
  if (!isSignedMoney(row.amount)) {
    addIssue(issues, row, "AMOUNT_INVALID", "金额必须是有效的两位小数范围数字");
  }
  const businessRegionCode = config.business_region_mapping[row.businessRegionSourceText];
  if (!businessRegionCode) addIssue(issues, row, "BUSINESS_REGION_UNMAPPED", "业务区域原文没有已批准的精确映射");
  if (issues.length !== before || !businessRegionCode) return null;
  return {
    sheet: row.sheet,
    rowNumber: row.rowNumber,
    sourceKey: `legacy:${sourceHash}:${row.sheet}:${row.rowNumber}`,
    orderNo: row.orderNo,
    occurredOn: row.occurredOn,
    salespersonSourceKey: row.salespersonSourceKey,
    amount: row.amount,
    reason: row.reason,
    businessRegionCode,
    businessRegionSourceText: row.businessRegionSourceText,
    customerUnit: row.customerUnit,
  };
}

async function loadDimensionBackfillTargets(
  database: Pick<PoolClient, "query">,
  sourceHash: string,
  sourceKeys: readonly string[],
): Promise<DimensionBackfillTarget[]> {
  const result = await database.query<DimensionBackfillTarget>(
    `select evidence.event_id::text,evidence.source_file_sha256,evidence.source_sheet,
            evidence.source_row_number::text,evidence.source_key,event.event_type,
            performance_order.qingflow_order_no order_no,event.occurred_on::text,
            coalesce(salesperson.source_key,event.salesperson_name) salesperson_source_key,event.delta_amount::text,event.reason,
            dimensions.business_region_code,dimensions.business_region_source_text,dimensions.customer_unit,
            receipt.source_file_sha256 receipt_source_sha256
     from legacy_event_source_evidence evidence
     join performance_events event on event.id=evidence.event_id
     join performance_orders performance_order on performance_order.id=event.order_id
     left join people salesperson on salesperson.id=event.salesperson_person_id
     left join performance_event_analysis_dimensions dimensions on dimensions.event_id=event.id
     left join legacy_event_analysis_dimension_backfills receipt on receipt.event_id=event.id
     where evidence.source_file_sha256=$1 or evidence.source_key=any($2::text[])
     order by evidence.source_sheet,evidence.source_row_number,evidence.event_id`,
    [sourceHash, sourceKeys],
  );
  return result.rows;
}

function dimensionBackfillEvaluation(
  sourceHash: string,
  rows: readonly DimensionBackfillRow[],
  targets: readonly DimensionBackfillTarget[],
) {
  const issues: ImportIssue[] = [];
  const mappings: DimensionBackfillMapping[] = [];
  const bySourceKey = new Map(targets.map((target) => [target.source_key, target]));
  const seenEvents = new Set<string>();
  for (const row of rows) {
    const target = bySourceKey.get(row.sourceKey);
    if (!target) {
      addIssue(issues, row, "CONTROLLED_SOURCE_NOT_FOUND", "来源哈希、工作表和行号无法匹配既有历史事件证据");
      continue;
    }
    const sourceMatches = target.source_file_sha256 === sourceHash
      && target.source_sheet === row.sheet
      && Number(target.source_row_number) === row.rowNumber
      && target.source_key === row.sourceKey;
    const knownLegacyOffset = sourceHash === "926aad3d8c59cc356094eb1abc0ca1fcb3392eae5867f2b7c0e2bb50bb5c01cf";
    const storedDate = String(target.occurred_on).slice(0, 10);
    const legacyStoredDate = new Date(Date.parse(`${row.occurredOn}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const reasonMatches = (target.reason ?? "") === row.reason || (knownLegacyOffset && !row.reason && target.reason === "历史明细迁移");
    const eventMatches = target.event_type === "legacy_adjustment"
      && target.order_no === row.orderNo
      && (storedDate === row.occurredOn || (knownLegacyOffset && storedDate === legacyStoredDate))
      && target.salesperson_source_key === row.salespersonSourceKey
      && Math.round(Number(target.delta_amount) * 100) === Math.round(row.amount * 100)
      && reasonMatches;
    if (!sourceMatches || !eventMatches) {
      addIssue(issues, row, "SOURCE_RECORD_CONFLICT", "受控来源位置已存在，但事件事实与本次来源行不一致");
      continue;
    }
    if (seenEvents.has(target.event_id)) {
      addIssue(issues, row, "DIMENSION_BACKFILL_EVENT_DUPLICATE", "同一历史事件不能在一个补齐批次中重复出现");
      continue;
    }
    seenEvents.add(target.event_id);
    const hasDimensions = target.business_region_code !== null;
    if (hasDimensions) {
      const sameDimensions = target.business_region_code === row.businessRegionCode
        && target.business_region_source_text === row.businessRegionSourceText
        && target.customer_unit === row.customerUnit;
      if (!sameDimensions || target.receipt_source_sha256 !== sourceHash) {
        addIssue(issues, row, "DIMENSION_BACKFILL_CONFLICT", "事件已有分析维度，但维度值或受控来源凭据与本次补齐不一致");
        continue;
      }
      mappings.push({ ...row, eventId: target.event_id, status: "already_mapped" });
      continue;
    }
    if (target.receipt_source_sha256 !== null) {
      addIssue(issues, row, "DIMENSION_BACKFILL_CONFLICT", "事件补齐凭据与分析维度状态不一致");
      continue;
    }
    mappings.push({ ...row, eventId: target.event_id, status: "ready" });
  }
  const scope = targets.filter((target) => target.source_file_sha256 === sourceHash);
  if (!scope.length) issues.push({ rowNumber:0, code:"CONTROLLED_SOURCE_EMPTY", severity:"blocking", message:"来源哈希没有匹配任何既有历史事件证据" });
  const readyMapped = mappings.filter((mapping) => mapping.status === "ready");
  const alreadyMapped = mappings.filter((mapping) => mapping.status === "already_mapped");
  const readyEventIds = new Set(readyMapped.map((mapping) => mapping.eventId));
  const alreadyMappedEventIds = new Set(alreadyMapped.map((mapping) => mapping.eventId));
  const unresolvedPending = scope.filter((target) => target.business_region_code === null && !readyEventIds.has(target.event_id));
  const blockedTargets = scope.filter((target) => target.business_region_code !== null && !alreadyMappedEventIds.has(target.event_id));
  const amount = (items: readonly Readonly<{ amount?:number; delta_amount?:string }>[]) => items.reduce(
    (sum, item) => sum + Math.round((item.amount ?? Number(item.delta_amount)) * 100), 0,
  ) / 100;
  const sourceTotalAmount = amount(scope);
  const readyMappedTotalAmount = amount(readyMapped);
  const alreadyMappedTotalAmount = amount(alreadyMapped);
  const pendingTotalAmount = amount(unresolvedPending);
  const blockedTotalAmount = amount(blockedTargets);
  const matched = scope.length === readyMapped.length + alreadyMapped.length + unresolvedPending.length + blockedTargets.length
    && Math.round(sourceTotalAmount * 100) === Math.round((readyMappedTotalAmount + alreadyMappedTotalAmount + pendingTotalAmount + blockedTotalAmount) * 100);
  return {
    issues,
    mappings,
    reconciliation: {
      source: { events:scope.length, totalAmount:sourceTotalAmount },
      readyMapped: { events:readyMapped.length, totalAmount:readyMappedTotalAmount },
      alreadyMapped: { events:alreadyMapped.length, totalAmount:alreadyMappedTotalAmount },
      pending: { events:unresolvedPending.length, totalAmount:pendingTotalAmount },
      blocked: { events:blockedTargets.length, totalAmount:blockedTotalAmount },
      matched,
    },
  };
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
  const sourceKeys = [...new Set(input.rows.flatMap((row) => [row.salespersonSourceKey, row.collaboratorSourceKey ?? ""]))];
  const peopleBySourceKey = await loadPeopleBySourceIdentity(database, sourceKeys);
  const organizationPairs = input.rows.flatMap((row) => {
    const personId = peopleBySourceKey.get(row.salespersonSourceKey);
    const collaboratorPersonId = row.collaboratorSourceKey ? peopleBySourceKey.get(row.collaboratorSourceKey) : undefined;
    if (!validDate(row.occurredOn)) return [];
    return [
      ...(personId ? [{ personId, occurredOn: row.occurredOn }] : []),
      ...(collaboratorPersonId ? [{ personId: collaboratorPersonId, occurredOn: row.occurredOn }] : []),
    ];
  });
  const organizations = await loadOrganizationSnapshots(database, organizationPairs);
  const today = businessDate(new Date());

  for (const row of input.rows) {
    const rowIssuesBefore = issues.length;
    const value = normalizeRow(config, sourceHash, row, issues, peopleBySourceKey, organizations, today);
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

  const actualReconciliation = reconciliationSummary(normalized);
  const expectedReconciliation = config.expected_reconciliation;
  const reconciliationMatched = expectedReconciliation ? sameReconciliation(actualReconciliation, expectedReconciliation) : null;
  if (reconciliationMatched === false) {
    issues.push({
      rowNumber: 0,
      code: "RECONCILIATION_MISMATCH",
      severity: "blocking",
      message: "导入文件的整体或逐月明细数量、订单数量、事件数量、金额与获批配置不一致",
    });
  }

  if (normalized.length) {
    const existing = await loadExistingImportRecords(database, normalized);
    const existingBySourceKey = new Map(existing.flatMap((item) => item.sourceKey ? [[item.sourceKey, item] as const] : []));
    const existingFingerprints = new Set(existing.flatMap((item) => item.duplicateFingerprint ? [item.duplicateFingerprint] : []));
    const exactDuplicates = new Set<string>();
    for (const row of normalized) {
      const sameSource = existingBySourceKey.get(row.sourceKey);
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
      if (existingFingerprints.has(row.duplicateFingerprint)) {
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
              salesperson_person_id::text,service_type,collaborator_person_id::text,collaboration_ratio::text,
              source_received_on::text,original_amount::text,
              current_revenue::text,counted_amount::text,lifecycle_state,
              (select count(*)::int from performance_events where order_id=performance_orders.id and event_type<>'legacy_adjustment') non_legacy_event_count
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
    const variantsByComparable = new Map<string, Set<string>>();
    for (const order of existingVariants.rows) {
      const comparable = comparableOrderNo(order.qingflow_order_no);
      const forms = variantsByComparable.get(comparable) ?? new Set<string>();
      forms.add(order.qingflow_order_no);
      variantsByComparable.set(comparable, forms);
    }
    for (const row of initialRows) {
      const forms = variantsByComparable.get(comparableOrderNo(row.orderNo));
      if (!forms) continue;
      for (const variant of forms) if (variant !== row.orderNo) {
        addIssue(issues, row, "ORDER_NO_VARIANT", `订单编号与已有订单“${variant}”仅大小写、空格或全半角不同`);
        break;
      }
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
    if (row.eventType === "legacy_adjustment") continue;
    const rows = normalGroups.get(row.orderNo);
    if (rows) rows.push(row);
    else normalGroups.set(row.orderNo, [row]);
  }
  const sequenceHistory = await loadOrderSequenceHistory(database, [...normalGroups.keys()]);
  for (const [orderNo, rows] of normalGroups) {
    validateOrderSequenceAgainstLedger(sequenceHistory.get(orderNo) ?? [], rows, issues);
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

  const rowsRequiringPeriodCheck = normalized.filter((row) => !reconciliationSourceKeys.has(row.sourceKey));
  const months = [...new Set(rowsRequiringPeriodCheck.map((row) => accountingMonth(row.occurredOn)))];
  const periods = months.length
    ? await database.query<{ period_month: string; status: string }>(
      "select period_month::text,status from accounting_periods where period_month=any($1::date[])",
      [months],
    )
    : { rows: [] };
  const closedMonths = new Set(periods.rows.filter((period) => period.status === "closed").map((period) => String(period.period_month).slice(0, 10)));
  const correctionIds = [...new Set(rowsRequiringPeriodCheck.flatMap((row) => row.correctionRequestId === undefined ? [] : [row.correctionRequestId]))];
  const corrections = correctionIds.length
    ? await database.query<{
      id: string; order_no: string; event_type: string; occurred_on: string; period_month: string;
      business_region_code: string; business_region_source_text: string; customer_unit: string;
    }>(
      `select request_row.id::text,performance_order.qingflow_order_no order_no,request_row.event_type,
              request_row.occurred_on::text,request_row.period_month::text,request_row.business_region_code,
              request_row.business_region_source_text,request_row.customer_unit
       from accounting_correction_requests request_row
       join performance_orders performance_order on performance_order.id=request_row.order_id
       join people actor on actor.user_id=$2
       where request_row.id=any($1::bigint[]) and request_row.status='approved' and request_row.expires_at>now()
         and request_row.analysis_dimensions_required
         and request_row.reviewed_by_person_id is distinct from actor.id`,
      [correctionIds, input.actorUserId],
    )
    : { rows: [] };
  const correctionsById = new Map(corrections.rows.map((correction) => [correction.id, correction]));
  for (const row of rowsRequiringPeriodCheck) {
    const month = accountingMonth(row.occurredOn);
    const closed = closedMonths.has(month);
    if (!closed) {
      if (row.correctionRequestId !== undefined) addIssue(issues, row, "CORRECTION_REQUEST_NOT_NEEDED", "开放期间不能使用历史更正授权");
      continue;
    }
    if (row.eventType === "legacy_adjustment" || row.eventType === "initial" || row.correctionRequestId === undefined) {
      addIssue(issues, row, "CLOSED_PERIOD_AUTHORIZATION_REQUIRED", "关闭期间导入必须提供匹配的一次性历史更正授权");
      continue;
    }
    const correction = correctionsById.get(String(row.correctionRequestId));
    if (!correction || correction.order_no !== row.orderNo || correction.event_type !== row.eventType
      || String(correction.occurred_on).slice(0, 10) !== row.occurredOn || String(correction.period_month).slice(0, 10) !== month) {
      addIssue(issues, row, "CLOSED_PERIOD_AUTHORIZATION_INVALID", "历史更正授权不存在、已失效或与订单事件日期不匹配");
    } else if (correction.business_region_code !== row.businessRegionCode
      || correction.business_region_source_text !== row.businessRegionSourceText
      || correction.customer_unit !== row.customerUnit) {
      addIssue(issues, row, "CORRECTION_ANALYSIS_DIMENSIONS_MISMATCH", "导入行分析维度与历史更正授权不匹配");
    }
  }

  const legacyGroups = new Map<string, NormalizedRow[]>();
  for (const row of normalized) {
    if (row.eventType === "legacy_adjustment" && !reconciliationSourceKeys.has(row.sourceKey)) {
      const rows = legacyGroups.get(row.orderNo);
      if (rows) rows.push(row);
      else legacyGroups.set(row.orderNo, [row]);
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

  let blocking = 0;
  let warnings = 0;
  const issuesByRow = new Map<number, ImportIssue[]>();
  for (const issue of issues) {
    if (issue.severity === "blocking") blocking += 1;
    if (issue.severity === "warning") warnings += 1;
    const rowIssues = issuesByRow.get(issue.rowNumber);
    if (rowIssues) rowIssues.push(issue);
    else issuesByRow.set(issue.rowNumber, [issue]);
  }
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
         row_count,order_count,event_count,reconciliation_count,total_amount,warning_count,blocking_count,anomalies,reconciliation_summary)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb) returning id::text`,
      [input.configId, input.sourceFileName, sourceHash, Buffer.from(input.sourceBytes), blocking ? "blocked" : "preflight_ready",
       input.actorUserId, input.rows.length, orders, rowsToImport.length, reconciliationSourceKeys.size, totalAmount, warnings, blocking, JSON.stringify(issues),
       JSON.stringify({ actual: actualReconciliation, expected: expectedReconciliation, matched: reconciliationMatched })],
    );
    batchId = batch.rows[0]!.id;
    if (normalized.length) {
      await client.query(
        `insert into import_batch_rows(batch_id,source_sheet,source_row_number,source_key,duplicate_fingerprint,normalized_data,issues)
         select $1,item->>'sourceSheet',(item->>'sourceRowNumber')::int,item->>'sourceKey',item->>'duplicateFingerprint',
                item->'normalizedData',item->'issues'
         from jsonb_array_elements($2::jsonb) item`,
        [batchId, JSON.stringify(normalized.map((row) => ({
          sourceSheet: row.sheet,
          sourceRowNumber: row.rowNumber,
          sourceKey: row.sourceKey,
          duplicateFingerprint: row.duplicateFingerprint,
          normalizedData: row,
          issues: issuesByRow.get(row.rowNumber) ?? [],
        })))],
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
    reconciliation: { actual: actualReconciliation, expected: expectedReconciliation, matched: reconciliationMatched },
  };
}

export async function preflightDimensionBackfillRows(database: Database, input: Readonly<{
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
  if (!operator.rowCount) throw new ImportJobError("仅业绩数据维护角色可以运行历史维度补齐预检");
  const config = await loadApprovedConfig(database, input.configId);
  if (config.fixed_event_type !== "legacy_adjustment" || !config.allow_legacy_source_key) {
    throw new ImportJobError("历史维度补齐只能使用已批准的专用历史导入配置");
  }
  const sourceHash = sha256(input.sourceBytes);
  const issues: ImportIssue[] = [];
  const normalized: DimensionBackfillRow[] = [];
  const seenSourceKeys = new Set<string>();
  const today = businessDate(new Date());
  for (const row of input.rows) {
    const value = normalizeDimensionBackfillRow(config, sourceHash, row, issues, today);
    if (!value) continue;
    if (seenSourceKeys.has(value.sourceKey)) addIssue(issues, row, "SOURCE_KEY_DUPLICATE", "批次内来源位置重复");
    seenSourceKeys.add(value.sourceKey);
    normalized.push(value);
  }
  const targets = await loadDimensionBackfillTargets(database, sourceHash, normalized.map((row) => row.sourceKey));
  const evaluated = dimensionBackfillEvaluation(sourceHash, normalized, targets);
  issues.push(...evaluated.issues);
  if (config.expected_reconciliation) {
    const actual = reconciliationSummary(normalized);
    if (!sameReconciliation(actual, config.expected_reconciliation)) {
      issues.push({ rowNumber:0, code:"RECONCILIATION_MISMATCH", severity:"blocking", message:"来源文件的整体或逐月数量、订单和金额与获批配置不一致" });
    }
  }
  const blocking = issues.filter((issue) => issue.severity === "blocking").length;
  const readyMapped = evaluated.mappings.filter((mapping) => mapping.status === "ready");
  const alreadyMapped = evaluated.mappings.filter((mapping) => mapping.status === "already_mapped");
  const summary = {
    rows: input.rows.length,
    readyMapped: readyMapped.length,
    pending: evaluated.reconciliation.pending.events,
    alreadyMapped: alreadyMapped.length,
    blocking,
    totalAmount: evaluated.reconciliation.source.totalAmount,
  };
  const issuesByRow = new Map<number, ImportIssue[]>();
  for (const issue of issues) {
    const current = issuesByRow.get(issue.rowNumber);
    if (current) current.push(issue);
    else issuesByRow.set(issue.rowNumber, [issue]);
  }
  const client = await database.connect();
  let batchId = "";
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('sampleflow:performance-import-preflight'))");
    const batch = await client.query<{ id:string }>(
      `insert into import_batches(config_id,source_file_name,source_sha256,source_bytes,purpose,status,uploaded_by,
         row_count,order_count,event_count,reconciliation_count,total_amount,warning_count,blocking_count,anomalies,reconciliation_summary)
       values($1,$2,$3,$4,'dimension_backfill',$5,$6,$7,$8,$9,$10,$11,0,$12,$13::jsonb,$14::jsonb) returning id::text`,
      [input.configId, input.sourceFileName, sourceHash, Buffer.from(input.sourceBytes), blocking ? "blocked" : "preflight_ready",
       input.actorUserId, input.rows.length, new Set(evaluated.mappings.map((mapping) => mapping.orderNo)).size, readyMapped.length,
       alreadyMapped.length, summary.totalAmount, blocking, JSON.stringify(issues), JSON.stringify(evaluated.reconciliation)],
    );
    batchId = batch.rows[0]!.id;
    if (evaluated.mappings.length) {
      await client.query(
        `insert into import_batch_rows(batch_id,source_sheet,source_row_number,source_key,duplicate_fingerprint,normalized_data,issues)
         select $1,item->>'sheet',(item->>'rowNumber')::int,item->>'sourceKey',item->>'duplicateFingerprint',
                item-'issues'-'duplicateFingerprint',item->'issues'
         from jsonb_array_elements($2::jsonb) item`,
        [batchId, JSON.stringify(evaluated.mappings.map((mapping) => ({
          ...mapping,
          duplicateFingerprint:sha256(mapping.sourceKey),
          issues:issuesByRow.get(mapping.rowNumber) ?? [],
        })))],
      );
    }
    await client.query(
      `insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data)
       values($1,'import.dimension_backfill_preflighted','import_batch',$2,
         jsonb_build_object('sourceSha256',$3::text,'status',$4::text,'rows',$5::int,'readyMapped',$6::int,'alreadyMapped',$7::int,'pending',$8::int,'blocking',$9::int,'reconciliation',$10::jsonb))`,
      [input.actorUserId, batchId, sourceHash, blocking ? "blocked" : "preflight_ready", input.rows.length,
       readyMapped.length, alreadyMapped.length, summary.pending, blocking, JSON.stringify(evaluated.reconciliation)],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return {
    batchId,
    status: blocking ? "blocked" as const : "preflight_ready" as const,
    sourceSha256: sourceHash,
    issues,
    summary,
    reconciliation: evaluated.reconciliation,
    mappings: evaluated.mappings,
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
  if (row.eventType === "legacy_adjustment") {
    if (Number(existing.non_legacy_event_count)>0) differences.push("existingNonLegacyEvents");
    return differences;
  }
  if (existing.customer_unit !== row.customerUnit) differences.push("customerUnit");
  if (existing.business_region_source_text !== row.businessRegionSourceText) differences.push("businessRegionSourceText");
  if (existing.business_region_code !== row.businessRegionCode) differences.push("businessRegionCode");
  if (String(existing.salesperson_person_id) !== row.personId) differences.push("salespersonPersonId");
  if (String(existing.service_type ?? "") !== row.serviceType) differences.push("serviceType");
  if (row.eventType === "initial" || row.collaboratorPersonId !== undefined || row.collaborationRatio !== undefined) {
    if (String(existing.collaborator_person_id ?? "") !== (row.collaboratorPersonId ?? "")) differences.push("collaboratorPersonId");
    if (existing.collaboration_ratio === null || existing.collaboration_ratio === undefined
      ? row.collaborationRatio !== undefined
      : Number(existing.collaboration_ratio) !== row.collaborationRatio) differences.push("collaborationRatio");
  }
  if (row.eventType === "initial") {
    if (String(existing.source_received_on).slice(0, 10) !== row.occurredOn) differences.push("sourceReceivedOn");
    if (Number(existing.original_amount) !== row.amount) differences.push("originalAmount");
  }
  return differences;
}

function batchOrderFactDifferences(left: NormalizedRow, right: NormalizedRow): string[] {
  const differences: string[] = [];
  if (left.customerName !== right.customerName) differences.push("customerName");
  if (left.eventType === "legacy_adjustment") return differences;
  if (left.customerUnit !== right.customerUnit) differences.push("customerUnit");
  if (left.businessRegionSourceText !== right.businessRegionSourceText) differences.push("businessRegionSourceText");
  if (left.businessRegionCode !== right.businessRegionCode) differences.push("businessRegionCode");
  if (left.personId !== right.personId) differences.push("salespersonPersonId");
  if (left.serviceType !== right.serviceType) differences.push("serviceType");
  if (left.collaboratorPersonId !== right.collaboratorPersonId) differences.push("collaboratorPersonId");
  if (left.collaborationRatio !== right.collaborationRatio) differences.push("collaborationRatio");
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
       created_by,salesperson_person_id,department_unit_id,group_unit_id,leader_person_id,supervisor_person_id,service_type,
       collaborator_person_id,collaborator_name,collaboration_ratio,collaborator_department_unit_id,collaborator_department_name,
       collaborator_group_unit_id,collaborator_group_name,collaborator_leader_person_id,collaborator_leader_name,
       collaborator_supervisor_person_id,collaborator_supervisor_name,
       import_batch_id,source_file_sha256,source_sheet,source_row_number,source_record_id,source_key,source_business_sequence)
     select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
            $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,b.source_sha256,$33,$34,$35,$36,$37
     from import_batches b where b.id=$32 returning id::text`,
    [orderId, eventType, deltaAmount, resultingCurrentRevenue, resultingCountedAmount, accountingMonth(row.occurredOn), row.occurredOn,
     row.reason, row.organization.salespersonName, row.organization.departmentName, row.organization.groupName,
     row.organization.leaderName, row.organization.supervisorName, actorUserId, row.organization.personId,
     row.organization.departmentId, row.organization.groupId, row.organization.leaderPersonId,
     row.organization.supervisorPersonId, row.serviceType || null,
     row.collaboratorOrganization?.personId ?? null, row.collaboratorOrganization?.salespersonName ?? null, row.collaborationRatio ?? null,
     row.collaboratorOrganization?.departmentId ?? null, row.collaboratorOrganization?.departmentName ?? null,
     row.collaboratorOrganization?.groupId ?? null, row.collaboratorOrganization?.groupName ?? null,
     row.collaboratorOrganization?.leaderPersonId ?? null, row.collaboratorOrganization?.leaderName ?? null,
     row.collaboratorOrganization?.supervisorPersonId ?? null, row.collaboratorOrganization?.supervisorName ?? null,
     batchId, row.sheet, row.rowNumber, row.sourceRecordId ?? null, row.sourceKey, row.businessSequence ?? null],
  );
  const eventId=inserted.rows[0]!.id;
  await recordEventAnalysisDimensions(client,eventId,{
    businessRegionCode:row.businessRegionCode,
    businessRegionSourceText:row.businessRegionSourceText,
    customerUnit:row.customerUnit,
  });
  return eventId;
}

async function updateLegacyOrderProjection(client: PoolClient, orderId: string, eventId: string, row: NormalizedRow): Promise<void> {
  await client.query(
    `update performance_orders set customer_unit=$2,business_region_source_text=$3,business_region_code=$4,
       salesperson_person_id=$5,salesperson_name=$6,service_type=$7
     where id=$1 and $8=(
       select event.id::text from performance_events event where event.order_id=$1 and event.event_type='legacy_adjustment'
       order by event.occurred_on desc,event.source_row_number desc nulls last,event.source_sheet desc nulls last,event.id desc limit 1
     )`,
    [orderId,row.customerUnit,row.businessRegionSourceText,row.businessRegionCode,row.personId,row.organization.salespersonName,row.serviceType||null,eventId],
  );
}

async function assertAccountingPeriodsOpen(client: PoolClient, months: readonly string[]): Promise<void> {
  const uniqueMonths = [...new Set(months)].sort();
  if (!uniqueMonths.length) return;
  await client.query(
    "insert into accounting_periods(period_month) select unnest($1::date[]) on conflict do nothing",
    [uniqueMonths],
  );
  const periods = await client.query<{ period_month: string; status: string }>(
    "select period_month::text,status from accounting_periods where period_month=any($1::date[]) order by period_month for update",
    [uniqueMonths],
  );
  const closed = periods.rows.find((period) => period.status === "closed");
  if (closed) throw new AccountingPeriodError(`记账期间已关闭：${String(closed.period_month).slice(0, 7)}`);
}

export async function confirmDimensionBackfillBatch(
  database: Database,
  batchId: string,
  actorUserId: string,
  ipAddress = "127.0.0.1",
) {
  const client = await database.connect();
  let attempted = false;
  let sourceHash = "";
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('sampleflow:dimension-backfill'))");
    await assertLeader(client, actorUserId);
    const found = await client.query<{
      status:string;
      purpose:string;
      source_sha256:string;
      event_count:number;
      reconciliation_count:number;
      reconciliation_summary:{ confirmation?:{ pending?:number } };
    }>(
      `select status,purpose,source_sha256,event_count,reconciliation_count,reconciliation_summary
       from import_batches where id=$1 for update`,
      [batchId],
    );
    const batch = found.rows[0];
    if (!batch) throw new ImportJobError("导入批次不存在");
    if (batch.purpose !== "dimension_backfill") throw new ImportJobError("当前批次不是历史维度补齐批次");
    sourceHash = batch.source_sha256;
    if (batch.status === "imported") {
      await client.query("rollback");
      return {
        batchId,
        replayed:true,
        applied:Number(batch.event_count),
        alreadyMapped:Number(batch.reconciliation_count),
        pending:Number(batch.reconciliation_summary.confirmation?.pending ?? 0),
      };
    }
    if (batch.status === "blocked") throw new ImportJobError("导入批次存在阻断错误，不能确认");
    if (batch.status !== "preflight_ready") throw new ImportJobError("导入批次当前状态不能确认");
    const config = await client.query<{ status:string; fixed_event_type:string|null; allow_legacy_source_key:boolean }>(
      `select config.status,config.fixed_event_type,config.allow_legacy_source_key
       from import_batches batch join import_configs config on config.id=batch.config_id where batch.id=$1`,
      [batchId],
    );
    if (config.rows[0]?.status !== "approved" || config.rows[0].fixed_event_type !== "legacy_adjustment" || !config.rows[0].allow_legacy_source_key) {
      throw new ImportJobError("历史维度补齐配置已失效，请重新预检");
    }
    const loaded = await client.query<{ id:string; normalized_data:DimensionBackfillMapping }>(
      "select id::text,normalized_data from import_batch_rows where batch_id=$1 order by source_sheet,source_row_number",
      [batchId],
    );
    const rows = loaded.rows.map((item) => item.normalized_data);
    const batchRowIds = new Map(loaded.rows.map((item) => [item.normalized_data.sourceKey, item.id]));
    attempted = true;
    const targets = await loadDimensionBackfillTargets(client, sourceHash, rows.map((row) => row.sourceKey));
    const evaluated = dimensionBackfillEvaluation(sourceHash, rows, targets);
    if (evaluated.issues.length || evaluated.mappings.length !== rows.length) {
      throw new ImportJobError("确认时受控来源或目标维度状态已变化，请重新预检");
    }
    const stagedBySourceKey = new Map(rows.map((row) => [row.sourceKey, row]));
    for (const mapping of evaluated.mappings) {
      const staged = stagedBySourceKey.get(mapping.sourceKey);
      if (!staged || staged.eventId !== mapping.eventId
        || staged.businessRegionCode !== mapping.businessRegionCode
        || staged.businessRegionSourceText !== mapping.businessRegionSourceText
        || staged.customerUnit !== mapping.customerUnit) {
        throw new ImportJobError("确认时补齐映射与预检证据不一致，请重新预检");
      }
    }
    const toApply = evaluated.mappings.filter((mapping) => mapping.status === "ready");
    const alreadyMapped = evaluated.mappings.length - toApply.length;
    const unresolvedPending = evaluated.reconciliation.pending.events;
    const unresolvedPendingAmount = evaluated.reconciliation.pending.totalAmount;
    const confirmedAt = new Date().toISOString();
    if (toApply.length) {
      const values = toApply.map((mapping) => ({
        event_id:mapping.eventId,
        business_region_code:mapping.businessRegionCode,
        business_region_source_text:mapping.businessRegionSourceText,
        customer_unit:mapping.customerUnit,
        batch_row_id:batchRowIds.get(mapping.sourceKey),
      }));
      if (values.some((value) => !value.batch_row_id)) throw new ImportJobError("补齐批次缺少不可变行证据");
      await client.query(
        `insert into performance_event_analysis_dimensions(event_id,business_region_code,business_region_source_text,customer_unit)
         select item.event_id,item.business_region_code,item.business_region_source_text,item.customer_unit
         from jsonb_to_recordset($1::jsonb) item(event_id bigint,business_region_code text,business_region_source_text text,customer_unit text)`,
        [JSON.stringify(values)],
      );
      await client.query(
        `insert into legacy_event_analysis_dimension_backfills
          (event_id,batch_id,batch_row_id,source_file_sha256,confirmed_by,confirmed_at,result)
         select item.event_id,$2,item.batch_row_id,$3,$4,$5,'applied'
         from jsonb_to_recordset($1::jsonb) item(event_id bigint,batch_row_id bigint)`,
        [JSON.stringify(values), batchId, sourceHash, actorUserId, confirmedAt],
      );
      await client.query(
        `with affected_orders as (
           select distinct event.order_id
           from jsonb_to_recordset($1::jsonb) item(event_id bigint)
           join performance_events event on event.id=item.event_id
         ), latest_events as (
           select distinct on (event.order_id) event.id,event.order_id
           from performance_events event join affected_orders affected on affected.order_id=event.order_id
           where event.event_type='legacy_adjustment'
           order by event.order_id,event.occurred_on desc,event.source_row_number desc nulls last,
                    event.source_sheet desc nulls last,event.id desc
         )
         update performance_orders orders
         set customer_unit=dimensions.customer_unit,
             business_region_source_text=dimensions.business_region_source_text,
             business_region_code=dimensions.business_region_code
         from latest_events latest
         join performance_event_analysis_dimensions dimensions on dimensions.event_id=latest.id
         where orders.id=latest.order_id`,
        [JSON.stringify(values)],
      );
    }
    const result = toApply.length ? "applied" : "replayed";
    const confirmation = { result, applied:toApply.length, alreadyMapped, pending:unresolvedPending, pendingAmount:unresolvedPendingAmount };
    await client.query(
      `update import_batches set status='imported',confirmed_by=$2,confirmed_at=$3,event_count=$4,reconciliation_count=$5,
         reconciliation_summary=reconciliation_summary||jsonb_build_object('confirmation',$6::jsonb)
       where id=$1`,
      [batchId, actorUserId, confirmedAt, toApply.length, alreadyMapped, JSON.stringify(confirmation)],
    );
    await client.query(
      `insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,ip_address)
       values($1,'import.dimension_backfill_confirmed','import_batch',$2,
         jsonb_build_object('sourceSha256',$3::text,'confirmedAt',$4::text,'result',$5::text,'applied',$6::int,'alreadyMapped',$7::int,'pending',$8::int,'pendingAmount',$9::numeric),$10)`,
      [actorUserId, batchId, sourceHash, confirmedAt, result, toApply.length, alreadyMapped, unresolvedPending, unresolvedPendingAmount, ipAddress],
    );
    await client.query("commit");
    return { batchId, replayed:false, applied:toApply.length, alreadyMapped, pending:unresolvedPending };
  } catch (error) {
    await client.query("rollback");
    if (attempted) {
      const terminal = error instanceof ImportJobError;
      const result = terminal ? "blocked" : "retryable";
      await database.query(
        `with failed as (
           update import_batches set status=case when $7::boolean then 'failed' else status end,anomalies=anomalies||$3::jsonb
           where id=$1 and status='preflight_ready' returning id
         )
         insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,ip_address)
         select $2,'import.dimension_backfill_confirm_failed','import_batch',$1,
                jsonb_build_object('sourceSha256',$4::text,'confirmedAt',$5::text,'result',$8::text),$6
         from failed`,
        [batchId, actorUserId, JSON.stringify([{ code:terminal ? "CONFIRM_BLOCKED" : "CONFIRM_RETRYABLE", severity:terminal ? "blocking" : "warning", message:terminal ? "受控来源或并发冲突，整批已回滚" : "临时确认失败，正式维度已回滚，可重试" }]),
         sourceHash, new Date().toISOString(), ipAddress, terminal, result],
      );
    }
    throw error;
  } finally {
    client.release();
  }
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
      purpose: string;
      warning_count: number;
      anomalies: ImportIssue[];
      imported_orders: number;
      imported_events: number;
      reconciled_events: number;
    }>(
      `select status,purpose,warning_count,anomalies,order_count as imported_orders,event_count as imported_events,
              reconciliation_count as reconciled_events
       from import_batches where id=$1 for update`,
      [batchId],
    );
    const batch = found.rows[0];
    if (!batch) throw new ImportJobError("导入批次不存在");
    if (batch.purpose !== "ledger_import") throw new ImportJobError("当前批次不是业绩入账批次");
    if (batch.status === "imported") {
      await client.query("rollback");
      return { batchId, replayed: true, orders: batch.imported_orders, events: batch.imported_events, reconciliations: batch.reconciled_events };
    }
    if (batch.status === "blocked") throw new ImportJobError("导入批次存在阻断错误，不能确认");
    if (batch.status !== "preflight_ready") throw new ImportJobError("导入批次当前状态不能确认");
    const confirmedWarningKeys = new Set(confirmedWarnings);
    if (batch.anomalies.some((issue) => issue.severity === "warning" && !confirmedWarningKeys.has(warningConfirmationKey(issue)))) {
      throw new ImportJobError("必须逐项确认全部预检警告");
    }

    const loaded = await client.query<{ id: string; normalized_data: NormalizedRow }>(
      "select id::text,normalized_data from import_batch_rows where batch_id=$1 order by source_sheet,source_row_number",
      [batchId],
    );
    const preflightRows = loaded.rows.map((item) => item.normalized_data);
    const batchRowIdsBySourceKey = new Map(loaded.rows.map((item) => [item.normalized_data.sourceKey, item.id]));
    ledgerAttempted = true;
    const currentOrganizations = await loadOrganizationSnapshots(client, preflightRows.flatMap((row) => [
      { personId: row.personId, occurredOn: row.occurredOn },
      ...(row.collaboratorPersonId ? [{ personId: row.collaboratorPersonId, occurredOn: row.occurredOn }] : []),
    ]));
    for (const row of preflightRows) {
      const current = currentOrganizations.get(organizationKey(row.personId, row.occurredOn));
      if (!current || !sameOrganizationSnapshot(current, row.organization)) {
        throw new ImportJobError(`第 ${row.rowNumber} 行预检后的组织关系已变化，请重新预检`);
      }
      const currentCollaborator = row.collaboratorPersonId
        ? currentOrganizations.get(organizationKey(row.collaboratorPersonId, row.occurredOn))
        : undefined;
      if (row.collaboratorPersonId && (!row.collaboratorOrganization || !currentCollaborator
        || !sameOrganizationSnapshot(currentCollaborator, row.collaboratorOrganization))) {
        throw new ImportJobError(`第 ${row.rowNumber} 行预检后的协作人组织关系已变化，请重新预检`);
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
          const batchRowId = batchRowIdsBySourceKey.get(row.sourceKey);
          if (!batchRowId) throw new ImportJobError(`第 ${row.rowNumber} 行缺少核对来源证据`);
          reconciliationRows.push({ row, eventId: existingRecord.eventId, batchRowId });
        }
        return false;
      }
      if (duplicateFingerprints.has(row.duplicateFingerprint)) throw new ImportJobError(`确认时发现跨文件疑似重复记录：第 ${row.rowNumber} 行`);
      return true;
    });
    const groups = new Map<string, NormalizedRow[]>();
    const normalOrderNos = new Set<string>();
    for (const row of rows) {
      const orderRows = groups.get(row.orderNo);
      if (orderRows) orderRows.push(row);
      else groups.set(row.orderNo, [row]);
      if (row.eventType !== "legacy_adjustment") normalOrderNos.add(row.orderNo);
    }
    let importedOrders = 0;
    let importedEvents = 0;
    let reconciledEvents = 0;
    const reconciliationEventIds = reconciliationRows.map((item) => item.eventId);
    const reconciliationEvents = reconciliationEventIds.length
      ? await client.query<Record<string, unknown> & { event_id: string }>(
        `select event.id::text event_id,coalesce(event.source_key,source_evidence.source_key) source_key,
                event.event_type,event.import_batch_id::text,event.order_id::text,
                performance_order.customer_name,performance_order.customer_unit,
                performance_order.business_region_source_text,performance_order.business_region_code,
                performance_order.salesperson_person_id::text,performance_order.service_type,
                performance_order.collaborator_person_id::text,performance_order.collaboration_ratio::text,
                performance_order.source_received_on::text,performance_order.original_amount::text,
                (select count(*)::int from performance_events where order_id=performance_order.id and event_type<>'legacy_adjustment') non_legacy_event_count
         from performance_events event join performance_orders performance_order on performance_order.id=event.order_id
         left join legacy_event_source_evidence source_evidence on source_evidence.event_id=event.id
         where event.id=any($1::bigint[]) for update of performance_order`,
        [reconciliationEventIds],
      )
      : { rows: [] };
    const reconciliationEventsById = new Map(reconciliationEvents.rows.map((event) => [event.event_id, event]));

    for (const reconciliation of reconciliationRows.sort((left,right)=>compareImportRows(left.row,right.row))) {
      const event = reconciliationEventsById.get(reconciliation.eventId);
      if (!event || event.source_key !== reconciliation.row.sourceKey || event.event_type !== "legacy_adjustment" || event.import_batch_id) {
        throw new ImportJobError(`第 ${reconciliation.row.rowNumber} 行既有历史事件状态已变化，请重新预检`);
      }
      const differences = orderFactDifferences(event, reconciliation.row);
      if (differences.length) throw new ImportJobError(`订单基础事实冲突：${reconciliation.row.orderNo}；字段差异：${differences.join("、")}`);
      await updateLegacyOrderProjection(client,String(event.order_id),reconciliation.eventId,reconciliation.row);
      await client.query(
        `insert into legacy_event_import_reconciliations(event_id,batch_id,batch_row_id,reconciled_by,source_operator_status)
         values($1,$2,$3,$4,'unknown')`,
        [reconciliation.eventId, batchId, reconciliation.batchRowId, actorUserId],
      );
      reconciledEvents += 1;
    }

    const orderNos = [...groups.keys()];
    const existingOrders = orderNos.length
      ? await client.query<Record<string, unknown>>(
        `select id::text,qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
                salesperson_person_id::text,service_type,collaborator_person_id::text,collaboration_ratio::text,
                source_received_on::text,original_amount::text,
                current_revenue::text,counted_amount::text,lifecycle_state,
                (select count(*)::int from performance_events where order_id=performance_orders.id) as event_count,
                (select count(*)::int from performance_events where order_id=performance_orders.id and event_type<>'legacy_adjustment') non_legacy_event_count
         from performance_orders where qingflow_order_no=any($1::text[]) for update`,
        [orderNos],
      )
      : { rows: [] };
    const existingOrdersByOrderNo = new Map(existingOrders.rows.map((order) => [String(order.qingflow_order_no), order]));
    const inheritedCollaboratorOrganizations = await loadOrganizationSnapshots(client, rows.flatMap((row) => {
      const collaboratorPersonId = existingOrdersByOrderNo.get(row.orderNo)?.collaborator_person_id;
      return collaboratorPersonId && !row.collaboratorPersonId
        ? [{ personId: String(collaboratorPersonId), occurredOn: row.occurredOn }]
        : [];
    }));
    const sequenceHistory = await loadOrderSequenceHistory(client, [...normalOrderNos]);
    await assertAccountingPeriodsOpen(client, rows.flatMap((row) => row.correctionRequestId === undefined ? [accountingMonth(row.occurredOn)] : []));

    for (const [orderNo, orderRows] of groups) {
      orderRows.sort(compareImportRows);
      const first = orderRows[0]!;
      const allLegacy = orderRows.every((row) => row.eventType === "legacy_adjustment");
      const existing = existingOrdersByOrderNo.get(orderNo);
      let orderId: string;
      let counted = 0;
      let state: PerformanceState = { currentRevenue: 0, countedAmount: 0, lifecycle: "draft" };
      let priorEventCount = 0;
      let preserveHistoricalReview = false;
      let latestLegacyProjection: { row: NormalizedRow; eventId: string } | undefined;
      if (existing) {
        const differences = orderFactDifferences(existing, first);
        if (differences.length) throw new ImportJobError(`订单基础事实冲突：${orderNo}；字段差异：${differences.join("、")}`);
        orderId = String(existing.id);
        counted = Number(existing.counted_amount);
        if (!allLegacy) {
          if (existing.lifecycle_state === "historical_review_required") throw new ImportJobError(`历史待核订单不能导入新的业务事件：${orderNo}`);
          state = {
            currentRevenue: Number(existing.current_revenue),
            countedAmount: Number(existing.counted_amount),
            lifecycle: existing.lifecycle_state as PerformanceState["lifecycle"],
          };
        }
        priorEventCount = Number(existing.event_count);
        preserveHistoricalReview = existing.lifecycle_state === "historical_review_required";
      } else {
        const inserted = await client.query<{ id: string }>(
          `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
             salesperson_person_id,salesperson_name,service_type,collaborator_person_id,collaborator_name,collaboration_ratio,
             source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,created_by,posted_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,0,$14,$15,now()) returning id::text`,
          [orderNo, first.customerName, first.customerUnit, first.businessRegionSourceText, first.businessRegionCode,
           first.organization.personId, first.organization.salespersonName, first.serviceType || null,
           first.collaboratorPersonId ?? null, first.collaboratorOrganization?.salespersonName ?? null, first.collaborationRatio ?? null,
           first.occurredOn, first.amount, "draft", actorUserId],
        );
        orderId = inserted.rows[0]!.id;
        importedOrders += 1;
      }
      if (!allLegacy) {
        const sequenceIssues: ImportIssue[] = [];
        validateOrderSequenceAgainstLedger(sequenceHistory.get(orderNo) ?? [], orderRows, sequenceIssues);
        if (sequenceIssues.length) throw new ImportJobError(`确认时事件顺序已变化，请重新预检：${sequenceIssues[0]!.message}`);
      }
      for (const row of orderRows) {
        let eventRow = row;
        if (existing?.collaborator_person_id && !row.collaboratorPersonId && row.eventType !== "legacy_adjustment") {
          const collaboratorPersonId = String(existing.collaborator_person_id);
          const collaboratorOrganization = inheritedCollaboratorOrganizations.get(organizationKey(collaboratorPersonId, row.occurredOn));
          if (!collaboratorOrganization) throw new ImportJobError(`第 ${row.rowNumber} 行发生日期找不到协作人的唯一有效组织任职及负责人`);
          eventRow = {
            ...row,
            collaboratorPersonId,
            collaboratorSourceKey: collaboratorOrganization.salespersonName,
            collaborationRatio: Number(existing.collaboration_ratio),
            collaboratorOrganization,
          };
        }
        let correction = null;
        if (row.correctionRequestId !== undefined) {
          correction = await lockApprovedCorrection(client, row.correctionRequestId, orderId, row.eventType, actorPersonId, now);
          if (correction.periodMonth !== accountingMonth(row.occurredOn) || String(correction.occurredOn).slice(0, 10) !== row.occurredOn) {
            throw new ImportJobError(`第 ${row.rowNumber} 行更正授权与发生日期不匹配`);
          }
          if (correction.businessRegionCode !== row.businessRegionCode
            || correction.businessRegionSourceText !== row.businessRegionSourceText
            || correction.customerUnit !== row.customerUnit) {
            throw new ImportJobError(`第 ${row.rowNumber} 行分析维度与更正授权不匹配`);
          }
        }
        let eventId: string;
        if (row.eventType === "legacy_adjustment") {
          counted = Math.round((counted + row.amount) * 100) / 100;
          eventId = await insertEvent(client, batchId, orderId, eventRow, actorUserId, row.eventType, row.amount, Math.max(0, counted), counted);
          if (!latestLegacyProjection || compareLegacyProjectionRows(latestLegacyProjection.row,row)<0) {
            latestLegacyProjection={row,eventId};
          }
        } else {
          const command = commandFromImportRow(row)!;
          let decision;
          try {
            decision = decidePerformanceEvent(state, command);
          } catch (error) {
            const reason = error instanceof PerformanceRuleError ? error.message : "事件链无效";
            throw new ImportJobError(`第 ${row.rowNumber} 行事件链已变化，请重新预检：${reason}`);
          }
          eventId = await insertEvent(client, batchId, orderId, eventRow, actorUserId, decision.eventType, decision.deltaAmount,
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
      if (latestLegacyProjection) await updateLegacyOrderProjection(client,orderId,latestLegacyProjection.eventId,latestLegacyProjection.row);
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
