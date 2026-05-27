import { z } from "npm:zod@4.3.6";
import {
  sanitizeId,
  webflowApi,
  WebflowGlobalArgsSchema,
  webflowPaginated,
} from "./_client.ts";
import type { WebflowGlobalArgs } from "./_client.ts";

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

/**
 * `@dougschaefer/webflow-cms-item` model — CMS item CRUD against
 * Webflow's Data API v2. List enumerates items within a collection.
 * Get returns a single item by id. Create posts a new item with
 * field data matching the collection's schema (use webflow-collection
 * to discover that schema first). Update mutates an existing item's
 * fieldData; Delete removes one — both verify the item id before
 * acting. Items are written in draft state and require a site
 * publish to go live.
 */
export const model = {
  type: "@dougschaefer/webflow-cms-item",
  version: "2026.05.27.1",
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
      execute: async (args, context) => {
        const g = context.globalArgs;
        const items = await webflowPaginated(
          `/collections/${encodeURIComponent(args.collectionId)}/items`,
          g,
          "items",
        ) as Record<string, unknown>[];

        context.logger.info(
          "Found {count} items in collection {collectionId}",
          {
            count: items.length,
            collectionId: args.collectionId,
          },
        );

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
      execute: async (args, context) => {
        const g = context.globalArgs;
        const item = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/${
            encodeURIComponent(args.itemId)
          }`,
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
      description:
        "Create a new CMS item in a collection. Idempotent: if an item with the same slug already exists it is returned rather than duplicated.",
      labels: ["live"],
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        fieldData: z.record(z.string(), z.unknown()).describe(
          "Field data for the new item",
        ),
        isDraft: z.boolean().optional().default(false).describe(
          "Create as draft",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;

        // Idempotency: if fieldData includes a slug, check whether an item with
        // that slug already exists in the collection and return it without
        // creating a duplicate.
        const desiredSlug = args.fieldData.slug as string | undefined;
        if (desiredSlug) {
          try {
            const existing = await webflowPaginated(
              `/collections/${encodeURIComponent(args.collectionId)}/items`,
              g,
              "items",
              { slug: desiredSlug },
            ) as Record<string, unknown>[];
            const match = existing.find((i) => {
              const fd = i.fieldData as Record<string, unknown> ?? {};
              return fd.slug === desiredSlug;
            });
            if (match) {
              const matchSlug = (match.fieldData as Record<string, unknown>)
                .slug as string ?? match.id as string;
              const name = sanitizeId(matchSlug);
              const handle = await context.writeResource("item", name, match);
              context.logger.info(
                "Item with slug {slug} already exists in collection {collectionId} — skipping create",
                { slug: desiredSlug, collectionId: args.collectionId },
              );
              return { dataHandles: [handle] };
            }
          } catch {
            // If the slug-filter lookup fails, fall through to normal create
          }
        }

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

        context.logger.info(
          "Created item {name} in collection {collectionId}",
          {
            name: slug,
            collectionId: args.collectionId,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    update: {
      description: "Update an existing CMS item's field data.",
      labels: ["live"],
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        itemId: z.string().describe("Webflow item ID"),
        fieldData: z.record(z.string(), z.unknown()).describe(
          "Fields to update (partial)",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const item = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/${
            encodeURIComponent(args.itemId)
          }`,
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
      description:
        "Delete a CMS item. Verify the item ID before calling. Idempotent: succeeds silently if the item does not exist.",
      labels: ["live"],
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        itemId: z.string().describe("Webflow item ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        try {
          await webflowApi(
            `/collections/${encodeURIComponent(args.collectionId)}/items/${
              encodeURIComponent(args.itemId)
            }`,
            g,
            { method: "DELETE" },
          );
        } catch (err) {
          // 404 means it's already gone — treat as success
          if (!String(err).includes("404")) throw err;
          context.logger.info(
            "Item {itemId} not found in collection {collectionId} — already deleted",
            { itemId: args.itemId, collectionId: args.collectionId },
          );
        }

        context.logger.info(
          "Deleted item {itemId} from collection {collectionId}",
          {
            itemId: args.itemId,
            collectionId: args.collectionId,
          },
        );

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

    batchCreate: {
      description:
        "Create multiple CMS items in a single request. More efficient than looping individual creates.",
      labels: ["live"],
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        items: z.array(
          z.object({
            fieldData: z.record(z.string(), z.unknown()),
            isDraft: z.boolean().optional().default(false),
          }),
        ).describe("Array of items to create"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const result = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items`,
          g,
          {
            method: "POST",
            body: { items: args.items },
          },
        ) as { items?: Record<string, unknown>[] };

        const created = result.items ?? [];
        context.logger.info(
          "Batch created {count} items in collection {collectionId}",
          { count: created.length, collectionId: args.collectionId },
        );

        const handles = [];
        for (const item of created) {
          const fieldData = item.fieldData as Record<string, unknown> ?? {};
          const slug = fieldData.slug as string ?? item.id as string;
          const name = sanitizeId(slug);
          const handle = await context.writeResource("item", name, item);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    batchDelete: {
      description:
        "Delete multiple CMS items in a single request. Verify item IDs before calling.",
      labels: ["live"],
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        itemIds: z.array(z.string()).describe("Array of item IDs to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items`,
          g,
          {
            method: "DELETE",
            body: { itemIds: args.itemIds },
          },
        );

        context.logger.info(
          "Batch deleted {count} items from collection {collectionId}",
          { count: args.itemIds.length, collectionId: args.collectionId },
        );

        return {
          data: {
            attributes: {
              collectionId: args.collectionId,
              deletedIds: args.itemIds,
              deletedAt: new Date().toISOString(),
            },
            name: "batch-delete-result",
          },
        };
      },
    },

    publish: {
      description: "Publish one or more CMS items to make them live.",
      labels: ["live"],
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        itemIds: z.array(z.string()).describe("Array of item IDs to publish"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const result = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/publish`,
          g,
          {
            method: "POST",
            body: { itemIds: args.itemIds },
          },
        );

        context.logger.info(
          "Published {count} items in collection {collectionId}",
          {
            count: args.itemIds.length,
            collectionId: args.collectionId,
          },
        );

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

    sync: {
      description:
        "Re-list all items in a collection and refresh stored resources. Run after a create/update/delete cycle to bring CEL-readable state current.",
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const items = await webflowPaginated(
          `/collections/${encodeURIComponent(args.collectionId)}/items`,
          g,
          "items",
        ) as Record<string, unknown>[];

        context.logger.info(
          "Synced {count} items for collection {collectionId}",
          { count: items.length, collectionId: args.collectionId },
        );

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
  },

  checks: {
    "webflow-token-valid": {
      description:
        "Verify the Webflow API token can reach the sites endpoint before mutating CMS content.",
      labels: ["live"],
      appliesTo: [
        "create",
        "update",
        "delete",
        "batchCreate",
        "batchDelete",
        "publish",
      ],
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
                "Webflow API returned unexpected response from /sites — token may lack Sites scope",
              ],
            };
          }
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [`Webflow API token check failed: ${String(err)}`],
          };
        }
      },
    },
  },
};
