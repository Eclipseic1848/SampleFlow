import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { standardBusinessRegionName } from "../domain/business-regions.js";
import { ImportWorkbookError, parseImportWorkbook, type ImportColumn, type ImportLayout } from "../domain/performance-import-xlsx.js";
import { confirmImportBatch, ImportJobError, preflightImportRows, type ImportEventType } from "../services/import-job.js";
import { hasAnyRole, PERFORMANCE_EDITOR_ROLES } from "./auth.js";

const columnNames = [
  "sourceRecordId", "orderNo", "occurredOn", "customerName", "customerUnit", "businessRegionSourceText",
  "salespersonSourceKey", "serviceType", "eventType", "businessSequence", "correctionRequestId", "amount", "reason",
] as const satisfies readonly ImportColumn[];

const requiredColumnNames = columnNames.filter((name) => name !== "sourceRecordId" && name !== "eventType" && name !== "businessSequence" && name !== "correctionRequestId");
const columnMappingSchema = z.object({
  ...Object.fromEntries(requiredColumnNames.map((name) => [name, z.string().min(1).max(100)])),
  sourceRecordId: z.string().min(1).max(100).optional(),
  eventType: z.string().min(1).max(100).optional(),
  businessSequence: z.string().min(1).max(100).optional(),
  correctionRequestId: z.string().min(1).max(100).optional(),
} as Record<Exclude<ImportColumn, "sourceRecordId" | "eventType" | "businessSequence" | "correctionRequestId">, z.ZodString> & { sourceRecordId: z.ZodOptional<z.ZodString>; eventType: z.ZodOptional<z.ZodString>; businessSequence: z.ZodOptional<z.ZodString>; correctionRequestId: z.ZodOptional<z.ZodString> });
const configSchema = z.strictObject({
  configKey: z.string().trim().min(1).max(100).regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1).max(200),
  sheetName: z.string().trim().min(1).max(100),
  expectedHeaders: z.array(z.union([z.string().min(1).max(100), z.null()])).min(1).max(200),
  columnMapping: columnMappingSchema,
  requiredColumns: z.array(z.enum(columnNames)).min(1).max(columnNames.length).refine((items) => new Set(items).size === items.length, "必填字段不能重复"),
  allowedEventTypes: z.array(z.enum(["initial", "revenue_change", "pause", "restart", "first_include", "legacy_adjustment"] satisfies ImportEventType[])).min(1).max(6).refine((items) => new Set(items).size === items.length, "允许事件类型不能重复"),
  businessRegionMapping: z.record(
    z.string().min(1).max(100),
    z.string().refine((value) => standardBusinessRegionName(value) !== undefined, "必须映射到标准业务区域"),
  ),
  personMapping: z.record(z.string().min(1).max(200), z.string().min(1).max(200)).default({}),
  fixedEventType: z.literal("legacy_adjustment").optional(),
  allowLegacySourceKey: z.boolean().default(false),
});
type ConfigInput = z.infer<typeof configSchema>;
const preflightSchema = z.strictObject({
  configId: z.coerce.number().int().positive(),
  fileName: z.string().min(1).max(255),
  contentBase64: z.string().min(1).max(40_000_000),
});
const confirmSchema = z.strictObject({ confirmedWarnings: z.array(z.string().min(1).max(100)).max(5_000).default([]) });

function denyPerformanceEditor(request: { currentUser: import("./auth.js").CurrentUser | null }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
  if (!hasAnyRole(request.currentUser, PERFORMANCE_EDITOR_ROLES)) return reply.code(403).send({ message: "仅业绩数据维护角色可以使用 Excel 导入" });
  return null;
}

function decodeBase64(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  const normalized = value.replace(/=+$/, "");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== normalized) throw new ImportJobError("上传内容不是有效的 Base64 文件");
  return bytes;
}

