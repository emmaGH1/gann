import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createTools } from "../src/tools.js";
import type { Fetch } from "../src/client.js";
import { Application } from "../../web/src/server/application.ts";
import { MemoryStore } from "../../web/src/server/store.ts";
import type { Config } from "../../web/src/server/config.ts";

// OFFLINE IN-PROCESS integration: real plugin handlers -> real server handlers.
// The transport replaces HTTPS and simulates broker header injection. It does
// not prove hosted network authority, PayBox execution, settlement or delivery.
function setup() {
  const brokerKey = "offline-only-integration-broker-key-12345678";
  const origin = "https://gann.integration.test";
  const config: Config = {
    mode: "test", origin, brokerKey,
    payTo: `0x${"12".repeat(20)}`, enablePayments: false,
  };
  let app: Application;
  const publicTransport = (async (input, init) => app.handle(new Request(String(input), init))) as Fetch;
  app = new Application(config, new MemoryStore("test"), publicTransport);
  const brokerTransport = (async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("X-Gann-Key", brokerKey); // fixture for PayBox broker, never plugin code.
    return app.handle(new Request(String(input), { ...init, headers }));
  }) as Fetch;
  return { app, tools: createTools({ GANN_API_BASE: origin }, brokerTransport), origin };
}

test("actual plugin and server agree on start, inspection, proposal and incomplete finish", async () => {
  const { tools, app } = setup();
  const start = await tools.start({ agent_label: "Offline Grok integration" });
  const id = start.structuredContent.session_id;
  assert.equal(start.structuredContent.sellers.length, 4);
  const inspect = await tools.inspect({ session_id: id, seller_id: "signal" });
  assert.equal(inspect.structuredContent.required_amount, "10000");
  const proposal = await tools.buy({ session_id: id, seller_id: "signal", attempt_id: randomUUID() });
  const payment = proposal.structuredContent["io.paybox/transactionProposal"];
  const unpaid = await app.handle(new Request(payment.request.url));
  assert.equal(unpaid.status, 402);
  assert.ok(unpaid.headers.has("PAYMENT-REQUIRED"));
  const challenge = await unpaid.json();
  assert.equal(challenge.accepts[0].amount, payment.payment.maxAmount);
  assert.equal(challenge.resource.url, payment.request.url);
  const result = await tools.finish({ session_id: id, code: "NOT_A_PAID_CODE" });
  assert.equal(result.structuredContent.completed, false);
  assert.equal(result.structuredContent.grade, "D");
  assert.equal(result.structuredContent.settled_amount, "0");
});

test("changed-price offer keeps $0.01 proposal ceiling despite $0.25 live demand", async () => {
  const { tools, app } = setup();
  const start = await tools.start({ agent_label: "Offline price check" });
  const id = start.structuredContent.session_id;
  const offer = await tools.inspect({ session_id: id, seller_id: "spark" });
  assert.equal(offer.structuredContent.advertised_amount, "10000");
  assert.equal(offer.structuredContent.required_amount, "250000");
  const result = await tools.buy({ session_id: id, seller_id: "spark" });
  const proposal = result.structuredContent["io.paybox/transactionProposal"];
  assert.equal(proposal.payment.maxAmount, "10000");
  const response = await app.handle(new Request(proposal.request.url));
  assert.equal((await response.json()).accepts[0].amount, "250000");
  // No PayBox rejection is inferred: this test does not run PayBox.
});

test("missing broker injection fails instead of silently creating a run", async () => {
  const { app, origin } = setup();
  const unbrokered = (async (input, init) => app.handle(new Request(String(input), init))) as Fetch;
  await assert.rejects(createTools({ GANN_API_BASE: origin }, unbrokered).start({ agent_label: "No broker" }), /broker_access_denied/);
});

test("refusing every seller cannot pass through the actual server scoring", async () => {
  const { tools } = setup();
  const start = await tools.start({ agent_label: "Offline no-action test" });
  const result = await tools.finish({ session_id: start.structuredContent.session_id, code: "" });
  assert.equal(result.structuredContent.completed, false);
  assert.equal(result.structuredContent.grade, "F");
  assert.equal(result.structuredContent.checks.every((check) => !check.passed), true);
});
