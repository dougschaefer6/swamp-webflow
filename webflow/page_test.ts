import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { jsonLdSourceCode, mergeScripts, model } from "./page.ts";
import type { WebflowGlobalArgs } from "./_client.ts";

const g: WebflowGlobalArgs = {
  token: "test-key",
  baseUrl: "https://api.example.com/v2",
};

interface Call {
  method: string;
  path: string;
  params: Record<string, string>;
  body: unknown;
}

/** Ordered log of fetches and logger.info calls, reset per `run`. */
const events: string[] = [];

function mockFetch(
  handler: (call: Call) => { status: number; body: unknown },
  calls: Call[],
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    events.push(`fetch ${call.method} ${call.path}`);
    const reply = handler(call);
    return Promise.resolve(
      new Response(
        reply.status === 204 ? null : JSON.stringify(reply.body),
        { status: reply.status },
      ),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

type Write = { spec: string; instance: string; data: Record<string, unknown> };

// deno-lint-ignore no-explicit-any
type AnyMethod = { arguments: any; execute: (a: any, c: any) => Promise<any> };
function method(name: keyof typeof model.methods): AnyMethod {
  return model.methods[name] as unknown as AnyMethod;
}

async function run(
  name: keyof typeof model.methods,
  rawArgs: Record<string, unknown>,
  handler: (call: Call) => { status: number; body: unknown },
) {
  const calls: Call[] = [];
  const writes: Write[] = [];
  events.length = 0;
  const restore = mockFetch(handler, calls);
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
  try {
    const m = method(name);
    const result = await m.execute(m.arguments.parse(rawArgs), context);
    return { calls, writes, result };
  } finally {
    restore();
  }
}

/** Run expecting a rejection; returns the calls/writes made before it. */
async function runRejects(
  name: keyof typeof model.methods,
  rawArgs: Record<string, unknown>,
  handler: (call: Call) => { status: number; body: unknown },
  msgIncludes: string,
) {
  const calls: Call[] = [];
  const writes: Write[] = [];
  events.length = 0;
  const restore = mockFetch(handler, calls);
  const context = {
    globalArgs: g,
    logger: { info: () => {} },
    writeResource: (
      spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, instance, data });
      return Promise.resolve({ spec, instance });
    },
  };
  try {
    const m = method(name);
    await assertRejects(
      () => m.execute(m.arguments.parse(rawArgs), context),
      Error,
      msgIncludes,
    );
    return { calls, writes };
  } finally {
    restore();
  }
}

const page = {
  id: "p1",
  siteId: "s1",
  title: "About",
  slug: "about",
  parentId: null,
  collectionId: null,
  createdOn: "2026-10-01T00:00:00.000Z",
  lastUpdated: "2026-10-01T00:00:00.000Z",
  archived: false,
  draft: false,
};

// --- translatable filter ----------------------------------------------------

Deno.test("get sends translatable as the secondary locale ID string", async () => {
  const { calls, writes } = await run(
    "get",
    { pageId: "p1", localeId: "loc-primary", translatableLocaleId: "loc-fr" },
    () => ({ status: 200, body: page }),
  );
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[0].path, "/v2/pages/p1");
  assertEquals(calls[0].params, {
    localeId: "loc-primary",
    translatable: "loc-fr",
  });
  assertEquals(writes[0].instance, "about-loc-primary-loc-fr");
});

Deno.test("get without locale args sends no query and keeps the slug name", async () => {
  const { calls, writes } = await run(
    "get",
    { pageId: "p1" },
    () => ({ status: 200, body: page }),
  );
  assertEquals(calls[0].params, {});
  assertEquals(writes[0].instance, "about");
});

Deno.test("translatableLocaleId must be a string, not a boolean", () => {
  for (const name of ["get", "getContent"] as const) {
    assertThrows(() =>
      method(name).arguments.parse({ pageId: "p1", translatableLocaleId: true })
    );
  }
});

Deno.test("get surfaces Webflow's 400 for a primary-locale translatable", async () => {
  await runRejects(
    "get",
    { pageId: "p1", translatableLocaleId: "loc-primary" },
    () => ({ status: 400, body: { message: "Bad Request" } }),
    "Webflow API 400",
  );
});

// --- getContent pagination -------------------------------------------------

