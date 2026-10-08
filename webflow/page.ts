import { z } from "npm:zod@4.3.6";
import {
  defineMethods,
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

const PageContentSchema = z.object({
  pageId: z.string(),
  localeId: z.string().nullable(),
  translatableLocaleId: z.string().nullable(),
  nodeCount: z.number(),
  nodes: z.array(z.record(z.string(), z.unknown())),
  retrievedAt: z.string(),
});

const ContentUpdateSchema = z.object({
  pageId: z.string(),
  localeId: z.string(),
  nodeCount: z.number(),
  nodeIds: z.array(z.string()),
  errors: z.array(z.string()),
  updatedAt: z.string(),
});

/** A script as applied to a page: PUT /pages/{id}/custom_code `scripts[]`. */
const AppliedScriptSchema = z.object({
  id: z.string().min(1).describe("Registered script ID"),
  version: z.string().min(1).describe("Registered script version"),
  location: z.enum(["header", "footer"]).describe(
    "Where the script is placed on the page",
  ),
  attributes: z.record(z.string(), z.string()).optional().describe(
    "Attributes applied to the script tag",
  ),
}).strict();

type AppliedScript = z.infer<typeof AppliedScriptSchema>;

const CustomCodeSchema = z.object({
  pageId: z.string(),
  scripts: z.array(AppliedScriptSchema),
  previousScripts: z.array(AppliedScriptSchema),
  mode: z.enum(["merge", "replace", "read"]),
  updatedAt: z.string(),
});

const CustomCodeDeleteSchema = z.object({
  pageId: z.string(),
  removedScripts: z.array(AppliedScriptSchema),
  deletedAt: z.string(),
});

const RegisteredScriptSchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  version: z.string().optional(),
}).passthrough();

// Write shapes for POST /pages/{id}/dom, one strict schema per v2 node type.
const TextNodeWrite = z.object({
  nodeId: z.string().min(1),
  text: z.string().describe("HTML content for the text node"),
}).strict();

const ComponentInstanceNodeWrite = z.object({
  nodeId: z.string().min(1),
  propertyOverrides: z.array(
    z.object({ propertyId: z.string().min(1), text: z.string() }).strict(),
  ).min(1),
}).strict();

const SelectNodeWrite = z.object({
  nodeId: z.string().min(1),
  choices: z.array(
    z.object({ value: z.string(), text: z.string() }).strict(),
  ).min(1),
}).strict();

const TextInputNodeWrite = z.object({
  nodeId: z.string().min(1),
  placeholder: z.string(),
}).strict();

// The spec requires only nodeId; an update must still change something.
const SubmitButtonNodeWrite = z.object({
  nodeId: z.string().min(1),
  value: z.string().optional(),
  waitingText: z.string().optional(),
}).strict().refine(
  (n) => n.value !== undefined || n.waitingText !== undefined,
  { message: "submit button write needs value or waitingText" },
);

const SearchButtonNodeWrite = z.object({
  nodeId: z.string().min(1),
  value: z.string(),
}).strict();

export const DomNodeWriteSchema = z.union([
  TextNodeWrite,
  ComponentInstanceNodeWrite,
  SelectNodeWrite,
  TextInputNodeWrite,
  SubmitButtonNodeWrite,
  SearchButtonNodeWrite,
]);

/** Webflow limits inline registered scripts to 2000 characters. */
export const INLINE_SCRIPT_MAX_CHARS = 2000;

/**
 * Build the JavaScript registered for JSON-LD. Webflow hosts a registered
 * inline script and emits it inside its own `<script>` element, so
 * `sourceCode` must be JavaScript; an HTML `<script type="application/ld+json">`
 * string there is a syntax error that crawlers never see as JSON-LD. The
 * script creates the `application/ld+json` element itself and appends it
 * to `<head>`. Every `<` in the JSON is written as the escape u003c (still
 * valid JSON), so the generated code contains no `<` at all and nothing in
 * a value can close Webflow's script element early.
 */
