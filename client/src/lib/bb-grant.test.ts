import { test } from "node:test";
import assert from "node:assert/strict";
import { machineAnchorId } from "./bb-grant.js";

const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("machineAnchorId is a well-formed name-based (v5-shaped) uuid", async () => {
  const id = await machineAnchorId("879bff47-ea1c-577d-9ac8-1cb6f289b724");
  assert.match(id, UUID_V5, `not a v5-shaped uuid: ${id}`);
});

test("machineAnchorId is stable for the same space", async () => {
  const space = "b7d64543-fe27-5774-a174-a85aeee93a8f";
  assert.equal(await machineAnchorId(space), await machineAnchorId(space));
});

test("machineAnchorId differs per space — the multi-user collision invariant", async () => {
  // The shelf bug this guards against: a fixed anchor collides globally and
  // every account after the first gets a permanent bad_request push
  // rejection (RecordIdCollision). Different spaces MUST derive
  // different ids.
  const ids = await Promise.all(
    [
      "879bff47-ea1c-577d-9ac8-1cb6f289b724",
      "b7d64543-fe27-5774-a174-a85aeee93a8f",
      "00000000-0000-0000-0000-000000000000",
    ].map(machineAnchorId),
  );
  assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids}`);
});

test("machineAnchorId matches the anchor actually shelved for the live prod proof", async () => {
  // Locked to the observed live values (2026-10-09 live enclave proof):
  // if this breaks, the derivation input changed and every existing
  // shelf's manifest/slot ids silently fork.
  assert.equal(
    await machineAnchorId("879bff47-ea1c-577d-9ac8-1cb6f289b724"),
    "b47a6b6c-cdde-556f-a8e6-18d1055a75db",
  );
  assert.equal(
    await machineAnchorId("b7d64543-fe27-5774-a174-a85aeee93a8f"),
    "1c3bf4d6-3b1a-5ee6-a536-1cb68e5e2316",
  );
});
