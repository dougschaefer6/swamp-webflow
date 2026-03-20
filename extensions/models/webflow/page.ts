import { z } from "npm:zod@4";
import {
  sanitizeId,
  webflowApi,
  webflowPaginated,
  WebflowGlobalArgsSchema,
} from "./_client.ts";

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

export const model = {
  type: "@dougschaefer/webflow-page",
  version: "2026.03.20.1",
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
      execute: async (args: any, context: any) => {
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
      execute: async (args: any, context: any) => {
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
      description: "Update page settings including SEO metadata and Open Graph.",
      arguments: z.object({
        pageId: z.string().describe("Webflow page ID"),
        title: z.string().optional().describe("Page title"),
        slug: z.string().optional().describe("URL slug"),
        seoTitle: z.string().optional().describe("SEO title tag"),
        seoDescription: z.string().optional().describe("SEO meta description"),
        ogTitle: z.string().optional().describe("Open Graph title"),
        ogDescription: z.string().optional().describe("Open Graph description"),
      }),
      execute: async (args: any, context: any) => {
        const g = context.globalArgs;

        const body: Record<string, unknown> = {};
        if (args.title !== undefined) body.title = args.title;
        if (args.slug !== undefined) body.slug = args.slug;

        const seo: Record<string, unknown> = {};
        if (args.seoTitle !== undefined) seo.title = args.seoTitle;
        if (args.seoDescription !== undefined) seo.description = args.seoDescription;
        if (Object.keys(seo).length > 0) body.seo = seo;

        const og: Record<string, unknown> = {};
        if (args.ogTitle !== undefined) og.title = args.ogTitle;
        if (args.ogDescription !== undefined) og.description = args.ogDescription;
        if (Object.keys(og).length > 0) body.openGraph = og;

        const page = await webflowApi(
          `/pages/${encodeURIComponent(args.pageId)}`,
          g,
          { method: "PUT", body },
        ) as Record<string, unknown>;

        const name = sanitizeId(page.slug as string || args.pageId);
        const handle = await context.writeResource("page", name, page);

        context.logger.info("Updated page settings for {name}", { name: page.title });
        return { dataHandles: [handle] };
      },
    },

    getContent: {
      description: "Get the static content (DOM nodes) for a page.",
      arguments: z.object({
        pageId: z.string().describe("Webflow page ID"),
      }),
      execute: async (args: any, context: any) => {
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
};