export function jsonLdSourceCode(jsonLd: unknown): string {
  const json = JSON.stringify(jsonLd).replace(/</g, "\\u003c");
  return `(function(){var s=document.createElement("script");s.type="application/ld+json";s.text=${
    JSON.stringify(json)
  };document.head.appendChild(s);})();`;
}

/** Optional locale query params shared by get and getContent. */
function localeParams(
  args: { localeId?: string; translatableLocaleId?: string },
): Record<string, string> {
  const params: Record<string, string> = {};
  if (args.localeId !== undefined) params.localeId = args.localeId;
  // `translatable` takes a secondary locale ID, not a boolean.
  if (args.translatableLocaleId !== undefined) {
    params.translatable = args.translatableLocaleId;
  }
  return params;
}

function localeSuffix(
  args: { localeId?: string; translatableLocaleId?: string },
): string {
  const parts = [args.localeId, args.translatableLocaleId].filter(
    (p): p is string => p !== undefined,
  );
  return parts.length > 0 ? `-${parts.map(sanitizeId).join("-")}` : "";
}

const LocaleIdArg = z.string().min(1).optional().describe(
  "Locale ID to read; typically the primary locale when translatableLocaleId is set",
);
const TranslatableLocaleIdArg = z.string().min(1).optional().describe(
  "Secondary locale ID: return only content translatable into it. Webflow returns 400 for the primary locale or any other value, and 403 unless translation exclusions are enabled",
);

/** Read a page's applied scripts, keeping only the PUT-able fields. */
async function readPageScripts(
  pageId: string,
  g: WebflowGlobalArgs,
): Promise<AppliedScript[]> {
  const result = await webflowApi(
    `/pages/${encodeURIComponent(pageId)}/custom_code`,
    g,
  ) as { scripts?: Record<string, unknown>[] };
  return (result.scripts ?? []).map((s) => {
    if (typeof s.id !== "string" || s.id === "") {
      throw new Error(
        `Custom code for page ${pageId} returned a script without an id`,
      );
    }
    if (typeof s.version !== "string" || s.version === "") {
      throw new Error(
        `Custom code for page ${pageId} returned script ${s.id} without a version`,
      );
    }
    const script: AppliedScript = {
      id: s.id,
      version: s.version,
      location: s.location === "footer" ? "footer" : "header",
    };
    if (s.attributes && typeof s.attributes === "object") {
      script.attributes = s.attributes as Record<string, string>;
    }
    return script;
  });
}

/** Add or replace scripts by id, preserving the order of existing ones. */
export function mergeScripts(
  existing: AppliedScript[],
  incoming: AppliedScript[],
): AppliedScript[] {
  const merged = [...existing];
  for (const script of incoming) {
    const i = merged.findIndex((s) => s.id === script.id);
    if (i >= 0) merged[i] = script;
    else merged.push(script);
  }
  return merged;
}

/**
 * PUT a page's script list, merging into the current list unless
 * `replace` is set (PUT replaces the whole list, so omitting a script
 * removes it). Reads the list back and throws if a requested script
 * is missing.
 */
async function applyPageScripts(
  pageId: string,
  scripts: AppliedScript[],
  replace: boolean,
  context: MethodContext,
): Promise<unknown> {
  const g = context.globalArgs;
  const previous = await readPageScripts(pageId, g);
  const next = replace ? scripts : mergeScripts(previous, scripts);

  context.logger.info(
    "Applying custom code to page {pageId} ({mode}): {before} scripts before, {after} after",
    {
      pageId,
      mode: replace ? "replace" : "merge",
      before: previous.length,
      after: next.length,
    },
  );
  await webflowApi(
    `/pages/${encodeURIComponent(pageId)}/custom_code`,
    g,
    { method: "PUT", body: { scripts: next } },
  );

  const readBack = await readPageScripts(pageId, g);
  const missing = scripts.filter((s) =>
    !readBack.some((r) => r.id === s.id && r.version === s.version)
  ).map((s) => `${s.id}@${s.version}`);
  if (missing.length > 0) {
    throw new Error(
      `Page ${pageId} custom code read-back is missing scripts: ${
        missing.join(", ")
      }`,
    );
  }
  context.logger.info(
    "Page {pageId} now has {count} custom code scripts",
    { pageId, count: readBack.length },
  );

  return await context.writeResource(
    "customCode",
    `custom-code-${sanitizeId(pageId)}`,
    {
      pageId,
      scripts: readBack,
      previousScripts: previous,
      mode: replace ? "replace" : "merge",
      updatedAt: new Date().toISOString(),
    },
  );
}

