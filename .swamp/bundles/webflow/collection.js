// extensions/models/webflow/collection.ts
const { z: z2 } = globalThis.__swamp_zod;

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

// extensions/models/webflow/collection.ts
var FieldSchema = z2.object({
  id: z2.string(),
  isEditable: z2.boolean(),
  isRequired: z2.boolean(),
  type: z2.string(),
  slug: z2.string(),
  displayName: z2.string()
}).passthrough();
var CollectionSchema = z2.object({
  id: z2.string(),
  displayName: z2.string(),
  singularName: z2.string(),
  slug: z2.string(),
  createdOn: z2.string(),
  lastUpdated: z2.string(),
  fields: z2.array(FieldSchema)
}).passthrough();
var model = {
  type: "@dougschaefer/webflow-collection",
  version: "2026.03.20.1",
  globalArguments: WebflowGlobalArgsSchema,
  resources: {
    collection: {
      description: "Webflow CMS collection with field definitions",
      schema: CollectionSchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  methods: {
    list: {
      description: "List all CMS collections for a site.",
      arguments: z2.object({
        siteId: z2.string().describe("Webflow site ID")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const collections = await webflowPaginated(`/sites/${encodeURIComponent(args.siteId)}/collections`, g, "collections");
        context.logger.info("Found {count} collections for site {siteId}", {
          count: collections.length,
          siteId: args.siteId
        });
        const handles = [];
        for (const coll of collections) {
          const name = sanitizeId(coll.slug || coll.id);
          const handle = await context.writeResource("collection", name, coll);
          handles.push(handle);
        }
        return {
          dataHandles: handles
        };
      }
    },
    get: {
      description: "Get a specific collection with its field schema.",
      arguments: z2.object({
        collectionId: z2.string().describe("Webflow collection ID")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const coll = await webflowApi(`/collections/${encodeURIComponent(args.collectionId)}`, g);
        const name = sanitizeId(coll.slug || args.collectionId);
        const handle = await context.writeResource("collection", name, coll);
        context.logger.info("Retrieved collection {name}", {
          name: coll.displayName
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    }
  }
};
export {
  model
};
