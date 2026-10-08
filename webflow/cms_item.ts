import { z } from "npm:zod@4.3.6";
import {
  defineMethods,
  isWebflowStatus,
  sanitizeId,
  webflowApi,
  WebflowGlobalArgsSchema,
  webflowPaginated,
} from "./_client.ts";
import type {
  CheckContext,
  MethodContext,
  WebflowGlobalArgs,
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

/**
 * Live (published) item. `isDraft` and `isArchived` are not required in the
 * `/items/live` responses, so they are optional here: a validation failure
 * must never surface after the item has already gone public.
 */
const LiveCmsItemSchema = CmsItemSchema.extend({
  isArchived: z.boolean().optional(),
  isDraft: z.boolean().optional(),
}).passthrough();

const DeleteResultSchema = z.object({
  collectionId: z.string(),
  itemIds: z.array(z.string()),
  notFoundIds: z.array(z.string()),
  deletedAt: z.string(),
});

const PublishResultSchema = z.object({
  collectionId: z.string(),
  requestedIds: z.array(z.string()),
  publishedItemIds: z.array(z.string()),
  errors: z.array(z.unknown()),
  publishedAt: z.string(),
});

const UnpublishResultSchema = z.object({
  collectionId: z.string(),
  unpublishedIds: z.array(z.string()),
  unpublishedAt: z.string(),
});

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Instance name for a stored item: its slug, falling back to the item id,
 * then to `fallback`. When the item carries `cmsLocaleIds` (as `/items/bulk`
 * responses do) the locale ids are appended so the same slug created in
 * different locales never overwrites another locale's record.
 */
export function itemInstanceName(
  item: Record<string, unknown>,
  fallback?: string,
): string {
  const fieldData = item.fieldData as Record<string, unknown> ?? {};
  const base = nonEmptyString(fieldData.slug) ?? nonEmptyString(item.id) ??
    nonEmptyString(fallback);
  if (!base) {
    throw new Error(
      "Webflow item has no slug or id to name its stored resource",
    );
  }
  const locales = Array.isArray(item.cmsLocaleIds)
    ? item.cmsLocaleIds.filter((l): l is string =>
      nonEmptyString(l) !== undefined
    )
    : [];
  const suffix = locales.length > 0 ? `-${locales.join("-")}` : "";
  return sanitizeId(base + suffix);
}

/**
 * Normalise a write response that is either a single item or `{ items }`
 * (the documented shapes of `PATCH /items` and `POST /items/bulk`).
 */
function itemsFromResponse(
  result: Record<string, unknown>,
): Record<string, unknown>[] {
  if (Array.isArray(result.items)) {
    return result.items as Record<string, unknown>[];
  }
  return result.id ? [result] : [];
}

/**
 * Find existing staged items by slug, keyed by slug. One slug uses the
 * `slug` query filter; several list the collection once and match locally.
 * A failed lookup is logged and treated as "none found", so the caller
 * falls through to its normal create, as `create` always has.
 */
async function findItemsBySlug(
  collectionId: string,
  slugs: string[],
  context: MethodContext,
): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  if (slugs.length === 0) return found;
  const wanted = new Set(slugs);
  try {
    const items = await webflowPaginated(
      `/collections/${encodeURIComponent(collectionId)}/items`,
      context.globalArgs,
      "items",
      slugs.length === 1 ? { slug: slugs[0] } : undefined,
    ) as Record<string, unknown>[];
    for (const i of items) {
      const slug = (i.fieldData as Record<string, unknown> ?? {}).slug;
      if (typeof slug === "string" && wanted.has(slug) && !found.has(slug)) {
        found.set(slug, i);
      }
    }
  } catch (err) {
    context.logger.info(
      "Slug lookup in collection {collectionId} failed, continuing without the duplicate guard: {error}",
      { collectionId, error: String(err) },
    );
  }
  return found;
}

