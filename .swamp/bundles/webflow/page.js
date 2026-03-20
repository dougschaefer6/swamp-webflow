// extensions/models/webflow/page.ts
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

// extensions/models/webflow/page.ts
var SeoSchema = z2.object({
  title: z2.string().nullable().optional(),
  description: z2.string().nullable().optional()
}).passthrough();
var OpenGraphSchema = z2.object({
  title: z2.string().nullable().optional(),
  titleCopied: z2.boolean().optional(),
  description: z2.string().nullable().optional(),
  descriptionCopied: z2.boolean().optional()
}).passthrough();
var PageSchema = z2.object({
  id: z2.string(),
  siteId: z2.string(),
  title: z2.string(),
  slug: z2.string(),
  parentId: z2.string().nullable(),
  collectionId: z2.string().nullable(),
  createdOn: z2.string(),
  lastUpdated: z2.string(),
  archived: z2.boolean(),
  draft: z2.boolean(),
  seo: SeoSchema.optional(),
  openGraph: OpenGraphSchema.optional()
}).passthrough();
var model = {
  type: "@dougschaefer/webflow-page",
  version: "2026.03.20.1",
  globalArguments: WebflowGlobalArgsSchema,
  resources: {
    page: {
      description: "Webflow page with SEO metadata and publishing status",
      schema: PageSchema,
      lifetime: "infinite",
      garbageCollection: 20
    }
  },
  methods: {
    list: {
      description: "List all pages for a site.",
      arguments: z2.object({
        siteId: z2.string().describe("Webflow site ID")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const pages = await webflowPaginated(`/sites/${encodeURIComponent(args.siteId)}/pages`, g, "pages");
        context.logger.info("Found {count} pages for site {siteId}", {
          count: pages.length,
          siteId: args.siteId
        });
        const handles = [];
        for (const page of pages) {
          const name = sanitizeId(page.slug || page.id);
          const handle = await context.writeResource("page", name, page);
          handles.push(handle);
        }
        return {
          dataHandles: handles
        };
      }
    },
    get: {
      description: "Get a specific page with its metadata.",
      arguments: z2.object({
        pageId: z2.string().describe("Webflow page ID")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const page = await webflowApi(`/pages/${encodeURIComponent(args.pageId)}`, g);
        const name = sanitizeId(page.slug || args.pageId);
        const handle = await context.writeResource("page", name, page);
        context.logger.info("Retrieved page {name}", {
          name: page.title
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    updateSettings: {
      description: "Update page settings including SEO metadata and Open Graph.",
      arguments: z2.object({
        pageId: z2.string().describe("Webflow page ID"),
        title: z2.string().optional().describe("Page title"),
        slug: z2.string().optional().describe("URL slug"),
        seoTitle: z2.string().optional().describe("SEO title tag"),
        seoDescription: z2.string().optional().describe("SEO meta description"),
        ogTitle: z2.string().optional().describe("Open Graph title"),
        ogDescription: z2.string().optional().describe("Open Graph description")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body = {};
        if (args.title !== void 0) body.title = args.title;
        if (args.slug !== void 0) body.slug = args.slug;
        const seo = {};
        if (args.seoTitle !== void 0) seo.title = args.seoTitle;
        if (args.seoDescription !== void 0) seo.description = args.seoDescription;
        if (Object.keys(seo).length > 0) body.seo = seo;
        const og = {};
        if (args.ogTitle !== void 0) og.title = args.ogTitle;
        if (args.ogDescription !== void 0) og.description = args.ogDescription;
        if (Object.keys(og).length > 0) body.openGraph = og;
        const page = await webflowApi(`/pages/${encodeURIComponent(args.pageId)}`, g, {
          method: "PUT",
          body
        });
        const name = sanitizeId(page.slug || args.pageId);
        const handle = await context.writeResource("page", name, page);
        context.logger.info("Updated page settings for {name}", {
          name: page.title
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    getContent: {
      description: "Get the static content (DOM nodes) for a page.",
      arguments: z2.object({
        pageId: z2.string().describe("Webflow page ID")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const content = await webflowApi(`/pages/${encodeURIComponent(args.pageId)}/dom`, g);
        context.logger.info("Retrieved DOM content for page {pageId}", {
          pageId: args.pageId
        });
        return {
          data: {
            attributes: {
              pageId: args.pageId,
              content
            },
            name: `page-content-${sanitizeId(args.pageId)}`
          }
        };
      }
    }
  }
};
export {
  model
};
