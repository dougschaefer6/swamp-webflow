import { z } from "npm:zod@4";

/**
 * Shared Webflow API v2 client and schemas for extension models.
 *
 * Credentials are passed via globalArguments, typically resolved from vault:
 *   token: ${{ vault.get(<client-vault>, webflow-token) }}
 */

export const WebflowGlobalArgsSchema = z.object({
  token: z.string().describe(
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
    throw new Error(`Webflow API ${resp.status} ${resp.statusText}: ${body}`);
  }

  if (resp.status === 204) return {};
  return resp.json();
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
    const result = await webflowApi(path, globalArgs, {
      params: { ...params, limit: String(limit), offset: String(offset) },
    }) as Record<string, unknown>;

    const items = result[itemsKey] as unknown[] ?? [];
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
