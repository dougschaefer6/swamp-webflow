import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { itemInstanceName, model } from "./cms_item.ts";
import { retryAfterMs, webflowPaginated } from "./_client.ts";
import type { WebflowGlobalArgs } from "./_client.ts";

const g: WebflowGlobalArgs = {
  token: "test-key",
  baseUrl: "https://api.example.com/v2",
};

interface Call {
  method: string;
  path: string;
  search: string;
  auth: string | null;
  body: unknown;
}

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Ordered log of fetches and logger.info calls, reset per `run`. */
const events: string[] = [];

/** Swap `globalThis.fetch` for a stub that records calls; returns restore. */
function mockFetch(handler: (call: Call) => Reply, calls: Call[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      search: url.search,
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    events.push(`fetch ${call.method} ${call.path}`);
    const reply = handler(call);
    return Promise.resolve(
      new Response(
        reply.status === 204 ? null : JSON.stringify(reply.body),
        { status: reply.status, headers: reply.headers },
      ),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

type Write = { spec: string; instance: string; data: Record<string, unknown> };

function fakeContext() {
  const writes: Write[] = [];
  const context = {
    globalArgs: g,
    logger: {
      info: (message: string, props?: Record<string, unknown>) => {
        events.push(`log ${message} ${JSON.stringify(props ?? {})}`);
      },
    },
    writeResource: (
      spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, instance, data });
      return Promise.resolve({ spec, instance });
    },
  };
  return { writes, context };
}

function item(id: string, slug: string): Record<string, unknown> {
  return {
    id,
    lastPublished: "2026-10-01T00:00:00.000Z",
    lastUpdated: "2026-10-01T00:00:00.000Z",
    createdOn: "2026-10-01T00:00:00.000Z",
    isArchived: false,
    isDraft: false,
    fieldData: { slug, name: slug },
  };
}

// deno-lint-ignore no-explicit-any
type AnyMethod = { arguments: any; execute: (a: any, c: any) => Promise<any> };
function method(name: keyof typeof model.methods): AnyMethod {
  return model.methods[name] as unknown as AnyMethod;
}

async function run(
  name: keyof typeof model.methods,
  rawArgs: Record<string, unknown>,
  handler: (call: Call) => Reply,
) {
  const calls: Call[] = [];
  events.length = 0;
  const restore = mockFetch(handler, calls);
  const { writes, context } = fakeContext();
  try {
    const m = method(name);
    const args = m.arguments.parse(rawArgs);
    const result = await m.execute(args, context);
    return { calls, writes, result };
  } finally {
    restore();
  }
}

Deno.test("listLive paginates /items/live and writes liveItem resources", async () => {
  const { calls, writes } = await run(
    "listLive",
    { collectionId: "col1" },
    (call) => {
      const offset = new URLSearchParams(call.search).get("offset");
      return offset === "0"
        ? {
          status: 200,
          body: {
            items: [item("a", "Alpha Post")],
            pagination: { total: 2, limit: 100, offset: 0 },
          },
        }
        : {
          status: 200,
          body: {
            items: [item("b", "beta")],
            pagination: { total: 2, limit: 100, offset: 100 },
          },
        };
    },
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[0].path, "/v2/collections/col1/items/live");
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[0].auth, "Bearer test-key");
  assertEquals(writes.map((w) => [w.spec, w.instance]), [
    ["liveItem", "alpha-post"],
    ["liveItem", "beta"],
  ]);
});

Deno.test("getLive reads the live copy of one item", async () => {
  const { calls, writes } = await run(
    "getLive",
    { collectionId: "col1", itemId: "it1" },
    () => ({ status: 200, body: item("it1", "hello") }),
  );
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[0].path, "/v2/collections/col1/items/it1/live");
  assertEquals(writes[0].spec, "liveItem");
  assertEquals(writes[0].instance, "hello");
});

Deno.test("createLive posts to /items/live after a clean slug lookup", async () => {
  const { calls, writes } = await run(
    "createLive",
    { collectionId: "col1", fieldData: { name: "New", slug: "new" } },
    (call) =>
      call.method === "GET"
        ? { status: 200, body: { items: [], pagination: { total: 0 } } }
        : { status: 202, body: item("n1", "new") },
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[0].path, "/v2/collections/col1/items");
  assertEquals(new URLSearchParams(calls[0].search).get("slug"), "new");
  assertEquals(calls[1].method, "POST");
  assertEquals(calls[1].path, "/v2/collections/col1/items/live");
  assertEquals(calls[1].body, {
    fieldData: { name: "New", slug: "new" },
    isDraft: false,
  });
  assertEquals(writes[0].spec, "liveItem");
});