/**
 * `@dougschaefer/webflow-cms-item` model — CMS item CRUD against
 * Webflow's Data API v2. List enumerates items within a collection.
 * Get returns a single item by id. Create posts a new item with
 * field data matching the collection's schema (use webflow-collection
 * to discover that schema first). Update mutates an existing item's
 * fieldData; Delete removes one — both verify the item id before
 * acting. Items are written in draft state and require a site
 * publish to go live.
 *
 * The *Live methods target the published copy of an item through the
 * /items/live endpoints and store results as the separate `liveItem`
 * resource, so staged and live state never overwrite each other.
 * Unpublish removes the live copy but keeps the staged item.
 * bulkUpdate and bulkCreate operate on arrays of items in one request.
 */
export const model = {
  type: "@dougschaefer/webflow-cms-item",
  version: "2026.10.08.1",
  globalArguments: WebflowGlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.07.1",
      description:
        "Added live-item methods (listLive, getLive, createLive, updateLive, unpublish), bulkUpdate, bulkCreate, the liveItem resource and the deleteResult/publishResult/unpublishResult records; globalArguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.08.1",
      description:
        "Version aligned with the webflow-page JSON-LD, custom code and DOM write release; globalArguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    item: {
      description: "Webflow CMS collection item with field data",
      schema: CmsItemSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    liveItem: {
      description:
        "Published (live) copy of a Webflow CMS collection item with field data",
      schema: LiveCmsItemSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    deleteResult: {
      description:
        "Record of a delete or batchDelete: the item ids removed and any already gone",
      schema: DeleteResultSchema,
      lifetime: "90d",
      garbageCollection: 20,
    },
    publishResult: {
      description:
        "Record of an item publish: requested ids and Webflow's published ids and errors",
      schema: PublishResultSchema,
      lifetime: "90d",
      garbageCollection: 20,
    },
    unpublishResult: {
      description:
        "Record of an unpublish: the item ids taken off the live site (primary locale)",
      schema: UnpublishResultSchema,
      lifetime: "90d",
      garbageCollection: 20,
    },
  },
  methods: defineMethods({
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
        const desiredSlug = nonEmptyString(args.fieldData.slug);
        if (desiredSlug) {
          const match = (await findItemsBySlug(
            args.collectionId,
            [desiredSlug],
            context,
          )).get(desiredSlug);
          if (match) {
            const handle = await context.writeResource(
              "item",
              itemInstanceName(match),
              match,
            );
            context.logger.info(
              "Item with slug {slug} already exists in collection {collectionId} — skipping create",
              { slug: desiredSlug, collectionId: args.collectionId },
            );
            return { dataHandles: [handle] };
          }
        }

        context.logger.info(
          "Creating item with slug {slug} in collection {collectionId}",
          { slug: desiredSlug ?? "(none)", collectionId: args.collectionId },
        );
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
        context.logger.info(
          "Updating item {itemId} in collection {collectionId}",
          { itemId: args.itemId, collectionId: args.collectionId },
        );
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
        context.logger.info(
          "Deleting item {itemId} from collection {collectionId}",
          { itemId: args.itemId, collectionId: args.collectionId },
        );
        let notFound = false;
        try {
          await webflowApi(
            `/collections/${encodeURIComponent(args.collectionId)}/items/${
              encodeURIComponent(args.itemId)
            }`,
            g,
            { method: "DELETE" },
          );
        } catch (err) {
          // An HTTP 404 means it's already gone — treat as success
          if (!isWebflowStatus(err, 404)) throw err;
          notFound = true;
          context.logger.info(
            "Item {itemId} not found in collection {collectionId} — already deleted",
            { itemId: args.itemId, collectionId: args.collectionId },
          );
        }

        if (!notFound) {
          context.logger.info(
            "Deleted item {itemId} from collection {collectionId}",
            { itemId: args.itemId, collectionId: args.collectionId },
          );
        }

        const handle = await context.writeResource(
          "deleteResult",
          `delete-${sanitizeId(args.itemId)}`,
          {
            collectionId: args.collectionId,
            itemIds: [args.itemId],
            notFoundIds: notFound ? [args.itemId] : [],
            deletedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
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
        ).min(1).max(100).describe("Array of items to create (max 100)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        context.logger.info(
          "Batch creating {count} items in collection {collectionId}",
          { count: args.items.length, collectionId: args.collectionId },
        );
        const result = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items`,
          g,
          {
            method: "POST",
            body: { items: args.items },
          },
        ) as Record<string, unknown>;

        const created = itemsFromResponse(result);
        context.logger.info(
          "Batch created {count} items in collection {collectionId}",
          { count: created.length, collectionId: args.collectionId },
        );

        const handles = [];
        for (const item of created) {
          const handle = await context.writeResource(
            "item",
            itemInstanceName(item),
            item,
          );
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
        itemIds: z.array(z.string()).min(1).max(100).describe(
          "Array of item IDs to delete (max 100)",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        context.logger.info(
          "Batch deleting items {itemIds} from collection {collectionId}",
          { itemIds: args.itemIds.join(", "), collectionId: args.collectionId },
        );
        // DELETE /collections/{id}/items takes { items: [{ id, cmsLocaleIds? }] };
        // without cmsLocaleIds only the primary locale is deleted.
        await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items`,
          g,
          {
            method: "DELETE",
            body: { items: args.itemIds.map((id) => ({ id })) },
          },
        );

        context.logger.info(
          "Batch deleted {count} items from collection {collectionId}",
          { count: args.itemIds.length, collectionId: args.collectionId },
        );

        const handle = await context.writeResource(
          "deleteResult",
          `batch-delete-${sanitizeId(args.collectionId)}`,
          {
            collectionId: args.collectionId,
            itemIds: args.itemIds,
            notFoundIds: [],
            deletedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    publish: {
      description: "Publish one or more CMS items to make them live.",
      labels: ["live"],
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        itemIds: z.array(z.string()).min(1).describe(
          "Array of item IDs to publish",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        context.logger.info(
          "Publishing items {itemIds} in collection {collectionId}",
          { itemIds: args.itemIds.join(", "), collectionId: args.collectionId },
        );
        const result = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/publish`,
          g,
          {
            method: "POST",
            body: { itemIds: args.itemIds },
          },
        ) as Record<string, unknown>;

        context.logger.info(
          "Published {count} items in collection {collectionId}",
          {
            count: args.itemIds.length,
            collectionId: args.collectionId,
          },
        );

        const handle = await context.writeResource(
          "publishResult",
          `publish-${sanitizeId(args.collectionId)}`,
          {
            collectionId: args.collectionId,
            requestedIds: args.itemIds,
            publishedItemIds: Array.isArray(result.publishedItemIds)
              ? result.publishedItemIds as string[]
              : [],
            errors: Array.isArray(result.errors) ? result.errors : [],
            publishedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    listLive: {
      description: "List all published (live) items in a CMS collection.",
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const items = await webflowPaginated(
          `/collections/${encodeURIComponent(args.collectionId)}/items/live`,
          g,
          "items",
        ) as Record<string, unknown>[];

        context.logger.info(
          "Found {count} live items in collection {collectionId}",
          { count: items.length, collectionId: args.collectionId },
        );

        const handles = [];
        for (const item of items) {
          const handle = await context.writeResource(
            "liveItem",
            itemInstanceName(item),
            item,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getLive: {
      description: "Get the published (live) copy of a CMS item by ID.",
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        itemId: z.string().describe("Webflow item ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const item = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/${
            encodeURIComponent(args.itemId)
          }/live`,
          g,
        ) as Record<string, unknown>;

        const name = itemInstanceName(item, args.itemId);
        const handle = await context.writeResource("liveItem", name, item);

        context.logger.info("Retrieved live item {name}", { name });
        return { dataHandles: [handle] };
      },
    },

    createLive: {
      description:
        "Create a CMS item and publish it immediately, without a separate publish step.",
      labels: ["live"],
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        fieldData: z.record(z.string(), z.unknown()).describe(
          "Field data for the new item",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;

        // Duplicate guard, shared with create: a retry after a create that
        // landed must not publish a second item with the same slug.
        const desiredSlug = nonEmptyString(args.fieldData.slug);
        if (desiredSlug) {
          const match = (await findItemsBySlug(
            args.collectionId,
            [desiredSlug],
            context,
          )).get(desiredSlug);
          if (match) {
            const handle = await context.writeResource(
              "item",
              itemInstanceName(match),
              match,
            );
            context.logger.info(
              "Item with slug {slug} already exists in collection {collectionId} — skipping createLive; it was not re-published (run publish if it should be live)",
              { slug: desiredSlug, collectionId: args.collectionId },
            );
            return { dataHandles: [handle] };
          }
        }

        context.logger.info(
          "Creating and publishing item with slug {slug} in collection {collectionId}",
          { slug: desiredSlug ?? "(none)", collectionId: args.collectionId },
        );
        const item = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/live`,
          g,
          {
            method: "POST",
            body: { fieldData: args.fieldData, isDraft: false },
          },
        ) as Record<string, unknown>;

        const name = itemInstanceName(item);
        const handle = await context.writeResource("liveItem", name, item);

        context.logger.info(
          "Created live item {name} in collection {collectionId}",
          { name, collectionId: args.collectionId },
        );
        return { dataHandles: [handle] };
      },
    },

    updateLive: {
      description:
        "Update a published (live) CMS item's field data directly, without re-publishing.",
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
        context.logger.info(
          "Updating live item {itemId} in collection {collectionId}",
          { itemId: args.itemId, collectionId: args.collectionId },
        );
        const item = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/${
            encodeURIComponent(args.itemId)
          }/live`,
          g,
          {
            method: "PATCH",
            body: { fieldData: args.fieldData },
          },
        ) as Record<string, unknown>;

        const name = itemInstanceName(item, args.itemId);
        const handle = await context.writeResource("liveItem", name, item);

        context.logger.info("Updated live item {name}", { name });
        return { dataHandles: [handle] };
      },
    },

    unpublish: {
      description:
        "Unpublish one or more live CMS items. The staged items are kept (this is not a delete). Verify item IDs before calling.",
      labels: ["live"],
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        itemIds: z.array(z.string()).min(1).max(100).describe(
          "Array of item IDs to unpublish (max 100)",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        context.logger.info(
          "Unpublishing items {itemIds} in collection {collectionId}",
          { itemIds: args.itemIds.join(", "), collectionId: args.collectionId },
        );
        await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/live`,
          g,
          {
            method: "DELETE",
            body: { items: args.itemIds.map((id) => ({ id })) },
          },
        );

        context.logger.info(
          "Unpublished {count} items in collection {collectionId}",
          { count: args.itemIds.length, collectionId: args.collectionId },
        );

        const handle = await context.writeResource(
          "unpublishResult",
          `unpublish-${sanitizeId(args.collectionId)}`,
          {
            collectionId: args.collectionId,
            unpublishedIds: args.itemIds,
            unpublishedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    bulkUpdate: {
      description:
        "Update the staged field data of multiple CMS items in a single request.",
      labels: ["live"],
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        items: z.array(
          z.object({
            id: z.string().describe("Webflow item ID"),
            fieldData: z.record(z.string(), z.unknown()).describe(
              "Fields to update (partial)",
            ),
            isDraft: z.boolean().optional(),
            isArchived: z.boolean().optional(),
            cmsLocaleId: z.string().optional(),
          }),
        ).min(1).max(100).describe("Array of item updates (max 100)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const requestedIds = [...new Set(args.items.map((i) => i.id))];
        context.logger.info(
          "Bulk updating items {itemIds} in collection {collectionId}",
          { itemIds: requestedIds.join(", "), collectionId: args.collectionId },
        );
        const result = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items`,
          g,
          {
            method: "PATCH",
            body: { items: args.items },
          },
        ) as Record<string, unknown>;

        // The 200 response is a single item or { items }; record whatever
        // came back before judging completeness.
        const updated = itemsFromResponse(result);
        const handles = [];
        for (const item of updated) {
          const handle = await context.writeResource(
            "item",
            itemInstanceName(item),
            item,
          );
          handles.push(handle);
        }

        const returnedIds = new Set(updated.map((i) => i.id));
        const missing = requestedIds.filter((id) => !returnedIds.has(id));
        const appliedCount = requestedIds.length - missing.length;
        if (missing.length > 0) {
          throw new Error(
            `Webflow bulkUpdate returned ${appliedCount} of ${requestedIds.length} requested items in collection ${args.collectionId}; missing ids: ${
              missing.join(", ")
            }. The ${appliedCount} returned items were recorded.`,
          );
        }

        context.logger.info(
          "Bulk updated {count} items in collection {collectionId}",
          { count: appliedCount, collectionId: args.collectionId },
        );
        return { dataHandles: handles };
      },
    },

    bulkCreate: {
      description:
        "Create one or more CMS items, optionally across several locales, in a single request via /items/bulk.",
      labels: ["live"],
      arguments: z.object({
        collectionId: z.string().describe("Webflow collection ID"),
        items: z.array(z.record(z.string(), z.unknown())).min(1).max(100)
          .describe(
            "Array of fieldData objects, one per item to create (max 100)",
          ),
        cmsLocaleIds: z.array(z.string()).optional().describe(
          "Locale IDs to create the items in (defaults to the primary locale)",
        ),
        isDraft: z.boolean().optional().default(false).describe(
          "Create as draft",
        ),
        isArchived: z.boolean().optional().default(false).describe(
          "Create as archived",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const handles = [];

        // Duplicate guard, shared with create: items whose slug already
        // exists are recorded and skipped rather than created again.
        const slugs = args.items.map((fd) => nonEmptyString(fd.slug)).filter(
          (s): s is string => s !== undefined,
        );
        const existing = await findItemsBySlug(
          args.collectionId,
          slugs,
          context,
        );
        const toCreate: Record<string, unknown>[] = [];
        for (const fd of args.items) {
          const slug = nonEmptyString(fd.slug);
          const match = slug ? existing.get(slug) : undefined;
          if (!match) {
            toCreate.push(fd);
            continue;
          }
          context.logger.info(
            "Item with slug {slug} already exists in collection {collectionId} — skipping create",
            { slug, collectionId: args.collectionId },
          );
          handles.push(
            await context.writeResource(
              "item",
              itemInstanceName(match),
              match,
            ),
          );
        }
        if (toCreate.length === 0) return { dataHandles: handles };

        const body: Record<string, unknown> = {
          isDraft: args.isDraft,
          isArchived: args.isArchived,
          fieldData: toCreate.length === 1 ? toCreate[0] : toCreate,
        };
        if (args.cmsLocaleIds?.length) body.cmsLocaleIds = args.cmsLocaleIds;

        context.logger.info(
          "Bulk creating {count} items in collection {collectionId}",
          { count: toCreate.length, collectionId: args.collectionId },
        );
        const result = await webflowApi(
          `/collections/${encodeURIComponent(args.collectionId)}/items/bulk`,
          g,
          { method: "POST", body },
        ) as Record<string, unknown>;

        // The endpoint returns { items: [...] } for multiple fieldData
        // objects and a single item when one fieldData object was sent.
        const created = itemsFromResponse(result);

        context.logger.info(
          "Bulk created {count} items in collection {collectionId}",
          { count: created.length, collectionId: args.collectionId },
        );

        for (const item of created) {
          const handle = await context.writeResource(
            "item",
            itemInstanceName(item),
            item,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
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
  }),

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
        "createLive",
        "updateLive",
        "unpublish",
        "bulkUpdate",
        "bulkCreate",
      ],
      execute: async (context: CheckContext) => {
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
