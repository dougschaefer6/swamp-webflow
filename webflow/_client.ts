import { z } from "npm:zod@4.3.6";

/**
 * Shared Webflow API v2 client and schemas for extension models.
 *
 * Credentials are passed via globalArguments, typically resolved from vault:
 *   token: ${{ vault.get(<client-vault>, webflow-token) }}
 */

export const WebflowGlobalArgsSchema = z.object({
  token: z.string().meta({ sensitive: true }).describe(
    "Webflow OAuth bearer token. Use: ${{ vault.get(<client-vault>, webflow-token) }}",
  ),
  baseUrl: z
    .string()
    .default("https://api.webflow.com/v2")
    .describe("Webflow API v2 base URL"),
});

export type WebflowGlobalArgs = {
  token: string;
  baseUrl: string;
};

/** Method context fields these models use. */
export interface MethodContext {
  globalArgs: WebflowGlobalArgs;
  logger: {
    info: (message: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    instance: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** Context passed to pre-flight checks. */
export type CheckContext = Pick<MethodContext, "globalArgs">;

type MethodDef<A extends z.ZodType> = {
  description: string;
  labels?: string[];
  arguments: A;
  execute: (args: z.infer<A>, context: MethodContext) => Promise<unknown>;
};

/** Identity helper that types each method's execute args from its schema. */
export function defineMethods<T extends Record<string, z.ZodType>>(
  methods: { [K in keyof T]: MethodDef<T[K]> },
): { [K in keyof T]: MethodDef<T[K]> } {
  return methods;
}

/**
 * Error thrown for a non-2xx Webflow response. Carries the HTTP status so
 * callers branch on `status` rather than matching text in the message.
 */
export class WebflowApiError extends Error {
  readonly status: number;
  readonly retryAfter: string | null;

  constructor(
    status: number,
    statusText: string,
    body: string,
    retryAfter: string | null = null,
  ) {
    super(`Webflow API ${status} ${statusText}: ${body}`);
    this.name = "WebflowApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** True when `err` is a Webflow API error with the given HTTP status. */
export function isWebflowStatus(err: unknown, status: number): boolean {
  return err instanceof WebflowApiError && err.status === status;
}

export async function webflowApi(
  path: string,
  globalArgs: WebflowGlobalArgs,
  options?: {
    method?: string;
    params?: Record<string, string>;
    body?: unknown;
  },
): Promise<unknown> {
  const base = globalArgs.baseUrl.endsWith("/")
    ? globalArgs.baseUrl
    : globalArgs.baseUrl + "/";
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, base);
  if (options?.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${globalArgs.token}`,
    "Accept": "application/json",
  };

  const fetchOpts: RequestInit = {
    method: options?.method ?? "GET",
    headers,
  };

  if (options?.body) {
    headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(options.body);
  }

  const resp = await fetch(url.toString(), fetchOpts);

  if (!resp.ok) {
    const body = await resp.text();
    throw new WebflowApiError(
      resp.status,
      resp.statusText,
      body,
      resp.headers.get("retry-after"),
    );
  }

  if (resp.status === 204) return {};
  return resp.json();
}

/** Longest Retry-After wait honoured before the single 429 retry. */
const MAX_RETRY_AFTER_MS = 30_000;
/** Wait used when a 429 carries no usable Retry-After header. */
const DEFAULT_RETRY_AFTER_MS = 5_000;

/**
 * Milliseconds to wait before retrying a 429. Webflow documents
 * `X-RateLimit-*` headers on CMS 429s; `Retry-After` is honoured when
 * present (seconds or an HTTP date) and capped at 30 s.
 */
export function retryAfterMs(header: string | null): number {
  if (header === null || header.trim() === "") return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms)) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** GET one page, retrying once on a 429 after the Retry-After wait. */
async function getPageWithRetry(
  path: string,
  globalArgs: WebflowGlobalArgs,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  try {
    return await webflowApi(path, globalArgs, { params }) as Record<
      string,
      unknown
    >;
  } catch (err) {
    if (!isWebflowStatus(err, 429)) throw err;
    const wait = retryAfterMs((err as WebflowApiError).retryAfter);
    await new Promise((resolve) => setTimeout(resolve, wait));
    return await webflowApi(path, globalArgs, { params }) as Record<
      string,
      unknown
    >;
  }
}

export async function webflowPaginated(
  path: string,
  globalArgs: WebflowGlobalArgs,
  itemsKey: string,
  params?: Record<string, string>,
): Promise<unknown[]> {
  const allItems: unknown[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const result = await getPageWithRetry(path, globalArgs, {
      ...params,
      limit: String(limit),
      offset: String(offset),
    });

    const items = result[itemsKey] as unknown[] ?? [];
    // An empty page ends the walk even if `total` claims more remain, so a
    // stale or inconsistent total can never loop forever.
    if (items.length === 0) break;
    allItems.push(...items);

    const pagination = result.pagination as
      | { total: number; limit: number; offset: number }
      | undefined;
    if (!pagination || allItems.length >= pagination.total) break;
    offset += limit;
  }

  return allItems;
}

export function sanitizeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
