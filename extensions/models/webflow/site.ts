import { z } from "npm:zod@4";
import { sanitizeId, webflowApi, WebflowGlobalArgsSchema } from "./_client.ts";

const CustomDomainSchema = z.object({
  id: z.string(),
  url: z.string(),
  lastPublished: z.string().nullable(),
}).passthrough();

const LocaleSchema = z.object({
  id: z.string(),
  cmsLocaleId: z.string(),
  enabled: z.boolean(),
  displayName: z.string(),
  tag: z.string(),
}).passthrough();

const SiteSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  displayName: z.string(),
  shortName: z.string(),
  previewUrl: z.string().nullable(),
  timeZone: z.string(),
  createdOn: z.string(),
  lastUpdated: z.string(),
  lastPublished: z.string().nullable(),
  customDomains: z.array(CustomDomainSchema),
  locales: z.object({
    primary: LocaleSchema,
    secondary: z.array(LocaleSchema),
  }),
}).passthrough();

export const model = {
  type: "@dougschaefer/webflow-site",
  version: "2026.03.20.1",
  globalArguments: WebflowGlobalArgsSchema,
  resources: {
    site: {
      description: "Webflow site with domains, locale, and publishing status",
      schema: SiteSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "List all Webflow sites accessible to the authenticated token.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: any) => {
        const g = context.globalArgs;
        const result = await webflowApi("/sites", g) as { sites: Record<string, unknown>[] };
        const sites = result.sites ?? [];

        context.logger.info("Found {count} sites", { count: sites.length });

        const handles = [];
        for (const site of sites) {
          const name = sanitizeId(site.shortName as string || site.id as string);
          const handle = await context.writeResource("site", name, site);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get detailed information about a specific site.",
      arguments: z.object({
        siteId: z.string().describe("Webflow site ID"),
      }),
      execute: async (args: any, context: any) => {
        const g = context.globalArgs;
        const site = await webflowApi(`/sites/${encodeURIComponent(args.siteId)}`, g) as Record<string, unknown>;

        const name = sanitizeId(site.shortName as string || args.siteId);
        const handle = await context.writeResource("site", name, site);

        context.logger.info("Retrieved site {name}", { name: site.displayName });
        return { dataHandles: [handle] };
      },
    },

    publish: {
      description: "Publish a site to its custom domains.",
      arguments: z.object({
        siteId: z.string().describe("Webflow site ID"),
        domains: z.array(z.string()).optional().describe("Custom domain URLs to publish to. Omit to publish to all."),
      }),
      execute: async (args: any, context: any) => {
        const g = context.globalArgs;

        // If no domains specified, fetch site to get all custom domains
        let domainList = args.domains;
        if (!domainList || domainList.length === 0) {
          const site = await webflowApi(`/sites/${encodeURIComponent(args.siteId)}`, g) as Record<string, unknown>;
          const customDomains = site.customDomains as { url: string }[] ?? [];
          domainList = customDomains.map((d: { url: string }) => d.url);
        }

        const result = await webflowApi(`/sites/${encodeURIComponent(args.siteId)}/publish`, g, {
          method: "POST",
          body: { customDomains: domainList },
        });

        context.logger.info("Published site {siteId} to {domains}", {
          siteId: args.siteId,
          domains: domainList.join(", "),
        });

        return {
          data: {
            attributes: {
              siteId: args.siteId,
              publishedDomains: domainList,
              publishedAt: new Date().toISOString(),
              result,
            },
            name: "publish-result",
          },
        };
      },
    },
  },
};
