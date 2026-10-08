import { z } from "npm:zod@4.3.6";
import {
  defineMethods,
  sanitizeId,
  webflowApi,
  WebflowGlobalArgsSchema,
} from "./_client.ts";
import type { CheckContext, WebflowGlobalArgs } from "./_client.ts";

const CustomDomainSchema = z.object({
  id: z.string(),
  url: z.string(),
  lastPublished: z.string().nullable(),
}).passthrough();

const PublishResultSchema = z.object({
  siteId: z.string(),
  domainIds: z.array(z.string()),
  publishToWebflowSubdomain: z.boolean(),
  publishedAt: z.string(),
  response: z.unknown(),
}).strict();

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

/**
 * `@dougschaefer/webflow-site` model — Webflow Data API v2 site
 * management. List enumerates accessible sites with locale, custom
 * domain, and publication metadata. Get returns a single site's
 * full configuration. Publish promotes the staging site to one or
 * more custom domains — the only mutation surface here, deliberately
 * narrow because Webflow's editor handles authoring and this API
 * targets deployment orchestration.
 */
export const model = {
  type: "@dougschaefer/webflow-site",
  version: "2026.10.08.1",
  upgrades: [
    {
      toVersion: "2026.10.07.1",
      description:
        "Version aligned with the webflow-cms-item live/bulk method release; globalArguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.08.1",
      description:
        "Version aligned with the webflow-page JSON-LD, custom code and DOM write release; globalArguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: WebflowGlobalArgsSchema,
  resources: {
    site: {
      description: "Webflow site with domains, locale, and publishing status",
      schema: SiteSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    publishResult: {
      description:
        "Outcome of a site publish: target domain IDs, subdomain flag and Webflow's 202 response",
      schema: PublishResultSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
  },
  methods: defineMethods({
    list: {
      description:
        "List all Webflow sites accessible to the authenticated token.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const result = await webflowApi("/sites", g) as {
          sites: Record<string, unknown>[];
        };
        const sites = result.sites ?? [];

        context.logger.info("Found {count} sites", { count: sites.length });

        const handles = [];
        for (const site of sites) {
          const name = sanitizeId(
            site.shortName as string || site.id as string,
          );
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
      execute: async (args, context) => {
        const g = context.globalArgs;
        const site = await webflowApi(
          `/sites/${encodeURIComponent(args.siteId)}`,
          g,
        ) as Record<string, unknown>;

        const name = sanitizeId(site.shortName as string || args.siteId);
        const handle = await context.writeResource("site", name, site);

        context.logger.info("Retrieved site {name}", {
          name: site.displayName,
        });
        return { dataHandles: [handle] };
      },
    },

    publish: {
      description:
        "Publish a site to custom domains (by domain ID) and/or its webflow.io subdomain. Omitting domainIds publishes to every custom domain on the site; an empty domainIds list publishes to no custom domain, so pair it with publishToWebflowSubdomain for a staging-only publish.",
      labels: ["live"],
      arguments: z.object({
        siteId: z.string().describe("Webflow site ID"),
        domainIds: z.array(z.string().min(1)).optional().describe(
          "Custom domain IDs to publish to (from the site's customDomains). Omit to publish to all custom domains; [] publishes to none.",
        ),
        publishToWebflowSubdomain: z.boolean().optional().default(false)
          .describe("Also publish to the site's webflow.io subdomain"),
      }).strict(),
      execute: async (args, context) => {
        const g = context.globalArgs;

        // Webflow takes custom domain IDs, not URLs. Only an omitted
        // domainIds means "every custom domain"; an empty list must never
        // widen to production.
        let domainIds = args.domainIds;
        if (domainIds === undefined) {
          const site = await webflowApi(
            `/sites/${encodeURIComponent(args.siteId)}`,
            g,
          ) as Record<string, unknown>;
          const customDomains = (site.customDomains ?? []) as {
            id?: unknown;
          }[];
          domainIds = customDomains
            .map((d) => d.id)
            .filter((id): id is string => typeof id === "string" && id !== "");
        }

        if (domainIds.length === 0 && !args.publishToWebflowSubdomain) {
          throw new Error(
            `Nothing to publish for site ${args.siteId}: no custom domains selected and publishToWebflowSubdomain is false`,
          );
        }

        const body: Record<string, unknown> = {
          publishToWebflowSubdomain: args.publishToWebflowSubdomain,
        };
        if (domainIds.length > 0) body.customDomains = domainIds;

        context.logger.info(
          "Publishing site {siteId} to domains [{domains}] (webflow.io subdomain: {subdomain})",
          {
            siteId: args.siteId,
            domains: domainIds.join(", "),
            subdomain: args.publishToWebflowSubdomain,
          },
        );
        const response = await webflowApi(
          `/sites/${encodeURIComponent(args.siteId)}/publish`,
          g,
          { method: "POST", body },
        );

        const handle = await context.writeResource(
          "publishResult",
          `publish-${sanitizeId(args.siteId)}`,
          {
            siteId: args.siteId,
            domainIds,
            publishToWebflowSubdomain: args.publishToWebflowSubdomain,
            publishedAt: new Date().toISOString(),
            response: response ?? null,
          },
        );
        context.logger.info("Publish of site {siteId} accepted", {
          siteId: args.siteId,
        });
        return { dataHandles: [handle] };
      },
    },
  }),

  checks: {
    "webflow-site-publish-preflight": {
      description:
        "Verify the Webflow API token can reach the target site before triggering a full-site publish.",
      labels: ["live"],
      appliesTo: ["publish"],
      execute: async (context: CheckContext) => {
        try {
          const g = context.globalArgs as WebflowGlobalArgs;
          const result = await webflowApi("/sites", g) as {
            sites?: unknown[];
          };
          if (!Array.isArray(result.sites) || result.sites.length === 0) {
            return {
              pass: false,
              errors: [
                "Webflow token returned no accessible sites — verify token scope includes Sites:read and Publishing:write",
              ],
            };
          }
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [
              `Webflow pre-publish check failed: ${String(err)}`,
            ],
          };
        }
      },
    },
  },
};
