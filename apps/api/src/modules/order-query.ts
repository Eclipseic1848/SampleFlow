import { z } from "zod";
import { standardBusinessRegionName } from "../domain/business-regions.js";

const orderTextFilterSchema = z.string().trim().min(1).max(300);

export const orderFilterQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  orderNo: z.string().trim().min(1).max(100).optional(),
  month: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/).optional(),
  status: z.enum(["draft", "active", "paused", "zero", "historical_review_required"]).optional(),
  salesperson: orderTextFilterSchema.optional(),
  department: orderTextFilterSchema.optional(),
  group: orderTextFilterSchema.optional(),
  region: z.string().refine((value) => standardBusinessRegionName(value) !== undefined).optional(),
  customerUnit: orderTextFilterSchema.optional(),
});

export type OrderFilters = Readonly<{
  search: string;
  orderNo: string;
  month: string;
  status: string;
  salesperson: string;
  department: string;
  group: string;
  region: string;
  customerUnit: string;
}>;

export function normalizeOrderFilters(input: z.infer<typeof orderFilterQuerySchema>): OrderFilters {
  return {
    search: input.search ?? "",
    orderNo: input.orderNo ?? "",
    month: input.month ?? "",
    status: input.status ?? "",
    salesperson: input.salesperson ?? "",
    department: input.department ?? "",
    group: input.group ?? "",
    region: input.region ?? "",
    customerUnit: input.customerUnit ?? "",
  };
}

export function latestOrderEventJoinSql(orderAlias: string, eventAlias: string): string {
  return `left join (
    select distinct on (order_id) order_id,salesperson_person_id,department_unit_id,group_unit_id,
           salesperson_name,department_name,group_name,leader_name,supervisor_name
    from performance_events order by order_id,occurred_on desc,id desc
  ) ${eventAlias} on ${eventAlias}.order_id=${orderAlias}.id`;
}

export function orderFilterSql(orderAlias: string, eventAlias: string, firstParameter: number): string {
  return `($${firstParameter}::text is null or ${orderAlias}.qingflow_order_no ilike $${firstParameter}
      or ${orderAlias}.salesperson_name ilike $${firstParameter} or ${orderAlias}.customer_name ilike $${firstParameter}
      or ${orderAlias}.customer_unit ilike $${firstParameter})
    and ($${firstParameter + 1}::date is null or (${orderAlias}.source_received_on >= $${firstParameter + 1}::date
      and ${orderAlias}.source_received_on < $${firstParameter + 1}::date + interval '1 month'))
    and ($${firstParameter + 2}::text is null or ${orderAlias}.lifecycle_state=$${firstParameter + 2})
    and ($${firstParameter + 3}::text is null or ${orderAlias}.salesperson_name=$${firstParameter + 3})
    and ($${firstParameter + 4}::text is null or ${eventAlias}.department_name=$${firstParameter + 4})
    and ($${firstParameter + 5}::text is null or ${eventAlias}.group_name=$${firstParameter + 5})
    and ($${firstParameter + 6}::text is null or ${orderAlias}.business_region_code=$${firstParameter + 6})
    and ($${firstParameter + 7}::text is null or ${orderAlias}.customer_unit=$${firstParameter + 7})
    and ($${firstParameter + 8}::text is null or regexp_replace(lower(normalize(${orderAlias}.qingflow_order_no,NFKC)),'[[:space:]]+','','g')
      =regexp_replace(lower(normalize($${firstParameter + 8},NFKC)),'[[:space:]]+','','g'))`;
}

export function orderFilterValues(filters: OrderFilters): unknown[] {
  return [
    filters.search ? `%${filters.search}%` : null,
    filters.month ? `${filters.month}-01` : null,
    filters.status || null,
    filters.salesperson || null,
    filters.department || null,
    filters.group || null,
    filters.region || null,
    filters.customerUnit || null,
    filters.orderNo || null,
  ];
}
