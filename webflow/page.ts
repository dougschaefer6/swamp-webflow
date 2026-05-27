import { z } from "npm:zod@4.3.6";
import {
  sanitizeId,
  webflowApi,
  WebflowGlobalArgsSchema,
  webflowPaginated,
} from "./_client.ts";
import type { WebflowGlobalArgs } from "./_client.ts";

const SeoSchema = z.object({
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
}).passthrough();

const OpenGraphSchema = z.object({
  title: z.string().nullable().optional(),
  titleCopied: z.boolean().optional(),
  description: z.string().nullable().optional(),
  descriptionCopied: z.boolean().optional(),
}).passthrough();

const PageSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  title: z.string(),
  slug: z.string(),
  parentId: z.string().nullable(),
  collectionId: z.string().nullable(),
  createdOn: z.string(),
  lastUpdated: z.string(),
  archived: z.boolean(),
  draft: z.boolean(),
  seo: SeoSchema.optional(),
  openGraph: OpenGraphSchema.optional(),
}).passthrough();

/**
 * `@dougschaefer/webflow-page` model — Webflow page-level operations
 * via the Data API v2. List enumerates pages within a site with SEO
 * and OpenGraph metadata. Get returns a single page with full
 * settings. updateSettings mutates title/description/slug/SEO/OG
 * fields without touching DOM content — safe for bulk SEO sweeps.
 * getContent reads the static DOM node tree for a page so workflows
 * can inspect what's actually rendered against the design system.
 * Paired with the seo-audit and seo-site-health reports.
 */
export const model = {
  type: "@dougschaefer/webflow-page",
  version: "2026.05.27.1",
  reports: ["@dougschaefer/seo-audit", "@dougschaefer/seo-site-health"],
  globalArguments: WebflowGlobalArgsSchema,
  resources: {
    page: {
      description: "Webflow page with SEO metadata and publishing status",
      schema: PageSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    list: {
      description: "List all pages for a site.",
      arguments: z.object({
        siteId: z.string().describe("Webflow site ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const pages = await webflowPaginated(
          `/sites/${encodeURIComponent(args.siteId)}/pages`,
          g,
          "pages",
        ) as Record<string, unknown>[];

        context.logger.info("Found {count} pages for site {siteId}", {
          count: pages.length,
          siteId: args.siteId,
        });

        const handles = [];
        for (const page of pages) {
          const name = sanitizeId(page.slug as string || page.id as string);
          const handle = await context.writeResource("page", name, page);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a specific page with its metadata.",
      arguments: z.object({
        pageId: z.string().describe("Webflow page ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const page = await webflowApi(
          `/pages/${encodeURIComponent(args.pageId)}`,
          g,
        ) as Record<string, unknown>;

        const name = sanitizeId(page.slug as string || args.pageId);
        const handle = await context.writeResource("page", name, page);

        context.logger.info("Retrieved page {name}", { name: page.title });
        return { dataHandles: [handle] };
      },
    },

    updateSettings: {
      description:
        "Update page settings including SEO metadata and Open Graph.",
      labels: ["live"],
      arguments: z.object({
        pageId: z.string().describe("Webflow page ID"),
        title: z.string().optional().describe("Page title"),
        slug: z.string().optional().describe("URL slug"),
        seoTitle: z.string().optional().describe("SEO title tag"),
        seoDescription: z.string().optional().describe("SEO meta description"),
        ogTitle: z.string().optional().describe("Open Graph title"),
        ogDescription: z.string().optional().describe("Open Graph description"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;

        const body: Record<string, unknown> = {};
        if (args.title !== undefined) body.title = args.title;
        if (args.slug !== undefined) body.slug = args.slug;

        const seo: Record<string, unknown> = {};
        if (args.seoTitle !== undefined) seo.title = args.seoTitle;
        if (args.seoDescription !== undefined) {
          seo.description = args.seoDescription;
        }
        if (Object.keys(seo).length > 0) body.seo = seo;

        const og: Record<string, unknown> = {};
        if (args.ogTitle !== undefined) og.title = args.ogTitle;
        if (args.ogDescription !== undefined) {
          og.description = args.ogDescription;
        }
        if (Object.keys(og).length > 0) body.openGraph = og;

        const page = await webflowApi(
          `/pages/${encodeURIComponent(args.pageId)}`,
          g,
          { method: "PUT", body },
        ) as Record<string, unknown>;

        const name = sanitizeId(page.slug as string || args.pageId);
        const handle = await context.writeResource("page", name, page);

        context.logger.info("Updated page settings for {name}", {
          name: page.title,
        });
        return { dataHandles: [handle] };
      },
    },

    getContent: {
      description: "Get the static content (DOM nodes) for a page.",
      arguments: z.object({
        pageId: z.string().describe("Webflow page ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const content = await webflowApi(
          `/pages/${encodeURIComponent(args.pageId)}/dom`,
          g,
        );

        context.logger.info("Retrieved DOM content for page {pageId}", {
          pageId: args.pageId,
        });

        return {
          data: {
            attributes: { pageId: args.pageId, content },
            name: `page-content-${sanitizeId(args.pageId)}`,
          },
        };
      },
    },
  },

  checks: {
    "webflow-page-token-valid": {
      description:
        "Verify the Webflow API token can reach the pages API before updating page settings.",
      labels: ["live"],
      appliesTo: ["updateSettings"],
      execute: async (context) => {
        try {
          const g = context.globalArgs as WebflowGlobalArgs;
          const result = await webflowApi("/sites", g) as {
            sites?: unknown[];
          };
          if (!Array.isArray(result.sites)) {
            return {
              pass: false,
              errors: [
                "Webflow API returned unexpected response from /sites — token may lack required scope",
              ],
            };
          }
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [`Webflow API check failed: ${String(err)}`],
          };
        }
      },
    },
  },
};