function configInputError(input: ConfigInput): string | null {
  const mappedHeaders = Object.values(input.columnMapping).filter((header): header is string => Boolean(header));
  const namedExpectedHeaders = input.expectedHeaders.filter((header): header is string => header !== null);
  if (new Set(mappedHeaders).size !== mappedHeaders.length) return "每个业务字段必须映射到不同的精确表头";
  if (new Set(namedExpectedHeaders).size !== namedExpectedHeaders.length) return "完整表头契约不能包含重复的具名列";
  if (input.requiredColumns.some((column) => !input.columnMapping[column] && !(column === "eventType" && input.fixedEventType))) return "必填字段必须存在对应列映射或固定事件类型";
  if (!input.allowLegacySourceKey && !input.columnMapping.sourceRecordId) return "非历史配置必须映射稳定来源记录标识";
  if (!input.fixedEventType && !input.columnMapping.eventType) return "配置必须映射事件类型，或将获批历史格式固定为 legacy_adjustment";
  if (input.fixedEventType && !input.allowLegacySourceKey) return "固定历史事件类型只能用于获批历史配置";
  if (input.allowLegacySourceKey && !input.fixedEventType) return "历史行号来源键只能用于固定为 legacy_adjustment 的专用历史配置";
  if (input.fixedEventType && input.columnMapping.eventType) return "固定历史事件类型与事件类型列映射不能同时配置";
  if (input.fixedEventType && (input.allowedEventTypes.length !== 1 || input.allowedEventTypes[0] !== input.fixedEventType)) return "固定历史配置只能允许 legacy_adjustment";
  if (!input.fixedEventType && input.allowedEventTypes.includes("legacy_adjustment")) return "普通配置不能允许 legacy_adjustment";
  if (mappedHeaders.some((header) => !namedExpectedHeaders.includes(header))) return "字段映射必须引用完整表头契约中的精确列名";
  return null;
}