Deno.test("updateLive patches the live item", async () => {
  const { calls, writes } = await run(
    "updateLive",
    { collectionId: "col1", itemId: "it1", fieldData: { name: "Changed" } },
    () => ({ status: 200, body: item("it1", "hello") }),
  );
  assertEquals(calls[0].method, "PATCH");
  assertEquals(calls[0].path, "/v2/collections/col1/items/it1/live");
  assertEquals(calls[0].body, { fieldData: { name: "Changed" } });
  assertEquals(writes[0].spec, "liveItem");
});

Deno.test("unpublish sends DELETE /items/live with exactly the given ids", async () => {
  const { calls, writes, result } = await run(
    "unpublish",
    { collectionId: "col1", itemIds: ["a", "b"] },
    () => ({ status: 204, body: null }),
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "DELETE");
  assertEquals(calls[0].path, "/v2/collections/col1/items/live");
  assertEquals(calls[0].body, { items: [{ id: "a" }, { id: "b" }] });
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "unpublishResult");
  assertEquals(writes[0].instance, "unpublish-col1");
  assertEquals(writes[0].data.unpublishedIds, ["a", "b"]);
  assertEquals(result.dataHandles.length, 1);
  assertEquals(result.data, undefined);
});

Deno.test("unpublish rejects an empty id list", () => {
  const m = method("unpublish");
  assertEquals(
    m.arguments.safeParse({ collectionId: "col1", itemIds: [] }).success,
    false,
  );
});

Deno.test("bulkUpdate patches /items and records an { items } response", async () => {
  const { calls, writes } = await run(
    "bulkUpdate",
    {
      collectionId: "col1",
      items: [
        { id: "a", fieldData: { name: "A2" } },
        { id: "b", fieldData: { name: "B2" }, isDraft: true },
      ],
    },
    () => ({
      status: 200,
      body: { items: [item("a", "a"), item("b", "b")] },
    }),
  );
  assertEquals(calls[0].method, "PATCH");
  assertEquals(calls[0].path, "/v2/collections/col1/items");
  assertEquals(calls[0].body, {
    items: [
      { id: "a", fieldData: { name: "A2" } },
      { id: "b", fieldData: { name: "B2" }, isDraft: true },
    ],
  });
  assertEquals(writes.map((w) => [w.spec, w.instance]), [
    ["item", "a"],
    ["item", "b"],
  ]);
});

Deno.test("bulkUpdate caps a request at 100 items", () => {
  const m = method("bulkUpdate");
  const items = Array.from({ length: 101 }, (_, i) => ({
    id: `i${i}`,
    fieldData: {},
  }));
  assertEquals(
    m.arguments.safeParse({ collectionId: "col1", items }).success,
    false,
  );
});

Deno.test("bulkCreate posts to /items/bulk with locales", async () => {
  const { calls, writes } = await run(
    "bulkCreate",
    {
      collectionId: "col1",
      items: [{ name: "One", slug: "one" }, { name: "Two", slug: "two" }],
      cmsLocaleIds: ["loc1", "loc2"],
    },
    (call) =>
      call.method === "GET"
        ? { status: 200, body: { items: [], pagination: { total: 0 } } }
        : {
          status: 202,
          body: { items: [item("1", "one"), item("2", "two")] },
        },
  );
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[1].method, "POST");
  assertEquals(calls[1].path, "/v2/collections/col1/items/bulk");
  assertEquals(calls[1].body, {
    isDraft: false,
    isArchived: false,
    fieldData: [{ name: "One", slug: "one" }, { name: "Two", slug: "two" }],
    cmsLocaleIds: ["loc1", "loc2"],
  });
  assertEquals(writes.map((w) => w.instance), ["one", "two"]);
});

Deno.test("bulkCreate handles a single-item response", async () => {
  const { calls, writes } = await run(
    "bulkCreate",
    { collectionId: "col1", items: [{ name: "Solo", slug: "solo" }] },
    (call) =>
      call.method === "GET"
        ? { status: 200, body: { items: [], pagination: { total: 0 } } }
        : { status: 202, body: item("s1", "solo") },
  );
  assertEquals(calls[1].body, {
    isDraft: false,
    isArchived: false,
    fieldData: { name: "Solo", slug: "solo" },
  });
  assertEquals(writes.map((w) => [w.spec, w.instance]), [["item", "solo"]]);
});