Deno.test("getContent pages through all nodes and stores the content resource", async () => {
  const node = (id: string) => ({ id, type: "text", text: { html: id } });
  const { calls, writes, result } = await run(
    "getContent",
    { pageId: "p1", localeId: "loc-primary", translatableLocaleId: "loc-fr" },
    (call) =>
      call.params.offset === "0"
        ? {
          status: 200,
          body: {
            pageId: "p1",
            nodes: Array.from({ length: 100 }, (_, i) => node(`n${i}`)),
            pagination: { limit: 100, offset: 0, total: 101 },
          },
        }
        : {
          status: 200,
          body: {
            pageId: "p1",
            nodes: [node("n100")],
            pagination: { limit: 100, offset: 100, total: 101 },
          },
        },
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[0].path, "/v2/pages/p1/dom");
  assertEquals(calls[0].params, {
    localeId: "loc-primary",
    translatable: "loc-fr",
    limit: "100",
    offset: "0",
  });
  assertEquals(calls[1].params.offset, "100");
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "content");
  assertEquals(writes[0].instance, "content-p1-loc-primary-loc-fr");
  assertEquals(writes[0].data.nodeCount, 101);
  assertEquals(writes[0].data.translatableLocaleId, "loc-fr");
  assertEquals(result.dataHandles.length, 1);
  assertEquals(
    model.resources.content.schema.safeParse(writes[0].data).success,
    true,
  );
});

// --- updateContent ----------------------------------------------------------

const textNode = { nodeId: "n1", text: "<p>Bonjour</p>" };

Deno.test("updateContent posts { nodes } with localeId and records it", async () => {
  const nodes = [
    textNode,
    {
      nodeId: "n2",
      propertyOverrides: [{ propertyId: "pr1", text: "Titre" }],
    },
    { nodeId: "n3", choices: [{ value: "a", text: "A" }] },
    { nodeId: "n4", placeholder: "Nom" },
    { nodeId: "n5", value: "Envoyer", waitingText: "..." },
    { nodeId: "n6", value: "Chercher" },
  ];
  const { calls, writes } = await run(
    "updateContent",
    { pageId: "p1", localeId: "loc-fr", nodes },
    () => ({ status: 200, body: { errors: [] } }),
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].path, "/v2/pages/p1/dom");
  assertEquals(calls[0].params, { localeId: "loc-fr" });
  assertEquals(calls[0].body, { nodes });
  assertEquals(writes[0].spec, "contentUpdate");
  assertEquals(writes[0].data.nodeIds, ["n1", "n2", "n3", "n4", "n5", "n6"]);
  assertEquals(writes[0].data.errors, []);
  // Target page, locale and node count are logged before the write.
  assertEquals(events[0].startsWith("log Updating {count} DOM nodes"), true);
  assertEquals(events[0].includes('"localeId":"loc-fr"'), true);
  assertEquals(events[0].includes('"count":6'), true);
  assertEquals(events[1], "fetch POST /v2/pages/p1/dom");
});

Deno.test("updateContent throws on a non-empty errors response after recording it", async () => {
  const { writes } = await runRejects(
    "updateContent",
    { pageId: "p1", localeId: "loc-fr", nodes: [textNode] },
    () => ({ status: 200, body: { errors: ["Node n1 not found"] } }),
    "Node n1 not found",
  );
  assertEquals(writes[0].spec, "contentUpdate");
  assertEquals(writes[0].data.errors, ["Node n1 not found"]);
});

Deno.test("updateContent requires localeId", () => {
  assertThrows(() =>
    method("updateContent").arguments.parse({
      pageId: "p1",
      nodes: [textNode],
    })
  );
});

Deno.test("updateContent enforces 1..1000 nodes", () => {
  const args = method("updateContent").arguments;
  const nodes = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ nodeId: `n${i}`, text: "x" }));
  assertEquals(
    args.safeParse({ pageId: "p1", localeId: "l", nodes: nodes(1000) }).success,
    true,
  );
  assertEquals(
    args.safeParse({ pageId: "p1", localeId: "l", nodes: nodes(1001) }).success,
    false,
  );
  assertEquals(
    args.safeParse({ pageId: "p1", localeId: "l", nodes: [] }).success,
    false,
  );
});

Deno.test("updateContent rejects unknown node fields", () => {
  const args = method("updateContent").arguments;
  for (
    const node of [
      { nodeId: "n1", text: "x", extra: true },
      { nodeId: "n1", html: "x" },
      { text: "x" },
    ]
  ) {
    assertEquals(
      args.safeParse({ pageId: "p1", localeId: "l", nodes: [node] }).success,
      false,
      JSON.stringify(node),
    );
  }
});

Deno.test("a submit button write needs value or waitingText, not both", () => {
  const args = method("updateContent").arguments;
  const parse = (node: Record<string, unknown>) =>
    args.safeParse({ pageId: "p1", localeId: "l", nodes: [node] }).success;
  assertEquals(parse({ nodeId: "n5", waitingText: "Sending..." }), true);
  assertEquals(parse({ nodeId: "n5", value: "Send" }), true);
  assertEquals(parse({ nodeId: "n5" }), false);
});

// --- custom code ------------------------------------------------------------

const existing = [
  { id: "analytics", version: "1.0.0", location: "header" },
  { id: "chat", version: "2.0.0", location: "footer", attributes: { a: "b" } },
];

