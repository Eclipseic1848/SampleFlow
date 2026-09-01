import type { FastifyRequest } from "fastify";

type Labels = Readonly<Record<string, string>>;
type Series = { labels: Labels; value: number };
type OperationResult = "success" | "failure";
type OperationalOutcome = Readonly<{ operation: string; result: OperationResult; reasonCode: string }>;

const trackedFailureOperations = new Set(["auth.login", "approval", "import"]);
const allowedMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

declare module "fastify" {
  interface FastifyRequest {
    operationalOutcome: OperationalOutcome | null;
  }
}

function labelText(labels: Labels): string {
  const values = Object.entries(labels).map(([name, value]) =>
    `${name}="${value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"')}"`
  );
  return values.length ? `{${values.join(",")}}` : "";
}

function add(series: Map<string, Series>, labels: Labels, value = 1): void {
  const key = JSON.stringify(labels);
  const current = series.get(key);
  if (current) current.value += value;
  else series.set(key, { labels, value });
}

function metric(lines: string[], name: string, type: "counter" | "gauge", help: string, series: Map<string, Series>): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const item of [...series.values()].sort((left, right) => JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)))) {
    lines.push(`${name}${labelText(item.labels)} ${item.value}`);
  }
}

export function requestOperation(routeTemplate: string): string {
  if (routeTemplate === "/api/auth/login") return "auth.login";
  if (routeTemplate === "/api/ready") return "database.readiness";
  if (routeTemplate.includes("/decision")
    || ["/accept", "/approve", "/decide", "/reject"].some((suffix) => routeTemplate.endsWith(suffix))) return "approval";
  if (routeTemplate.startsWith("/api/imports/")) return "import";
  return "http.request";
}

export function recordOperation(
  request: FastifyRequest,
  operation: string,
  result: OperationResult,
  reasonCode: string,
): void {
  request.operationalOutcome = { operation, result, reasonCode };
}

export class OperationalMetrics {
  readonly #requests = new Map<string, Series>();
  readonly #errors = new Map<string, Series>();
  readonly #durationCount = new Map<string, Series>();
  readonly #durationSum = new Map<string, Series>();
  readonly #operationFailures = new Map<string, Series>();
  #databaseReady = 0;

  observe(request: FastifyRequest, statusCode: number, durationMs: number) {
    const routeTemplate = request.routeOptions.url ?? "__unmatched__";
    const method = allowedMethods.has(request.method) ? request.method : "OTHER";
    const fallbackResult = statusCode < 400 ? "success" : "failure";
    const outcome = request.operationalOutcome ?? {
      operation: requestOperation(routeTemplate),
      result: fallbackResult,
      reasonCode: `HTTP_${statusCode}`,
    };
    const httpLabels = {
      route_template: routeTemplate,
      method,
      status_category: `${Math.floor(statusCode / 100)}xx`,
    };
    add(this.#requests, httpLabels);
    add(this.#durationCount, httpLabels);
    add(this.#durationSum, httpLabels, durationMs / 1000);
    if (statusCode >= 400) add(this.#errors, httpLabels);
    if (outcome.result === "failure" && trackedFailureOperations.has(outcome.operation)) {
      add(this.#operationFailures, { operation: outcome.operation, result: outcome.result, reason_code: outcome.reasonCode });
    }
    if (outcome.operation === "database.readiness") this.#databaseReady = outcome.result === "success" ? 1 : 0;
    return { routeTemplate, method, ...outcome };
  }

  text(): string {
    const lines: string[] = [];
    metric(lines, "sampleflow_http_requests_total", "counter", "HTTP requests.", this.#requests);
    metric(lines, "sampleflow_http_errors_total", "counter", "HTTP responses with status 4xx or 5xx.", this.#errors);
    metric(lines, "sampleflow_http_request_duration_seconds_count", "counter", "Observed HTTP request durations.", this.#durationCount);
    metric(lines, "sampleflow_http_request_duration_seconds_sum", "counter", "Sum of observed HTTP request durations in seconds.", this.#durationSum);
    metric(lines, "sampleflow_operation_failures_total", "counter", "Core operation failures.", this.#operationFailures);
    lines.push(
      "# HELP sampleflow_database_ready Whether database connectivity and schema are ready.",
      "# TYPE sampleflow_database_ready gauge",
      `sampleflow_database_ready ${this.#databaseReady}`,
    );
    return `${lines.join("\n")}\n`;
  }
}

export function writeProcessLog(
  operation: string,
  reasonCode: string,
  statusCode: number,
  result: OperationResult = "failure",
): void {
  process.stdout.write(`${JSON.stringify({
    time: Date.now(),
    level: result === "success" ? 30 : 50,
    service: "sampleflow-api",
    requestId: null,
    method: null,
    routeTemplate: null,
    statusCode,
    durationMs: 0,
    operation,
    result,
    reasonCode,
  })}\n`);
}