Deno.test("batchDelete sends { items: [{ id }] } to DELETE /items and records it", async () => {
  const { calls, writes, result } = await run(
    "batchDelete",
    { collectionId: "col1", itemIds: ["a", "b"] },
    () => ({ status: 204, body: null }),
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "DELETE");
  assertEquals(calls[0].path, "/v2/collections/col1/items");
  assertEquals(calls[0].body, { items: [{ id: "a" }, { id: "b" }] });
  assertEquals(writes[0].spec, "deleteResult");
  assertEquals(writes[0].instance, "batch-delete-col1");
  assertEquals(writes[0].data.itemIds, ["a", "b"]);
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("batch arguments enforce 1..100 items", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);
  const cases: [keyof typeof model.methods, Record<string, unknown>][] = [
    ["batchDelete", { itemIds: [] }],
    ["batchDelete", { itemIds: ids(101) }],
    ["batchCreate", { items: [] }],
    [
      "batchCreate",
      { items: ids(101).map((slug) => ({ fieldData: { slug } })) },
    ],
    ["bulkCreate", { items: ids(101).map((slug) => ({ slug })) }],
    ["bulkUpdate", { items: [] }],
    ["publish", { itemIds: [] }],
  ];
  for (const [name, extra] of cases) {
    assertEquals(
      method(name).arguments.safeParse({ collectionId: "col1", ...extra })
        .success,
      false,
      name,
    );
  }
  assertEquals(
    method("batchDelete").arguments.safeParse({
      collectionId: "col1",
      itemIds: ids(100),
    }).success,
    true,
  );
});