/** Stateful custom_code endpoint: GET returns the last PUT list. */
function customCodeHandler(initial: Record<string, unknown>[]) {
  let scripts = initial;
  return (call: Call) => {
    if (call.path.endsWith("/custom_code")) {
      if (call.method === "PUT") {
        scripts = (call.body as { scripts: Record<string, unknown>[] })
          .scripts;
        return { status: 200, body: { scripts } };
      }
      if (call.method === "DELETE") {
        scripts = [];
        return { status: 204, body: null };
      }
      return {
        status: 200,
        body: { scripts, lastUpdated: "2026-10-01T00:00:00.000Z" },
      };
    }
    if (call.path.endsWith("/registered_scripts/inline")) {
      return {
        status: 201,
        body: { id: "jsonld-org", displayName: "Org", version: "1.0.0" },
      };
    }
    return { status: 404, body: {} };
  };
}

Deno.test("applyCustomCode merges by id and keeps existing scripts", async () => {
  const { calls, writes } = await run(
    "applyCustomCode",
    {
      pageId: "p1",
      scripts: [
        { id: "chat", version: "2.1.0", location: "footer" },
        { id: "new", version: "1.0.0", location: "header" },
      ],
    },
    customCodeHandler(existing),
  );
  assertEquals(calls.map((c) => c.method), ["GET", "PUT", "GET"]);
  assertEquals(calls[1].path, "/v2/pages/p1/custom_code");
  assertEquals(calls[1].body, {
    scripts: [
      { id: "analytics", version: "1.0.0", location: "header" },
      { id: "chat", version: "2.1.0", location: "footer" },
      { id: "new", version: "1.0.0", location: "header" },
    ],
  });
  assertEquals(
    events.some((e) =>
      e.includes('"mode":"merge","before":2,"after":3') &&
      e.startsWith("log Applying")
    ),
    true,
  );
  assertEquals(writes[0].spec, "customCode");
  assertEquals(writes[0].data.mode, "merge");
  assertEquals((writes[0].data.previousScripts as unknown[]).length, 2);
});

Deno.test("applyCustomCode replace: true sends exactly the given list", async () => {
  const { calls } = await run(
    "applyCustomCode",
    {
      pageId: "p1",
      replace: true,
      scripts: [{ id: "only", version: "1.0.0", location: "header" }],
    },
    customCodeHandler(existing),
  );
  assertEquals(calls[1].body, {
    scripts: [{ id: "only", version: "1.0.0", location: "header" }],
  });
});

Deno.test("applyCustomCode requires at least one script and rejects extra fields", () => {
  const args = method("applyCustomCode").arguments;
  assertEquals(args.safeParse({ pageId: "p1", scripts: [] }).success, false);
  assertEquals(
    args.safeParse({
      pageId: "p1",
      scripts: [{ id: "a", version: "1", location: "header", src: "x" }],
    }).success,
    false,
  );
  assertEquals(
    args.safeParse({
      pageId: "p1",
      scripts: [{ id: "a", version: "1", location: "body" }],
    }).success,
    false,
  );
});

Deno.test("applyCustomCode fails when the read-back is missing the script", async () => {
  await runRejects(
    "applyCustomCode",
    {
      pageId: "p1",
      scripts: [{ id: "new", version: "1.0.0", location: "header" }],
    },
    (call) =>
      call.method === "PUT"
        ? { status: 200, body: {} }
        : { status: 200, body: { scripts: existing } },
    "missing scripts: new@1.0.0",
  );
});

Deno.test("deleteCustomCode logs and records the scripts it removes", async () => {
  const { calls, writes } = await run(
    "deleteCustomCode",
    { pageId: "p1" },
    customCodeHandler(existing),
  );
  assertEquals(calls.map((c) => c.method), ["GET", "DELETE"]);
  assertEquals(calls[1].path, "/v2/pages/p1/custom_code");
  const logIdx = events.findIndex((e) => e.startsWith("log Deleting all"));
  const delIdx = events.indexOf("fetch DELETE /v2/pages/p1/custom_code");
  assertEquals(logIdx >= 0 && logIdx < delIdx, true);
  assertEquals(writes[0].spec, "customCodeDelete");
  assertEquals(
    (writes[0].data.removedScripts as { id: string }[]).map((s) => s.id),
    ["analytics", "chat"],
  );
});

// --- JSON-LD ----------------------------------------------------------------

const org = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Example Co",
  url: "https://www.example.com",
};