/**
 * `@dougschaefer/webflow-page` model — Webflow page-level operations
 * via the Data API v2. List enumerates pages within a site with SEO
 * and OpenGraph metadata. Get returns a single page with full
 * settings. updateSettings mutates title/description/slug/SEO/OG
 * fields without touching DOM content — safe for bulk SEO sweeps.
 * getContent pages through the static DOM node tree; updateContent
 * writes translated node content to a secondary locale. Page custom
 * code is merged by script id rather than overwritten, and JSON-LD
 * structured data goes on a page as a registered inline script.
 * Paired with the seo-audit and seo-site-health reports.
 */
export const model = {
  type: "@dougschaefer/webflow-page",
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
        "Added translatable locale filter, paginated getContent stored as the content resource, updateContent, custom code get/apply/delete and addJsonLd; globalArguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  reports: ["@dougschaefer/seo-audit", "@dougschaefer/seo-site-health"],
  globalArguments: WebflowGlobalArgsSchema,
  resources: {
    page: {
      description: "Webflow page with SEO metadata and publishing status",
      schema: PageSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    content: {
      description:
        "Static DOM nodes for a page (all pages of nodes), optionally for a locale",
      schema: PageContentSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    contentUpdate: {
      description:
        "Record of a DOM write: page, secondary locale, node ids and Webflow's errors",
      schema: ContentUpdateSchema,
      lifetime: "90d",
      garbageCollection: 20,
    },
    customCode: {
      description:
        "Scripts applied to a page, with the list before the last change",
      schema: CustomCodeSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    customCodeDelete: {
      description: "Record of a page custom code delete and what it removed",
      schema: CustomCodeDeleteSchema,
      lifetime: "90d",
      garbageCollection: 20,
    },
    registeredScript: {
      description: "Inline script registered on a site (e.g. JSON-LD)",
      schema: RegisteredScriptSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: defineMethods({
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
        localeId: LocaleIdArg,
        translatableLocaleId: TranslatableLocaleIdArg,
      }).strict(),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const page = await webflowApi(
          `/pages/${encodeURIComponent(args.pageId)}`,
          g,
          { params: localeParams(args) },
        ) as Record<string, unknown>;

        // Locale reads get a suffix so they never overwrite the primary page.
        const name = sanitizeId(page.slug as string || args.pageId) +
          localeSuffix(args);
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

        context.logger.info(
          "Updating page settings for {pageId}: {fields}",
          { pageId: args.pageId, fields: Object.keys(body).join(", ") },
        );
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
      description:
        "Get the static content (DOM nodes) for a page, paging through all nodes.",
      arguments: z.object({
        pageId: z.string().describe("Webflow page ID"),
        localeId: LocaleIdArg,
        translatableLocaleId: TranslatableLocaleIdArg,
      }).strict(),
      execute: async (args, context) => {
        const g = context.globalArgs;
        // GET /pages/{id}/dom pages with limit/offset, max 100 nodes a page.
        const nodes = await webflowPaginated(
          `/pages/${encodeURIComponent(args.pageId)}/dom`,
          g,
          "nodes",
          localeParams(args),
        ) as Record<string, unknown>[];

        context.logger.info(
          "Retrieved {count} DOM nodes for page {pageId}",
          { count: nodes.length, pageId: args.pageId },
        );

        const handle = await context.writeResource(
          "content",
          `content-${sanitizeId(args.pageId)}${localeSuffix(args)}`,
          {
            pageId: args.pageId,
            localeId: args.localeId ?? null,
            translatableLocaleId: args.translatableLocaleId ?? null,
            nodeCount: nodes.length,
            nodes,
            retrievedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    updateContent: {
      description:
        "Write DOM node content for a secondary locale (up to 1000 nodes). Fails if Webflow reports any node errors.",
      labels: ["live"],
      arguments: z.object({
        pageId: z.string().describe("Webflow page ID"),
        localeId: z.string().min(1).describe(
          "Secondary locale ID to write (required; the primary locale cannot be written)",
        ),
        nodes: z.array(DomNodeWriteSchema).min(1).max(1000).describe(
          "Node updates (max 1000), each { nodeId, ... } for its node type",
        ),
      }).strict(),
      execute: async (args, context) => {
        const g = context.globalArgs;
        context.logger.info(
          "Updating {count} DOM nodes on page {pageId} for locale {localeId}",
          {
            count: args.nodes.length,
            pageId: args.pageId,
            localeId: args.localeId,
          },
        );
        const result = await webflowApi(
          `/pages/${encodeURIComponent(args.pageId)}/dom`,
          g,
          {
            method: "POST",
            params: { localeId: args.localeId },
            body: { nodes: args.nodes },
          },
        ) as { errors?: unknown[] };
        const errors = (result.errors ?? []).map(String);

        const handle = await context.writeResource(
          "contentUpdate",
          `content-update-${sanitizeId(args.pageId)}-${
            sanitizeId(args.localeId)
          }`,
          {
            pageId: args.pageId,
            localeId: args.localeId,
            nodeCount: args.nodes.length,
            nodeIds: args.nodes.map((n) => n.nodeId),
            errors,
            updatedAt: new Date().toISOString(),
          },
        );
        if (errors.length > 0) {
          throw new Error(
            `Webflow reported ${errors.length} error(s) updating page ${args.pageId} locale ${args.localeId}: ${
              errors.join("; ")
            }`,
          );
        }
        context.logger.info(
          "Updated {count} DOM nodes on page {pageId} for locale {localeId}",
          {
            count: args.nodes.length,
            pageId: args.pageId,
            localeId: args.localeId,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    getCustomCode: {
      description: "Get the registered scripts applied to a page.",
      arguments: z.object({
        pageId: z.string().describe("Webflow page ID"),
      }).strict(),
      execute: async (args, context) => {
        const scripts = await readPageScripts(args.pageId, context.globalArgs);
        context.logger.info(
          "Page {pageId} has {count} custom code scripts",
          { pageId: args.pageId, count: scripts.length },
        );
        const handle = await context.writeResource(
          "customCode",
          `custom-code-${sanitizeId(args.pageId)}`,
          {
            pageId: args.pageId,
            scripts,
            previousScripts: scripts,
            mode: "read",
            updatedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    applyCustomCode: {
      description:
        "Apply registered scripts to a page. Merges by script id into the existing list; set replace: true only to intentionally replace the whole list.",
      labels: ["live"],
      arguments: z.object({
        pageId: z.string().describe("Webflow page ID"),
        scripts: z.array(AppliedScriptSchema).min(1).describe(
          "Scripts to add or replace by id",
        ),
        replace: z.boolean().default(false).describe(
          "Replace the page's entire script list instead of merging (scripts not listed are removed)",
        ),
      }).strict(),
      execute: async (args, context) => {
        const handle = await applyPageScripts(
          args.pageId,
          args.scripts,
          args.replace,
          context,
        );
        return { dataHandles: [handle] };
      },
    },

    deleteCustomCode: {
      description:
        "Remove ALL custom code from a page. Verify the page ID and run getCustomCode first; to remove one script use applyCustomCode with replace: true.",
      labels: ["live"],
      arguments: z.object({
        pageId: z.string().describe("Webflow page ID"),
      }).strict(),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const previous = await readPageScripts(args.pageId, g);
        context.logger.info(
          "Deleting all custom code from page {pageId} ({count} scripts: {ids})",
          {
            pageId: args.pageId,
            count: previous.length,
            ids: previous.map((s) => s.id).join(", "),
          },
        );
        await webflowApi(
          `/pages/${encodeURIComponent(args.pageId)}/custom_code`,
          g,
          { method: "DELETE" },
        );
        context.logger.info("Deleted custom code from page {pageId}", {
          pageId: args.pageId,
        });

        const handle = await context.writeResource(
          "customCodeDelete",
          `custom-code-delete-${sanitizeId(args.pageId)}`,
          {
            pageId: args.pageId,
            removedScripts: previous,
            deletedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    addJsonLd: {
      description:
        'Add JSON-LD structured data to a page: registers a small inline site script (max 2000 characters) that injects a <script type="application/ld+json"> block into <head>, and merges it into the page\'s custom code.',
      labels: ["live"],
      arguments: z.object({
        siteId: z.string().describe("Webflow site ID that owns the page"),
        pageId: z.string().describe("Webflow page ID"),
        jsonLd: z.union([
          z.record(z.string(), z.unknown()),
          z.array(z.record(z.string(), z.unknown())).min(1),
        ]).describe(
          "JSON-LD object (or array of objects), e.g. a schema.org Organization",
        ),
        displayName: z.string().min(1).max(50).regex(
          /^[A-Za-z0-9 ]+$/,
          "displayName must be letters, digits and spaces",
        ).describe(
          "Registered script display name: 1-50 alphanumeric characters (Webflow's rule)",
        ),
        version: z.string().min(1).describe(
          "Registered script version (semver, e.g. 1.0.0)",
        ),
        location: z.enum(["header", "footer"]).default("header").describe(
          "Where the script is placed on the page",
        ),
        canCopy: z.boolean().optional().describe(
          "Allow the script to be copied when the site is duplicated",
        ),
      }).strict(),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const sourceCode = jsonLdSourceCode(args.jsonLd);
        if (sourceCode.length > INLINE_SCRIPT_MAX_CHARS) {
          throw new Error(
            `JSON-LD script is ${sourceCode.length} characters; Webflow inline scripts are limited to ${INLINE_SCRIPT_MAX_CHARS}`,
          );
        }

        const body: Record<string, unknown> = {
          sourceCode,
          version: args.version,
          displayName: args.displayName,
        };
        if (args.canCopy !== undefined) body.canCopy = args.canCopy;

        context.logger.info(
          "Registering inline JSON-LD script {displayName} {version} ({chars} chars) on site {siteId}",
          {
            displayName: args.displayName,
            version: args.version,
            chars: sourceCode.length,
            siteId: args.siteId,
          },
        );
        const registered = await webflowApi(
          `/sites/${encodeURIComponent(args.siteId)}/registered_scripts/inline`,
          g,
          { method: "POST", body },
        ) as Record<string, unknown>;
        const scriptId = registered.id as string;
        const scriptHandle = await context.writeResource(
          "registeredScript",
          sanitizeId(`${scriptId}-${args.version}`),
          registered,
        );

        const codeHandle = await applyPageScripts(
          args.pageId,
          [{ id: scriptId, version: args.version, location: args.location }],
          false,
          context,
        );
        return { dataHandles: [scriptHandle, codeHandle] };
      },
    },
  }),

  checks: {
    "webflow-page-token-valid": {
      description:
        "Verify the Webflow API token can reach the pages API before updating page settings, content or custom code.",
      labels: ["live"],
      appliesTo: [
        "updateSettings",
        "updateContent",
        "applyCustomCode",
        "deleteCustomCode",
        "addJsonLd",
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