Deno.test("bulkUpdate records a single-object response", async () => {
  const { writes, result } = await run(
    "bulkUpdate",
    { collectionId: "col1", items: [{ id: "a", fieldData: { name: "A2" } }] },
    () => ({ status: 200, body: item("a", "a") }),
  );
  assertEquals(writes.map((w) => [w.spec, w.instance]), [["item", "a"]]);
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("bulkUpdate throws on a partial response but records what succeeded", async () => {
  const calls: Call[] = [];
  events.length = 0;
  const restore = mockFetch(
    () => ({ status: 200, body: { items: [item("a", "a")] } }),
    calls,
  );
  const { writes, context } = fakeContext();
  try {
    const m = method("bulkUpdate");
    const args = m.arguments.parse({
      collectionId: "col1",
      items: [
        { id: "a", fieldData: {} },
        { id: "b", fieldData: {} },
        { id: "c", fieldData: {} },
      ],
    });
    await assertRejects(
      () => m.execute(args, context),
      Error,
      "returned 1 of 3 requested items in collection col1; missing ids: b, c",
    );
  } finally {
    restore();
  }
  assertEquals(writes.map((w) => w.instance), ["a"]);
});

Deno.test("delete treats an HTTP 404 as already deleted and records it", async () => {
  const { writes, result } = await run(
    "delete",
    { collectionId: "col1", itemId: "gone" },
    () => ({ status: 404, body: { message: "not found" } }),
  );
  assertEquals(writes[0].spec, "deleteResult");
  assertEquals(writes[0].instance, "delete-gone");
  assertEquals(writes[0].data.notFoundIds, ["gone"]);
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("delete rethrows a non-404 error whose body mentions 404", async () => {
  await assertRejects(
    () =>
      run(
        "delete",
        { collectionId: "col1", itemId: "x" },
        () => ({ status: 500, body: { message: "upstream 404 cache miss" } }),
      ),
    Error,
    "Webflow API 500",
  );
});

Deno.test("delete logs the target ids before the write, never the token", async () => {
  await run(
    "delete",
    { collectionId: "col1", itemId: "it9" },
    () => ({ status: 204, body: null }),
  );
  const logIdx = events.findIndex((e) => e.startsWith("log Deleting item"));
  const fetchIdx = events.findIndex((e) => e.startsWith("fetch DELETE"));
  assertEquals(logIdx >= 0 && logIdx < fetchIdx, true);
  assertEquals(events[logIdx].includes("it9"), true);
  assertEquals(events.some((e) => e.includes(g.token)), false);
});

Deno.test("publish records Webflow's published ids and errors", async () => {
  const { calls, writes } = await run(
    "publish",
    { collectionId: "col1", itemIds: ["a", "b"] },
    () => ({
      status: 202,
      body: { publishedItemIds: ["a"], errors: ["b failed"] },
    }),
  );
  assertEquals(calls[0].body, { itemIds: ["a", "b"] });
  assertEquals(writes[0].spec, "publishResult");
  assertEquals(writes[0].instance, "publish-col1");
  assertEquals(writes[0].data.publishedItemIds, ["a"]);
  assertEquals(writes[0].data.errors, ["b failed"]);
});

Deno.test("createLive skips the publish when the slug already exists", async () => {
  const { calls, writes } = await run(
    "createLive",
    { collectionId: "col1", fieldData: { name: "Dup", slug: "dup" } },
    () => ({
      status: 200,
      body: { items: [item("d1", "dup")], pagination: { total: 1 } },
    }),
  );
  assertEquals(calls.map((c) => c.method), ["GET"]);
  assertEquals(writes.map((w) => [w.spec, w.instance]), [["item", "dup"]]);
});

Deno.test("bulkCreate creates only the slugs that do not exist yet", async () => {
  const { calls, writes } = await run(
    "bulkCreate",
    {
      collectionId: "col1",
      items: [{ name: "Old", slug: "old" }, { name: "New", slug: "new" }],
    },
    (call) =>
      call.method === "GET"
        ? {
          status: 200,
          body: { items: [item("o1", "old")], pagination: { total: 1 } },
        }
        : { status: 202, body: item("n1", "new") },
  );
  assertEquals(calls.map((c) => c.method), ["GET", "POST"]);
  // Several slugs list the collection once rather than filtering per slug.
  assertEquals(new URLSearchParams(calls[0].search).get("slug"), null);
  assertEquals(calls[1].body, {
    isDraft: false,
    isArchived: false,
    fieldData: { name: "New", slug: "new" },
  });
  assertEquals(writes.map((w) => w.instance), ["old", "new"]);
});

Deno.test("itemInstanceName falls back to the id and suffixes locales", () => {
  assertEquals(itemInstanceName({ id: "abc", fieldData: {} }), "abc");
  assertEquals(itemInstanceName({ fieldData: {} }, "Fallback1"), "fallback1");
  assertEquals(
    itemInstanceName({
      id: "abc",
      cmsLocaleIds: ["locA", "locB"],
      fieldData: { slug: "post" },
    }),
    "post-loca-locb",
  );
  let threw = false;
  try {
    itemInstanceName({ fieldData: {} });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("liveItem schema accepts a 202 body without isDraft/isArchived", () => {
  const { isDraft: _d, isArchived: _a, ...bare } = item("l1", "live");
  const live = model.resources.liveItem.schema.safeParse(bare);
  assertEquals(live.success, true);
});

Deno.test("pagination stops on an empty page despite a larger total", async () => {
  const calls: Call[] = [];
  const restore = mockFetch(
    () => ({ status: 200, body: { items: [], pagination: { total: 500 } } }),
    calls,
  );
  try {
    const items = await webflowPaginated("/collections/c/items", g, "items");
    assertEquals(items.length, 0);
    assertEquals(calls.length, 1);
  } finally {
    restore();
  }
});

Deno.test("pagination retries once on a 429, honouring Retry-After", async () => {
  const calls: Call[] = [];
  const restore = mockFetch(
    () =>
      calls.length === 1
        ? { status: 429, body: {}, headers: { "retry-after": "0" } }
        : {
          status: 200,
          body: { items: [item("a", "a")], pagination: { total: 1 } },
        },
    calls,
  );
  try {
    const items = await webflowPaginated("/collections/c/items", g, "items");
    assertEquals(items.length, 1);
    assertEquals(calls.length, 2);
  } finally {
    restore();
  }
});

Deno.test("pagination gives up after a second 429", async () => {
  const calls: Call[] = [];
  const restore = mockFetch(
    () => ({ status: 429, body: {}, headers: { "retry-after": "0" } }),
    calls,
  );
  try {
    await assertRejects(
      () => webflowPaginated("/collections/c/items", g, "items"),
      Error,
      "Webflow API 429",
    );
    assertEquals(calls.length, 2);
  } finally {
    restore();
  }
});

Deno.test("retryAfterMs caps long waits and defaults a missing header", () => {
  assertEquals(retryAfterMs("2"), 2000);
  assertEquals(retryAfterMs("3600"), 30_000);
  assertEquals(retryAfterMs(null), 5_000);
  assertEquals(retryAfterMs("not-a-date"), 5_000);
});

Deno.test("live methods surface API errors", async () => {
  await assertRejects(
    () =>
      run(
        "getLive",
        { collectionId: "col1", itemId: "missing" },
        () => ({ status: 404, body: { message: "not found" } }),
      ),
    Error,
    "Webflow API 404",
  );
});

Deno.test("mutating methods are covered by the token check", () => {
  const appliesTo = model.checks["webflow-token-valid"].appliesTo;
  for (
    const m of [
      "createLive",
      "updateLive",
      "unpublish",
      "bulkUpdate",
      "bulkCreate",
    ]
  ) {
    assertEquals(appliesTo.includes(m), true, m);
  }
});

Deno.test("every model ends its upgrades at the current version", async () => {
  for (const file of ["site.ts", "collection.ts", "cms_item.ts", "page.ts"]) {
    const mod = await import(`./${file}`);
    const upgrades = mod.model.upgrades as { toVersion: string }[];
    assertEquals(mod.model.version, "2026.10.07.1", file);
    assertEquals(upgrades.at(-1)?.toVersion, mod.model.version, file);
  }
});