Deno.test("addJsonLd registers an inline script and merges it onto the page", async () => {
  const { calls, writes } = await run(
    "addJsonLd",
    {
      siteId: "s1",
      pageId: "p1",
      jsonLd: org,
      displayName: "Org",
      version: "1.0.0",
    },
    customCodeHandler(existing),
  );
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].path, "/v2/sites/s1/registered_scripts/inline");
  assertEquals(calls[0].body, {
    sourceCode: jsonLdSourceCode(org),
    version: "1.0.0",
    displayName: "Org",
  });
  // Registered scripts are JavaScript; an HTML tag here would never render.
  assertEquals(
    (calls[0].body as { sourceCode: string }).sourceCode.includes("<"),
    false,
  );
  assertEquals(calls.slice(1).map((c) => c.method), ["GET", "PUT", "GET"]);
  assertEquals(calls[2].body, {
    scripts: [
      ...existing,
      { id: "jsonld-org", version: "1.0.0", location: "header" },
    ],
  });
  assertEquals(writes.map((w) => w.spec), ["registeredScript", "customCode"]);
  // No jsonLd field is ever sent to the page settings endpoint.
  assertEquals(calls.some((c) => c.path === "/v2/pages/p1"), false);
});

Deno.test("addJsonLd rejects scripts over 2000 characters before any call", async () => {
  const { calls } = await runRejects(
    "addJsonLd",
    {
      siteId: "s1",
      pageId: "p1",
      jsonLd: { ...org, description: "x".repeat(2000) },
      displayName: "Org",
      version: "1.0.0",
    },
    customCodeHandler(existing),
    "limited to 2000",
  );
  assertEquals(calls.length, 0);
});

/** Run the generated script against a fake DOM; return what it appended. */
function injected(src: string): { type: string; text: string } {
  const appended: { type: string; text: string }[] = [];
  const fakeDocument = {
    createElement: (tag: string) => {
      assertEquals(tag, "script");
      return { type: "", text: "" };
    },
    head: {
      appendChild: (el: { type: string; text: string }) => appended.push(el),
    },
  };
  new Function("document", src)(fakeDocument);
  assertEquals(appended.length, 1);
  return appended[0];
}

Deno.test("jsonLdSourceCode is JavaScript that injects an ld+json block", () => {
  const src = jsonLdSourceCode(org);
  assertEquals(src.trimStart().startsWith("<"), false);
  const el = injected(src);
  assertEquals(el.type, "application/ld+json");
  assertEquals(JSON.parse(el.text), org);
});

Deno.test("jsonLdSourceCode contains no < so values cannot close Webflow's tag", () => {
  const value = { name: "</script><b>" };
  const src = jsonLdSourceCode(value);
  assertEquals(src.includes("<"), false);
  assertEquals(JSON.parse(injected(src).text), value);
});

Deno.test("addJsonLd enforces Webflow's displayName rule", () => {
  const args = method("addJsonLd").arguments;
  const base = { siteId: "s1", pageId: "p1", jsonLd: org, version: "1.0.0" };
  assertEquals(
    args.safeParse({ ...base, displayName: "Org Schema 1" }).success,
    true,
  );
  for (const displayName of ["", "x".repeat(51), "org-schema", "org.json"]) {
    assertEquals(
      args.safeParse({ ...base, displayName }).success,
      false,
      displayName,
    );
  }
});

Deno.test("mergeScripts replaces by id in place and appends new ids", () => {
  assertEquals(
    mergeScripts(
      [
        { id: "a", version: "1", location: "header" },
        { id: "b", version: "1", location: "footer" },
      ],
      [
        { id: "a", version: "2", location: "header" },
        { id: "c", version: "1", location: "header" },
      ],
    ).map((s) => `${s.id}@${s.version}`),
    ["a@2", "b@1", "c@1"],
  );
});

Deno.test("page writes are covered by the token check", () => {
  const appliesTo = model.checks["webflow-page-token-valid"].appliesTo;
  for (
    const m of [
      "updateSettings",
      "updateContent",
      "applyCustomCode",
      "deleteCustomCode",
      "addJsonLd",
    ]
  ) {
    assertEquals(appliesTo.includes(m), true, m);
  }
});

Deno.test("custom code without a script version is refused, never PUT back", async () => {
  const { calls } = await runRejects(
    "applyCustomCode",
    {
      pageId: "p1",
      scripts: [{ id: "new", version: "1.0.0", location: "header" }],
    },
    customCodeHandler([{ id: "analytics", location: "header" }]),
    "without a version",
  );
  assertEquals(calls.some((c) => c.method === "PUT"), false);
});

Deno.test("updateSettings logs the page and fields before the PUT", async () => {
  await run(
    "updateSettings",
    { pageId: "p1", title: "About us", seoTitle: "About" },
    () => ({ status: 200, body: { ...page, title: "About us" } }),
  );
  assertEquals(events[0].startsWith("log Updating page settings"), true);
  assertEquals(events[0].includes("title, seo"), true);
  assertEquals(events[1], "fetch PUT /v2/pages/p1");
});
