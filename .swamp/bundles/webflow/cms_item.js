// extensions/models/webflow/cms_item.ts
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

// extensions/models/webflow/cms_item.ts
var CmsItemSchema = z2.object({
  id: z2.string(),
  cmsLocaleId: z2.string().optional(),
  lastPublished: z2.string().nullable(),
  lastUpdated: z2.string(),
  createdOn: z2.string(),
  isArchived: z2.boolean(),
  isDraft: z2.boolean(),
  fieldData: z2.record(z2.string(), z2.unknown())
}).passthrough();
var model = {
  type: "@dougschaefer/webflow-cms-item",
  version: "2026.03.20.1",
  globalArguments: WebflowGlobalArgsSchema,
  resources: {
    item: {
      description: "Webflow CMS collection item with field data",
      schema: CmsItemSchema,
      lifetime: "infinite",
      garbageCollection: 50
    }
  },
  methods: {
    list: {
      description: "List all items in a CMS collection.",
      arguments: z2.object({
        collectionId: z2.string().describe("Webflow collection ID")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const items = await webflowPaginated(`/collections/${encodeURIComponent(args.collectionId)}/items`, g, "items");
        context.logger.info("Found {count} items in collection {collectionId}", {
          count: items.length,
          collectionId: args.collectionId
        });
        const handles = [];
        for (const item of items) {
          const fieldData = item.fieldData ?? {};
          const slug = fieldData.slug ?? item.id;
          const name = sanitizeId(slug);
          const handle = await context.writeResource("item", name, item);
          handles.push(handle);
        }
        return {
          dataHandles: handles
        };
      }
    },
    get: {
      description: "Get a specific CMS item by ID.",
      arguments: z2.object({
        collectionId: z2.string().describe("Webflow collection ID"),
        itemId: z2.string().describe("Webflow item ID")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const item = await webflowApi(`/collections/${encodeURIComponent(args.collectionId)}/items/${encodeURIComponent(args.itemId)}`, g);
        const fieldData = item.fieldData ?? {};
        const slug = fieldData.slug ?? args.itemId;
        const name = sanitizeId(slug);
        const handle = await context.writeResource("item", name, item);
        context.logger.info("Retrieved item {name}", {
          name: slug
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    create: {
      description: "Create a new CMS item in a collection.",
      arguments: z2.object({
        collectionId: z2.string().describe("Webflow collection ID"),
        fieldData: z2.record(z2.string(), z2.unknown()).describe("Field data for the new item"),
        isDraft: z2.boolean().optional().default(false).describe("Create as draft")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const item = await webflowApi(`/collections/${encodeURIComponent(args.collectionId)}/items`, g, {
          method: "POST",
          body: {
            fieldData: args.fieldData,
            isDraft: args.isDraft
          }
        });
        const fieldData = item.fieldData ?? {};
        const slug = fieldData.slug ?? item.id;
        const name = sanitizeId(slug);
        const handle = await context.writeResource("item", name, item);
        context.logger.info("Created item {name} in collection {collectionId}", {
          name: slug,
          collectionId: args.collectionId
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    update: {
      description: "Update an existing CMS item's field data.",
      arguments: z2.object({
        collectionId: z2.string().describe("Webflow collection ID"),
        itemId: z2.string().describe("Webflow item ID"),
        fieldData: z2.record(z2.string(), z2.unknown()).describe("Fields to update (partial)")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const item = await webflowApi(`/collections/${encodeURIComponent(args.collectionId)}/items/${encodeURIComponent(args.itemId)}`, g, {
          method: "PATCH",
          body: {
            fieldData: args.fieldData
          }
        });
        const fieldData = item.fieldData ?? {};
        const slug = fieldData.slug ?? args.itemId;
        const name = sanitizeId(slug);
        const handle = await context.writeResource("item", name, item);
        context.logger.info("Updated item {name}", {
          name: slug
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    delete: {
      description: "Delete a CMS item. Verify the item ID before calling.",
      arguments: z2.object({
        collectionId: z2.string().describe("Webflow collection ID"),
        itemId: z2.string().describe("Webflow item ID")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await webflowApi(`/collections/${encodeURIComponent(args.collectionId)}/items/${encodeURIComponent(args.itemId)}`, g, {
          method: "DELETE"
        });
        context.logger.info("Deleted item {itemId} from collection {collectionId}", {
          itemId: args.itemId,
          collectionId: args.collectionId
        });
        return {
          data: {
            attributes: {
              collectionId: args.collectionId,
              itemId: args.itemId,
              deletedAt: (/* @__PURE__ */ new Date()).toISOString()
            },
            name: "delete-result"
          }
        };
      }
    },
    publish: {
      description: "Publish one or more CMS items to make them live.",
      arguments: z2.object({
        collectionId: z2.string().describe("Webflow collection ID"),
        itemIds: z2.array(z2.string()).describe("Array of item IDs to publish")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const result = await webflowApi(`/collections/${encodeURIComponent(args.collectionId)}/items/publish`, g, {
          method: "POST",
          body: {
            itemIds: args.itemIds
          }
        });
        context.logger.info("Published {count} items in collection {collectionId}", {
          count: args.itemIds.length,
          collectionId: args.collectionId
        });
        return {
          data: {
            attributes: {
              collectionId: args.collectionId,
              publishedIds: args.itemIds,
              publishedAt: (/* @__PURE__ */ new Date()).toISOString(),
              result
            },
            name: "publish-result"
          }
        };
      }
    }
  }
};
export {
  model
};
