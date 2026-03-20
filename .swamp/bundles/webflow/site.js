// extensions/models/webflow/site.ts
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
function sanitizeId(id) {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

// extensions/models/webflow/site.ts
var CustomDomainSchema = z2.object({
  id: z2.string(),
  url: z2.string(),
  lastPublished: z2.string().nullable()
}).passthrough();
var LocaleSchema = z2.object({
  id: z2.string(),
  cmsLocaleId: z2.string(),
  enabled: z2.boolean(),
  displayName: z2.string(),
  tag: z2.string()
}).passthrough();
var SiteSchema = z2.object({
  id: z2.string(),
  workspaceId: z2.string(),
  displayName: z2.string(),
  shortName: z2.string(),
  previewUrl: z2.string().nullable(),
  timeZone: z2.string(),
  createdOn: z2.string(),
  lastUpdated: z2.string(),
  lastPublished: z2.string().nullable(),
  customDomains: z2.array(CustomDomainSchema),
  locales: z2.object({
    primary: LocaleSchema,
    secondary: z2.array(LocaleSchema)
  })
}).passthrough();
var model = {
  type: "@dougschaefer/webflow-site",
  version: "2026.03.20.1",
  globalArguments: WebflowGlobalArgsSchema,
  resources: {
    site: {
      description: "Webflow site with domains, locale, and publishing status",
      schema: SiteSchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  methods: {
    list: {
      description: "List all Webflow sites accessible to the authenticated token.",
      arguments: z2.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const result = await webflowApi("/sites", g);
        const sites = result.sites ?? [];
        context.logger.info("Found {count} sites", {
          count: sites.length
        });
        const handles = [];
        for (const site of sites) {
          const name = sanitizeId(site.shortName || site.id);
          const handle = await context.writeResource("site", name, site);
          handles.push(handle);
        }
        return {
          dataHandles: handles
        };
      }
    },
    get: {
      description: "Get detailed information about a specific site.",
      arguments: z2.object({
        siteId: z2.string().describe("Webflow site ID")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const site = await webflowApi(`/sites/${encodeURIComponent(args.siteId)}`, g);
        const name = sanitizeId(site.shortName || args.siteId);
        const handle = await context.writeResource("site", name, site);
        context.logger.info("Retrieved site {name}", {
          name: site.displayName
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    publish: {
      description: "Publish a site to its custom domains.",
      arguments: z2.object({
        siteId: z2.string().describe("Webflow site ID"),
        domains: z2.array(z2.string()).optional().describe("Custom domain URLs to publish to. Omit to publish to all.")
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        let domainList = args.domains;
        if (!domainList || domainList.length === 0) {
          const site = await webflowApi(`/sites/${encodeURIComponent(args.siteId)}`, g);
          const customDomains = site.customDomains ?? [];
          domainList = customDomains.map((d) => d.url);
        }
        const result = await webflowApi(`/sites/${encodeURIComponent(args.siteId)}/publish`, g, {
          method: "POST",
          body: {
            customDomains: domainList
          }
        });
        context.logger.info("Published site {siteId} to {domains}", {
          siteId: args.siteId,
          domains: domainList.join(", ")
        });
        return {
          data: {
            attributes: {
              siteId: args.siteId,
              publishedDomains: domainList,
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
