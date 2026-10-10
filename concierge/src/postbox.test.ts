import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPostboxStore } from "./postbox.js";

function store(opts: Parameters<typeof createPostboxStore>[0] = {}) {
  let t = 1_000_000;
  const s = createPostboxStore({ now: () => t, ...opts });
  const tick = (ms: number) => (t += ms);
  return { s, tick };
}

describe("postbox store", () => {
  it("delivers once (pull-and-clear), replaced mail wins", () => {
    const { s } = store();
    s.post("waddle", "blob-1");
    s.post("waddle", "blob-2"); // a newer autonomous sleep replaces
    assert.equal(s.pull("waddle"), "blob-2");
    assert.equal(s.pull("waddle"), null, "one delivery — the mailbox is empty after");
  });

  it("expired mail is dropped, not delivered", () => {
    const { s, tick } = store({ ttlMs: 60_000 });
    s.post("waddle", "blob");
    tick(60_001);
    assert.equal(s.pull("waddle"), null);
    assert.equal(s.status("waddle").held, false);
  });

  it("clear wipes held mail (revocation)", () => {
    const { s } = store();
    s.post("waddle", "blob");
    s.clear("waddle");
    assert.equal(s.pull("waddle"), null);
  });

  it("status reports presence with age, never the blob", () => {
    const { s, tick } = store();
    assert.deepEqual(s.status("waddle"), { held: false, posted_ms_ago: null });
    s.post("waddle", "blob");
    tick(1_000);
    const st = s.status("waddle");
    assert.equal(st.held, true);
    assert.equal(st.posted_ms_ago, 1_000);
  });

  it("empty blobs are rejected (a mail row must be real ciphertext)", () => {
    const { s } = store();
    assert.throws(() => s.post("waddle", ""));
  });
});