export async function registerImports(app: FastifyInstance, database: Database) {
  app.get("/api/imports/configs", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    if (!hasAnyRole(request.currentUser, [...PERFORMANCE_EDITOR_ROLES, "hr"])) {
      return reply.code(403).send({ message: "当前角色无权查看导入配置" });
    }
    const includeDrafts = hasAnyRole(request.currentUser, ["sales_assistant_leader", "hr"]);
    const result = await database.query(
      `select id::text,config_key as "configKey",version,name,status,sheet_name as "sheetName",
              column_mapping as "columnMapping",required_columns as "requiredColumns",allowed_event_types as "allowedEventTypes",business_region_mapping as "businessRegionMapping",
              allow_legacy_source_key as "allowLegacySourceKey",created_at as "createdAt",approved_at as "approvedAt"
       from import_configs where status='approved' or $1::boolean order by config_key,version desc`,
      [includeDrafts],
    );
    return { configs: result.rows };
  });

  app.post("/api/imports/configs", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    if (!hasAnyRole(request.currentUser, ["sales_assistant_leader"])) return reply.code(403).send({ message: "仅销售助理组长可以创建导入配置草稿" });
    const parsed = configSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "导入配置无效", issues: parsed.error.issues });
    const input = parsed.data;
    const invalid = configInputError(input);
    if (invalid) return reply.code(400).send({ message: invalid });
    const client = await database.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('sampleflow:import-config'))");
      const version = await client.query<{ next_version: number }>("select coalesce(max(version),0)+1 as next_version from import_configs where config_key=$1", [input.configKey]);
      const inserted = await client.query<{ id: string }>(
        `insert into import_configs(config_key,version,name,status,sheet_name,expected_headers,column_mapping,required_columns,allowed_event_types,business_region_mapping,person_mapping,fixed_event_type,allow_legacy_source_key,created_by)
         values($1,$2,$3,'draft',$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13) returning id::text`,
        [input.configKey, version.rows[0]!.next_version, input.name, input.sheetName, JSON.stringify(input.expectedHeaders), JSON.stringify(input.columnMapping),
         JSON.stringify(input.requiredColumns), JSON.stringify(input.allowedEventTypes), JSON.stringify(input.businessRegionMapping), JSON.stringify(input.personMapping), input.fixedEventType??null, input.allowLegacySourceKey, request.currentUser.id],
      );
      await client.query(
        `insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,ip_address)
         values($1,'import.config_created','import_config',$2,jsonb_build_object('configKey',$3::text,'version',$4::int),$5)`,
        [request.currentUser.id, inserted.rows[0]!.id, input.configKey, version.rows[0]!.next_version, request.ip],
      );
      await client.query("commit");
      return reply.code(201).send({ id: inserted.rows[0]!.id, version: version.rows[0]!.next_version });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch("/api/imports/configs/:id", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    if (!hasAnyRole(request.currentUser, ["sales_assistant_leader"])) return reply.code(403).send({ message: "仅销售助理组长可以修改导入配置草稿" });
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const parsed = configSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "导入配置无效" });
    const invalid = configInputError(parsed.data);
    if (invalid) return reply.code(400).send({ message: invalid });
    const input = parsed.data;
    const result = await database.query(
      `update import_configs set name=$3,sheet_name=$4,expected_headers=$5::jsonb,column_mapping=$6::jsonb,
         required_columns=$7::jsonb,allowed_event_types=$8::jsonb,business_region_mapping=$9::jsonb,person_mapping=$10::jsonb,fixed_event_type=$11,allow_legacy_source_key=$12
       where id=$1 and config_key=$2 and status='draft' and created_by=$13
         and not exists(select 1 from import_batches where config_id=import_configs.id)
       returning id`,
      [params.data.id, input.configKey, input.name, input.sheetName, JSON.stringify(input.expectedHeaders), JSON.stringify(input.columnMapping),
       JSON.stringify(input.requiredColumns), JSON.stringify(input.allowedEventTypes), JSON.stringify(input.businessRegionMapping), JSON.stringify(input.personMapping), input.fixedEventType??null,
       input.allowLegacySourceKey, request.currentUser.id],
    );
    if (!result.rowCount) return reply.code(409).send({ message: "配置不存在、不是本人草稿或已经产生导入批次" });
    return { id: String(params.data.id), status: "draft" };
  });

  app.post("/api/imports/configs/:id/approve", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    if (!hasAnyRole(request.currentUser, ["hr"])) return reply.code(403).send({ message: "仅人事部可以批准导入配置" });
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "导入配置标识无效" });
    const client = await database.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `update import_configs set status='approved',approved_by=$2,approved_at=now()
         where id=$1 and status='draft' and created_by is distinct from $2 and business_region_mapping<>'{}'::jsonb
         returning id`,
        [params.data.id, request.currentUser.id],
      );
      if (!result.rowCount) {
        await client.query("rollback");
        return reply.code(409).send({ message: "配置不存在、不是草稿、缺少业务区域映射，或创建人不能自行批准" });
      }
      await client.query(
        `insert into audit_logs(actor_user_id,action,entity_type,entity_id,ip_address)
         values($1,'import.config_approved','import_config',$2,$3)`,
        [request.currentUser.id, String(params.data.id), request.ip],
      );
      await client.query("commit");
      return { id: String(params.data.id), status: "approved" };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/imports/preflight", { bodyLimit: 30_000_000 }, async (request, reply) => {
    const denied = denyPerformanceEditor(request, reply);
    if (denied) return denied;
    const parsed = preflightSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "上传参数无效" });
    try {
      const config = await database.query<{ sheet_name: string; expected_headers: unknown[]; column_mapping: ImportLayout["columnMapping"]; person_mapping: Record<string, string>; fixed_event_type:"legacy_adjustment"|null }>(
        "select sheet_name,expected_headers,column_mapping,person_mapping,fixed_event_type from import_configs where id=$1 and status='approved'",
        [parsed.data.configId],
      );
      if (!config.rows[0]) return reply.code(409).send({ message: "只能使用已批准的导入配置" });
      const bytes = decodeBase64(parsed.data.contentBase64);
      const rows = await parseImportWorkbook(parsed.data.fileName, bytes, {
        sheetName: config.rows[0].sheet_name,
        expectedHeaders: config.rows[0].expected_headers,
        columnMapping: config.rows[0].column_mapping,
        personMapping: config.rows[0].person_mapping,
        ...(config.rows[0].fixed_event_type?{fixedEventType:config.rows[0].fixed_event_type}:{}),
      });
      return await preflightImportRows(database, {
        actorUserId: request.currentUser!.id,
        configId: String(parsed.data.configId),
        sourceFileName: parsed.data.fileName,
        sourceBytes: bytes,
        rows,
      });
    } catch (error) {
      if (error instanceof ImportJobError || error instanceof ImportWorkbookError) return reply.code(409).send({ message: error.message });
      throw error;
    }
  });

  app.post("/api/imports/batches/:id/confirm", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    if (!hasAnyRole(request.currentUser, ["sales_assistant_leader"])) return reply.code(403).send({ message: "仅销售助理组长可以确认导入批次" });
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = confirmSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ message: "确认参数无效" });
    try {
      return await confirmImportBatch(database, String(params.data.id), request.currentUser.id, body.data.confirmedWarnings, request.ip);
    } catch (error) {
      if (error instanceof ImportJobError) return reply.code(409).send({ message: error.message });
      throw error;
    }
  });
}
