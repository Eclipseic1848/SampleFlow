import path from "node:path";
import readXlsxFile from "read-excel-file/node";
import { unzipFixedValueXlsxArchive } from "./xlsx-safety.js";
import type { ImportEventType, ImportSourceRow } from "../services/import-job.js";

export type ImportColumn = keyof Omit<ImportSourceRow, "sheet" | "rowNumber">;
export class ImportWorkbookError extends Error {}

export type ImportLayout = Readonly<{
  sheetName: string;
  expectedHeaders?: readonly unknown[];
  columnMapping: Readonly<Record<Exclude<ImportColumn, "sourceRecordId" | "eventType" | "businessSequence" | "correctionRequestId">, string> & Partial<Record<"sourceRecordId" | "eventType" | "businessSequence" | "correctionRequestId", string>>>;
  personMapping?: Readonly<Record<string, string>>;
  fixedEventType?: ImportEventType;
}>;

function textCell(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function dateCell(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return textCell(value);
}

function bigintIdCell(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return "";
}

export function mapImportWorksheetRows(data: readonly (readonly unknown[])[], layout: ImportLayout): ImportSourceRow[] {
  const header = data[0];
  if (!header) throw new ImportWorkbookError(`“${layout.sheetName}”工作表为空`);
  const mapping = new Map(header.map((value, index) => [value, index]));
  const configuredHeaders = Object.values(layout.columnMapping);
  const expectedHeaders = layout.expectedHeaders ?? configuredHeaders;
  if (JSON.stringify(header) !== JSON.stringify(expectedHeaders) || configuredHeaders.some((name) => !mapping.has(name))) {
    throw new ImportWorkbookError(`“${layout.sheetName}”工作表表头与所选配置不一致`);
  }
  const value = (row: readonly unknown[], field: ImportColumn) => row[mapping.get(layout.columnMapping[field])!];
  return data.slice(1).flatMap((row, index) => {
    if (!row.some((cell) => cell !== null)) return [];
    const rowNumber = index + 2;
    const eventType = layout.fixedEventType ?? (layout.columnMapping.eventType
      ? textCell(value(row, "eventType"))
      : "");
    const rawAmount = value(row, "amount");
    const amount = typeof rawAmount === "number" ? rawAmount : Number.NaN;
    const sourceRecordId = layout.columnMapping.sourceRecordId
      ? textCell(value(row, "sourceRecordId"))
      : undefined;
    const rawBusinessSequence = layout.columnMapping.businessSequence ? value(row, "businessSequence") : undefined;
    const rawCorrectionRequestId = layout.columnMapping.correctionRequestId ? value(row, "correctionRequestId") : undefined;
    const correctionRequestId = bigintIdCell(rawCorrectionRequestId);
    return [{
      sheet: layout.sheetName,
      rowNumber,
      ...(typeof rawBusinessSequence === "number" ? { businessSequence: rawBusinessSequence } : {}),
      ...(correctionRequestId === undefined ? {} : { correctionRequestId }),
      ...(sourceRecordId ? { sourceRecordId } : {}),
      orderNo: textCell(value(row, "orderNo")),
      occurredOn: dateCell(value(row, "occurredOn")),
      customerName: textCell(value(row, "customerName")),
      customerUnit: textCell(value(row, "customerUnit")),
      businessRegionSourceText: textCell(value(row, "businessRegionSourceText")),
      salespersonSourceKey: (() => {
        const sourceValue = textCell(value(row, "salespersonSourceKey"));
        return layout.personMapping?.[sourceValue] ?? sourceValue;
      })(),
      serviceType: textCell(value(row, "serviceType")),
      eventType,
      amount,
      reason: textCell(value(row, "reason")),
    }];
  });
}

export async function parseImportWorkbook(
  sourceFileName: string,
  sourceBytes: Uint8Array,
  layout: ImportLayout,
): Promise<ImportSourceRow[]> {
  if (path.extname(sourceFileName).toLowerCase() !== ".xlsx") throw new ImportWorkbookError("只接受 .xlsx 工作簿");
  try {
    unzipFixedValueXlsxArchive(sourceBytes);
  } catch (error) {
    throw new ImportWorkbookError(error instanceof Error ? error.message : "工作簿安全检查失败");
  }
  let sheets;
  try {
    sheets = await readXlsxFile(Buffer.from(sourceBytes));
  } catch {
    throw new ImportWorkbookError("工作簿无法读取");
  }
  const sheet = sheets.find((candidate) => candidate.sheet === layout.sheetName);
  if (!sheet) throw new ImportWorkbookError(`工作簿缺少“${layout.sheetName}”工作表`);
  return mapImportWorksheetRows(sheet.data, layout);
}
