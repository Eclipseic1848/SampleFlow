import type { PoolClient } from "pg";

export async function recordEventAnalysisDimensions(
  client: Pick<PoolClient,"query">,
  eventId: string,
  dimensions: Readonly<{businessRegionCode:string;businessRegionSourceText:string;customerUnit:string}>,
): Promise<void> {
  await client.query(
    `insert into performance_event_analysis_dimensions
      (event_id,business_region_code,business_region_source_text,customer_unit)
     values($1,$2,$3,$4)`,
    [eventId,dimensions.businessRegionCode,dimensions.businessRegionSourceText,dimensions.customerUnit],
  );
}
