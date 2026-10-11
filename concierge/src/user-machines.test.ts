import test from "node:test";
import assert from "node:assert/strict";
import { createUserMachines, hashSub, userNameRe } from "./user-machines.js";

test("names embed the user's one-way hash and stay shape-strict", () => {
  const users = createUserMachines();
  const n = users.bind("user-1");
  assert.match(n, /^waddle-u[0-9a-f]{8}-[0-9a-z]{6}$/);
  assert.ok(n.includes(hashSub("user-1")));
  assert.equal(userNameRe().test(n), true);
  assert.equal(userNameRe().test("waddle-standby-1"), false);
  assert.equal(userNameRe().test(`waddle-u${hashSub("user-1")}-short`), false);
  assert.equal(userNameRe().test(`waddle-u${hashSub("user-1").slice(0, 6)}-abcdef`), false, "6-hex fragment no longer matches");
  assert.equal(userNameRe().test(`waddle-u${hashSub("user-1").toUpperCase()}-abcdef`), false);
});

test("bind is sticky per user and mints unique names across users", () => {
  const users = createUserMachines();
  const a1 = users.bind("user-1");
  const a2 = users.bind("user-1");
  const b1 = users.bind("user-2");
  assert.equal(a1, a2, "same user keeps their machine");
  assert.notEqual(a1, b1, "different users get different machines");
  assert.notEqual(hashSub("user-1"), hashSub("user-2"));
});

test("rebind recovers a user's machine after a concierge reboot (memory wipe)", () => {
  // The map is memory-only; the platform scan refills the known-set, and
  // the embedded hash is enough to hand the machine back to its user.
  const first = createUserMachines();
  const name = first.bind("user-1");
  const reborn = createUserMachines(); // fresh process: empty map
  assert.equal(reborn.rebind("user-1"), null, "nothing known yet");
  reborn.adopt([name, "waddle-standby-1", "waddle", "waddle-uabcdef12-zzzzzz-evil"]);
  assert.equal(reborn.rebind("user-1"), name);
  assert.equal(reborn.rebind("user-2"), null);
});

test("adopt is shape-strict and idempotent", () => {
  const users = createUserMachines();
  assert.equal(users.adopt(["waddle", "waddle-standby-1", "waddle-standby-7"]), 0);
  const name = `waddle-u${hashSub("u")}-abc123`; // shape: u<8hex>-<6alnum>
  assert.equal(users.adopt([name]), 1);
  assert.equal(users.adopt([name]), 0);
  assert.ok(users.known().has(name));
});

test("claim binds an existing name (the warm-standby path) and forget clears it", () => {
  const users = createUserMachines();
  users.adopt(["waddle-standby-3"]);
  users.claim("user-1", "waddle-standby-3");
  assert.equal(users.bind("user-1"), "waddle-standby-3");
  assert.ok(users.known().has("waddle-standby-3"));
  users.forget("waddle-standby-3");
  assert.ok(!users.known().has("waddle-standby-3"));
  const fresh = users.bind("user-1");
  assert.match(fresh, /^waddle-u[0-9a-f]{8}-/, "rebound user mints a cattle name");
});

test("rebind prefers the MAP: a claimed standby stays the user's machine across /boots", async () => {
  // A warm-claim name carries no user hash — without map-first rebind,
  // every later /boot handed the user a DIFFERENT standby and orphaned
  // the running one (review-caught).
  const users = createUserMachines();
  users.adopt(["waddle-standby-3"]);
  users.claim("user-1", "waddle-standby-3");
  assert.equal(users.rebind("user-1"), "waddle-standby-3");
  assert.equal(users.rebind("user-1"), "waddle-standby-3", "sticky on repeat calls");
  // And the reboot shape still rebinds hash-named machines:
  const name = users.bind("user-2");
  const reborn = createUserMachines();
  reborn.adopt([name]);
  assert.equal(reborn.rebind("user-2"), name);
});

test("retire tombstones a name — the platform scan cannot resurrect it into rebind", async () => {
  const users = createUserMachines();
  const name = users.bind("user-1");
  users.retire(name);
  assert.equal(users.adopt([name]), 0, "retired names are not adopted back");
  assert.equal(users.rebind("user-1"), null);
  const fresh = users.bind("user-1");
  assert.notEqual(fresh, name);
  // and mint never collides with the tombstone
  assert.ok(!users.known().has(name));
});

test("boundNames distinguishes owned sleepers; adoptedAt is the inheritance clock", async () => {
  const u = createUserMachines();
  const mine = u.bind("sub-a");
  assert.deepEqual([...u.boundNames()], [mine]);
  assert.equal(u.adoptedAt(mine), 0, "minted, not adopted — no clock");
  const before = Date.now();
  const adopted = u.adopt(["waddle-u12345678-abcdef", "waddle-concierge"]);
  assert.equal(adopted, 1, "shape-gated");
  const at = u.adoptedAt("waddle-u12345678-abcdef");
  assert.ok(at >= before && at <= Date.now(), "stamped at adoption");
  assert.ok(!u.boundNames().has("waddle-u12345678-abcdef"), "adopted ≠ bound — the sweep may age it");
  // claim converts adoption into ownership: the clock clears
  u.claim("sub-b", "waddle-u12345678-abcdef");
  assert.ok(u.boundNames().has("waddle-u12345678-abcdef"));
  assert.equal(u.adoptedAt("waddle-u12345678-abcdef"), 0);
});
