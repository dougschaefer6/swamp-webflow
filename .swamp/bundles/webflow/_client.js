// extensions/models/webflow/_client.ts
const { z } = globalThis.__swamp_zod;
var WebflowGlobalArgsSchema = z.object({
  token: z.string().describe("Webflow OAuth bearer token. Use: ${{ vault.get(<client-vault>, webflow-token) }}"),
  baseUrl: z.string().default("https://api.webflow.com/v2").describe("Webflow API v2 base URL")
});
async function webflowApi(path, globalArgs, options) {
  const base = globalArgs.baseUrl.endsWith("/") ? globalArgs.baseUrl : globalArgs.baseUrl + "/";
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, base);
  if (options?.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== void 0 && v !== "") url.searchParams.set(k, v);
    }
  }
  const headers = {
    "Authorization": `Bearer ${globalArgs.token}`,
    "Accept": "application/json"
  };
  const fetchOpts = {
    method: options?.method ?? "GET",
    headers
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
async function webflowPaginated(path, globalArgs, itemsKey, params) {
  const allItems = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const result = await webflowApi(path, globalArgs, {
      params: {
        ...params,
        limit: String(limit),
        offset: String(offset)
      }
    });
    const items = result[itemsKey] ?? [];
    allItems.push(...items);
    const pagination = result.pagination;
    if (!pagination || allItems.length >= pagination.total) break;
    offset += limit;
  }
  return allItems;
}
function sanitizeId(id) {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
export {
  WebflowGlobalArgsSchema,
  sanitizeId,
  webflowApi,
  webflowPaginated
};
