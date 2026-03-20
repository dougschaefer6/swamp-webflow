import { z } from "npm:zod@4";
import {
  sanitizeId,
  webflowApi,
  webflowPaginated,
  WebflowGlobalArgsSchema,
} from "./_client.ts";

const CmsItemSchema = z.object({
  id: z.string(),
  cmsLocaleId: z.string().optional(),
  lastPublished: z.string().nullable(),
  lastUpdated: z.string(),
  createdOn: z.string(),
  isArchived: z.boolean(),
  isDraft: z.boolean(),
  fieldData: z.record(z.string(), z.unknown()),
}).passthrough();

export const model = {
  type: "@dougschaefer/webflow-cms-item",
  version: "2026.03.20.1",
  globalArguments: WebflowGlobalArgsSchema,
  resources: {
    item: {
      description: "Webflow CMS collection item with field data",
      schema: CmsItemSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    list: {
      description: "List all items in a CMS collection.",
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
      }),
      execute: async (args: any, context: any) => {
        const g = context.globalArgs;
        const items = await webflowPaginated(
          `/collections/${encodeURIComponent(args.collectionId)}/items`,
          g,
          "items",
        ) as Record<string, unknown>[];

        context.logger.info("Found {count} items in collection {collectionId}", {
          count: items.length,
          collectionId: args.collectionId,
        });

        const handles = [];
        for (const item of items) {
          const fieldData = item.fieldData as Record<string, unknown> ?? {};
          const slug = fieldData.slug as string ?? item.id as string;
          const name = sanitizeId(slug);
          const handle = await context.writeResource("item", name, item);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a specific CMS item by ID.",
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        itemId: z.string().describe("Webflow item ID"),
      }),
      execute: async (args: any, context: any) => {
        const g = context.globalArgs;
        const item = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/${encodeURIComponent(args.itemId)}`,
          g,
        ) as Record<string, unknown>;

        const fieldData = item.fieldData as Record<string, unknown> ?? {};
        const slug = fieldData.slug as string ?? args.itemId;
        const name = sanitizeId(slug);
        const handle = await context.writeResource("item", name, item);

        context.logger.info("Retrieved item {name}", { name: slug });
        return { dataHandles: [handle] };
      },
    },

    create: {
      description: "Create a new CMS item in a collection.",
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        fieldData: z.record(z.string(), z.unknown()).describe("Field data for the new item"),
        isDraft: z.boolean().optional().default(false).describe("Create as draft"),
      }),
      execute: async (args: any, context: any) => {
        const g = context.globalArgs;
        const item = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items`,
          g,
          {
            method: "POST",
            body: {
              fieldData: args.fieldData,
              isDraft: args.isDraft,
            },
          },
        ) as Record<string, unknown>;

        const fieldData = item.fieldData as Record<string, unknown> ?? {};
        const slug = fieldData.slug as string ?? item.id as string;
        const name = sanitizeId(slug);
        const handle = await context.writeResource("item", name, item);

        context.logger.info("Created item {name} in collection {collectionId}", {
          name: slug,
          collectionId: args.collectionId,
        });
        return { dataHandles: [handle] };
      },
    },

    update: {
      description: "Update an existing CMS item's field data.",
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        itemId: z.string().describe("Webflow item ID"),
        fieldData: z.record(z.string(), z.unknown()).describe("Fields to update (partial)"),
      }),
      execute: async (args: any, context: any) => {
        const g = context.globalArgs;
        const item = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/${encodeURIComponent(args.itemId)}`,
          g,
          {
            method: "PATCH",
            body: { fieldData: args.fieldData },
          },
        ) as Record<string, unknown>;

        const fieldData = item.fieldData as Record<string, unknown> ?? {};
        const slug = fieldData.slug as string ?? args.itemId;
        const name = sanitizeId(slug);
        const handle = await context.writeResource("item", name, item);

        context.logger.info("Updated item {name}", { name: slug });
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a CMS item. Verify the item ID before calling.",
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        itemId: z.string().describe("Webflow item ID"),
      }),
      execute: async (args: any, context: any) => {
        const g = context.globalArgs;
        await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/${encodeURIComponent(args.itemId)}`,
          g,
          { method: "DELETE" },
        );

        context.logger.info("Deleted item {itemId} from collection {collectionId}", {
          itemId: args.itemId,
          collectionId: args.collectionId,
        });

        return {
          data: {
            attributes: {
              collectionId: args.collectionId,
              itemId: args.itemId,
              deletedAt: new Date().toISOString(),
            },
            name: "delete-result",
          },
        };
      },
    },

    publish: {
      description: "Publish one or more CMS items to make them live.",
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        itemIds: z.array(z.string()).describe("Array of item IDs to publish"),
      }),
      execute: async (args: any, context: any) => {
        const g = context.globalArgs;
        const result = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/publish`,
          g,
          {
            method: "POST",
            body: { itemIds: args.itemIds },
          },
        );

        context.logger.info("Published {count} items in collection {collectionId}", {
          count: args.itemIds.length,
          collectionId: args.collectionId,
        });

        return {
          data: {
            attributes: {
              collectionId: args.collectionId,
              publishedIds: args.itemIds,
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
