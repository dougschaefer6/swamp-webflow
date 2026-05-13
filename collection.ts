import { z } from "npm:zod@4.3.6";
import {
  sanitizeId,
  webflowApi,
  WebflowGlobalArgsSchema,
  webflowPaginated,
} from "./_client.ts";

const FieldSchema = z.object({
  id: z.string(),
  isEditable: z.boolean(),
  isRequired: z.boolean(),
  type: z.string(),
  slug: z.string(),
  displayName: z.string(),
}).passthrough();

const CollectionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  singularName: z.string(),
  slug: z.string(),
  createdOn: z.string(),
  lastUpdated: z.string(),
  fields: z.array(FieldSchema),
}).passthrough();

/**
 * `@dougschaefer/webflow-collection` model — discovers and inspects
 * Webflow CMS collection schemas. List enumerates collections within
 * a site. Get returns a collection's full field schema including
 * field types, reference relations, validation, and required flags
 * — the entry point for any workflow that needs to know what
 * fieldData shape webflow-cms-item.create or .update expects.
 */
export const model = {
  type: "@dougschaefer/webflow-collection",
  version: "2026.03.20.1",
  globalArguments: WebflowGlobalArgsSchema,
  resources: {
    collection: {
      description: "Webflow CMS collection with field definitions",
      schema: CollectionSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "List all CMS collections for a site.",
      arguments: z.object({
        siteId: z.string().describe("Webflow site ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const collections = await webflowPaginated(
          `/sites/${encodeURIComponent(args.siteId)}/collections`,
          g,
          "collections",
        ) as Record<string, unknown>[];

        context.logger.info("Found {count} collections for site {siteId}", {
          count: collections.length,
          siteId: args.siteId,
        });

        const handles = [];
        for (const coll of collections) {
          const name = sanitizeId(coll.slug as string || coll.id as string);
          const handle = await context.writeResource("collection", name, coll);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a specific collection with its field schema.",
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const coll = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}`,
          g,
        ) as Record<string, unknown>;

        const name = sanitizeId(coll.slug as string || args.collectionId);
        const handle = await context.writeResource("collection", name, coll);

        context.logger.info("Retrieved collection {name}", {
          name: coll.displayName,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
