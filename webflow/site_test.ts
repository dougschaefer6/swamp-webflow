import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { model } from "./site.ts";
import type { WebflowGlobalArgs } from "./_client.ts";

const g: WebflowGlobalArgs = {
  token: "test-key",
  baseUrl: "https://api.example.com/v2",
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

// deno-lint-ignore no-explicit-any
type AnyMethod = { arguments: any; execute: (a: any, c: any) => Promise<any> };
const publish = model.methods.publish as unknown as AnyMethod;

const site = {
  id: "s1",
  customDomains: [
    { id: "d1", url: "www.example.com", lastPublished: null },
    { id: "d2", url: "example.com", lastPublished: null },
  ],
};

/** Run publish against a stub API; records fetches and log lines in order. */
async function runPublish(
  rawArgs: Record<string, unknown>,
  siteBody: Record<string, unknown> = site,
) {
  const calls: Call[] = [];
  const events: string[] = [];
  const writes: Array<
    { spec: string; instance: string; data: Record<string, unknown> }
  > = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    events.push(`fetch ${call.method} ${call.path}`);
    const body = call.path.endsWith("/publish")
      ? {
        customDomains: [],
        publishToWebflowSubdomain: false,
        publishScope: "site",
      }
      : siteBody;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: call.path.endsWith("/publish") ? 202 : 200,
      }),
    );
  }) as typeof fetch;
  const context = {
    globalArgs: g,
    logger: {
      info: (message: string, props?: Record<string, unknown>) =>
        events.push(`log ${message} ${JSON.stringify(props ?? {})}`),
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
    const result = await publish.execute(
      publish.arguments.parse(rawArgs),
      context,
    );
    return { calls, events, writes, result };
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("publish with no domainIds sends every custom domain's id, not its URL", async () => {
  const { calls } = await runPublish({ siteId: "s1" });
  assertEquals(calls.map((c) => `${c.method} ${c.path}`), [
    "GET /v2/sites/s1",
    "POST /v2/sites/s1/publish",
  ]);
  assertEquals(calls[1].body, {
    customDomains: ["d1", "d2"],
    publishToWebflowSubdomain: false,
  });
});

Deno.test("publish passes given domainIds and the subdomain flag through", async () => {
  const { calls } = await runPublish({
    siteId: "s1",
    domainIds: ["d2"],
    publishToWebflowSubdomain: true,
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].body, {
    customDomains: ["d2"],
    publishToWebflowSubdomain: true,
  });
});

Deno.test("publish to the subdomain only omits customDomains", async () => {
  const { calls } = await runPublish(
    { siteId: "s1", publishToWebflowSubdomain: true },
    { id: "s1", customDomains: [] },
  );
  assertEquals(calls[1].body, { publishToWebflowSubdomain: true });
});

Deno.test("publish fails clearly with no custom domains and no subdomain flag", async () => {
  await assertRejects(
    () => runPublish({ siteId: "s1" }, { id: "s1", customDomains: [] }),
    Error,
    "no custom domains",
  );
});

Deno.test("publish logs its targets before the call and records a publishResult", async () => {
  const { events, writes, result } = await runPublish({ siteId: "s1" });
  const post = events.indexOf("fetch POST /v2/sites/s1/publish");
  const intent = events.findIndex((e) => e.startsWith("log Publishing site"));
  assertEquals(intent >= 0 && intent < post, true);
  assertEquals(events[intent].includes("d1, d2"), true);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "publishResult");
  assertEquals(writes[0].instance, "publish-s1");
  assertEquals(writes[0].data.domainIds, ["d1", "d2"]);
  assertEquals(writes[0].data.publishToWebflowSubdomain, false);
  assertEquals(
    (writes[0].data.response as { publishScope: string }).publishScope,
    "site",
  );
  assertEquals(result, {
    dataHandles: [{ spec: "publishResult", instance: "publish-s1" }],
  });
  assertEquals("data" in result, false);
});

Deno.test("publishResult resource has lifetime and garbage collection set", () => {
  const spec = model.resources.publishResult;
  assertEquals(spec.lifetime, "30d");
  assertEquals(spec.garbageCollection, 20);
});

Deno.test("publish with domainIds [] never widens to every custom domain", async () => {
  const { calls } = await runPublish({
    siteId: "s1",
    domainIds: [],
    publishToWebflowSubdomain: true,
  });
  assertEquals(calls.map((c) => `${c.method} ${c.path}`), [
    "POST /v2/sites/s1/publish",
  ]);
  assertEquals(calls[0].body, { publishToWebflowSubdomain: true });
  await assertRejects(
    () => runPublish({ siteId: "s1", domainIds: [] }),
    Error,
    "Nothing to publish",
  );
});

Deno.test("publish rejects the removed domains argument instead of stripping it", () => {
  assertThrows(() =>
    publish.arguments.parse({ siteId: "s1", domains: ["staging.example.com"] })
  );
});
