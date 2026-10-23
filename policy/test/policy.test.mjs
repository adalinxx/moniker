// Runs the built policy module the way the Lattice host does (host.mjs).
// Bodies are encoded by the SDK, whose encoding is pinned to Lattice's vectors.
//
//   cargo build --release --target wasm32-unknown-unknown
//   LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/policy.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { context as hostContext, validate } from "./host.mjs";

const core = await import(process.env.LATTICE_SDK_CORE);
const { encodeTransactionBody } = core;

/** A fixed account address, so recorded contexts are reproducible. */
const address = (seed) => core.addressFromPublicKey(core.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));
const ALICE = address(1);
const BOB = address(2);
const CAROL = address(3);
const PATH = ["Nexus", "moniker"];

const context = (bodyBytes, options = {}) => hostContext(bodyBytes, { path: PATH, ...options });

// With CONTEXT_DIR set, every context is recorded with its verdict so
// host-check can replay it through Lattice's own evaluator.
const contextDirectory = process.env.CONTEXT_DIR;
if (contextDirectory) mkdirSync(contextDirectory, { recursive: true });
let recorded = 0;

function run(bytes) {
  const accepted = validate(bytes);
  if (contextDirectory) {
    const name = `${String(recorded++).padStart(3, "0")}-${accepted ? "accept" : "reject"}.bin`;
    writeFileSync(`${contextDirectory}/${name}`, bytes);
  }
  return accepted;
}

function body(actions, signers, accountActions = []) {
  return encodeTransactionBody({
    accountActions,
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers,
    nonce: 7n,
    chainPath: PATH,
  }).bytes;
}

const signedBy = (signers, actions, accountActions) => run(context(body(actions, signers, accountActions)));
const pay = (from, to, amount) => [
  { owner: from, delta: -amount },
  { owner: to, delta: amount },
];
const name = (handle) => `name/${handle}`;
const names = (owner, handle) => `names/${owner}/${handle}`;
const P = "abcdefghijklmnop"; // a profile id, which is not an account

/** `name/<handle>` rewritten to its value: who owns the name, for the policy. */
const held = (handle, value) => ({ key: name(handle), oldValue: value, newValue: value });
/** `points/<handle>` set to account `to` (or deleted), from `old`. */
const point = (handle, to, old) => ({ key: `points/${handle}`, ...(old && { oldValue: old }), ...(to && { newValue: to }) });
/** Name `handle` claimed by account `owner`, with its `names/` key and its pointer (`at` the owner, or none if null). */
const claim = (handle, owner, price, at = owner) => [
  { key: name(handle), newValue: price === undefined ? owner : `${owner}@${price}` },
  { key: names(owner, handle), newValue: "1" },
  ...(at === null ? [] : [point(handle, at)]),
];
/** Name `handle` moved from account `from` (value `old`) to account `to` (value `fresh`), with its `names/` keys and the new owner's pointer (`at` it, or none if null). */
const move = (handle, from, old, to, fresh = to, at = to) => [
  { key: name(handle), oldValue: old, newValue: fresh },
  { key: names(from, handle), oldValue: "1" },
  { key: names(to, handle), newValue: "1" },
  ...(at === null ? [] : [point(handle, at)]),
];
/** Name `handle` released by account `owner`, with its `names/` key. */
const release = (handle, owner) => [
  { key: name(handle), oldValue: owner },
  { key: names(owner, handle), oldValue: "1" },
];

test("an account writes, edits and deletes its own records", () => {
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/key.x25519`, newValue: "abcd" }]));
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/key.x25519`, oldValue: "abcd", newValue: "ef" }]));
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/key.x25519`, oldValue: "ef" }]));
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/app.fanfare.anything/a/b`, newValue: "x" }]));
});

test("nobody writes or deletes another account's records", () => {
  assert.ok(!signedBy([BOB], [{ key: `user/${ALICE}/key.x25519`, newValue: "x" }]));
  assert.ok(!signedBy([BOB], [{ key: `user/${ALICE}/key.x25519`, oldValue: "x" }]));
  assert.ok(!signedBy([ALICE], [{ key: `user/${ALICE}/a`, newValue: "x" }, { key: `user/${BOB}/a`, newValue: "x" }]));
});

test("keys outside the shapes are rejected", () => {
  for (const key of ["user", "user/", ALICE, `index/topic/${ALICE}`, `users/${ALICE}`, `/user/${ALICE}`, "name", "name/", `names/${P}/alice`, `names/${ALICE}`, "points", "points/", "points/Alice", "points/al-ice", "point/alice", `card/${P}`]) {
    assert.ok(!signedBy([ALICE], [{ key, newValue: "1" }]), key);
  }
});

test("profile, owns/ and about/ keys are no longer Moniker's: refused", () => {
  const keys = [`profile/${P}`, `owns/${ALICE}/${P}`, `about/${P}/card`, `about/${P}/admin/${BOB}`, `about/${P}/name`];
  for (const key of keys) {
    for (const change of [{ newValue: ALICE }, { newValue: "1" }, { oldValue: ALICE, newValue: ALICE }, { oldValue: "1" }]) {
      assert.ok(!signedBy([ALICE], [{ key, ...change }]), `${key} ${JSON.stringify(change)}`);
    }
  }
  // Not the old create pair, not after a name the account holds, not between a name and its pointer.
  assert.ok(!signedBy([ALICE], [{ key: `profile/${P}`, newValue: ALICE }, { key: `owns/${ALICE}/${P}`, newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [held("alice", ALICE), { key: `about/${P}/card`, newValue: "{}" }]));
  assert.ok(!signedBy([ALICE], [...claim("alice", ALICE), { key: `owns/${ALICE}/${P}`, newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [held("alice", ALICE), { key: `profile/${P}`, oldValue: ALICE, newValue: ALICE }, point("alice", ALICE)]));
});

test("a key is at most 512 bytes and a value written at most 16 KiB", () => {
  const key = (bytes) => `user/${ALICE}/`.padEnd(bytes, "k");
  assert.ok(signedBy([ALICE], [{ key: key(512), newValue: "x".repeat(16 * 1024) }]));
  assert.ok(!signedBy([ALICE], [{ key: key(513), newValue: "x" }]));
  assert.ok(!signedBy([ALICE], [{ key: key(100), newValue: "x".repeat(16 * 1024 + 1) }]));
  // Bytes, not characters.
  assert.ok(!signedBy([ALICE], [{ key: key(100), newValue: "é".repeat(8 * 1024 + 1) }]));
  // An old value is the chain's, so its size is not the writer's to answer for.
  assert.ok(signedBy([ALICE], [{ key: key(100), oldValue: "x".repeat(20000) }]));
});

test("a transaction claims at most one free name", () => {
  assert.ok(!signedBy([ALICE], [...claim("a1", ALICE), ...claim("a2", ALICE)]));
  assert.ok(!signedBy([ALICE, BOB], [...claim("a1", ALICE), ...claim("b1", BOB)]));
  // One claim beside other name writes is fine.
  assert.ok(signedBy([ALICE], [...claim("a1", ALICE), held("a2", ALICE), ...release("a3", ALICE)]));
});

test("coin actions pass untouched", () => {
  assert.ok(signedBy([ALICE], []));
  assert.ok(signedBy([ALICE], [], pay(ALICE, BOB, 998n)));
});

test("a malformed or unknown context is rejected", () => {
  const good = body([{ key: `user/${ALICE}/a`, newValue: "{}" }], [ALICE]);
  assert.ok(run(context(good)));
  assert.ok(!run(context(good, { version: 1 })));
  assert.ok(!run(context(undefined)));
  assert.ok(!run(context(good.slice(0, good.length - 3))));
  assert.ok(!run(context(good).slice(0, 40)));
  assert.ok(!run(new Uint8Array(0)));
});

// ---------------------------------------------------------------- names

test("an account claims a free name for itself", () => {
  assert.ok(signedBy([ALICE], claim("alice", ALICE)));
  assert.ok(signedBy([ALICE], claim("alice_2", ALICE, 500)));
  // For someone else, or without names/: refused.
  assert.ok(!signedBy([ALICE], claim("alice", BOB)));
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue: ALICE }]));
  // A name's owner is an account, never a profile id or anything else.
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue: P }, { key: names(ALICE, "alice"), newValue: "1" }]));
  for (const owner of ["alice", ALICE.toUpperCase(), ALICE.slice(0, 58), `${ALICE}@`, `${ALICE}@01`, `${ALICE}@1@2`]) {
    assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue: owner }, { key: names(ALICE, "alice"), newValue: "1" }]), owner);
  }
});

test("a handle is lowercase letters, digits and underscore", () => {
  for (const handle of ["", "Alice", "al-ice", "al.ice", "al ice", "alicé", "ALICE"]) {
    assert.ok(!signedBy([ALICE], claim(handle, ALICE)), handle);
  }
  // As long as its names/<account>/ key allows: 512 bytes, 446 for the handle.
  assert.ok(signedBy([ALICE], claim("a".repeat(446), ALICE)));
  assert.ok(!signedBy([ALICE], claim("a".repeat(447), ALICE)));
});

test("the owner prices, unprices, gives and releases a name", () => {
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE, newValue: `${ALICE}@500` }]));
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: `${ALICE}@500`, newValue: ALICE }]));
  // To another account only with its signature.
  assert.ok(!signedBy([ALICE], move("alice", ALICE, ALICE, BOB)));
  assert.ok(signedBy([ALICE, BOB], move("alice", ALICE, ALICE, BOB)));
  // Released, with its names/ key.
  assert.ok(signedBy([ALICE], release("alice", ALICE)));
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: `${ALICE}@5` }, { key: names(ALICE, "alice"), oldValue: "1" }]));
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE }]));
});

test("nobody else changes or releases a name", () => {
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: ALICE, newValue: `${ALICE}@1` }]));
  assert.ok(!signedBy([BOB], release("alice", ALICE)));
  assert.ok(!signedBy([BOB], move("alice", ALICE, ALICE, BOB), pay(BOB, ALICE, 10n ** 6n)));
  // A name with neither an old nor a new value is no write.
  assert.ok(!signedBy([ALICE], [{ key: name("alice") }]));
});

test("anyone may write a name unchanged: it only shows who owns it", () => {
  assert.ok(signedBy([CAROL], [held("alice", ALICE)]));
  assert.ok(signedBy([CAROL], [held("alice", `${ALICE}@5`)]));
  // Unchanged still means well formed.
  assert.ok(!signedBy([CAROL], [held("alice", "junk")]));
  assert.ok(!signedBy([CAROL], [held("alice", P)]));
});

test("anyone buys a priced name, paying its owner", () => {
  const listed = `${ALICE}@500`;
  const buy = move("alice", ALICE, listed, BOB);
  assert.ok(signedBy([BOB], buy, pay(BOB, ALICE, 500n)));
  assert.ok(signedBy([BOB], move("alice", ALICE, listed, BOB, `${BOB}@900`), pay(BOB, ALICE, 600n)));
  // Underpaid, paid to someone else, unpaid, or debited from the seller: refused.
  assert.ok(!signedBy([BOB], buy, pay(BOB, ALICE, 499n)));
  assert.ok(!signedBy([BOB], buy, pay(BOB, CAROL, 500n)));
  assert.ok(!signedBy([BOB], buy));
  assert.ok(!signedBy([BOB], buy, [{ owner: ALICE, delta: -500n }]));
  // Onto an account that doesn't sign: refused.
  assert.ok(!signedBy([BOB], move("alice", ALICE, listed, CAROL), pay(BOB, ALICE, 500n)));
  // A price of 0 is a giveaway.
  assert.ok(signedBy([BOB], move("alice", ALICE, `${ALICE}@0`, BOB)));
  // Not for sale: refused whatever is paid.
  assert.ok(!signedBy([BOB], move("alice", ALICE, ALICE, BOB), pay(BOB, ALICE, 10n ** 6n)));
});

test("one payment covers one price, per seller", () => {
  const two = [...move("a1", ALICE, `${ALICE}@250`, CAROL), ...move("a2", ALICE, `${ALICE}@250`, CAROL)];
  assert.ok(!signedBy([CAROL], two, pay(CAROL, ALICE, 250n)));
  assert.ok(signedBy([CAROL], two, pay(CAROL, ALICE, 500n)));
  const twoSellers = [...move("a1", ALICE, `${ALICE}@250`, CAROL), ...move("b1", BOB, `${BOB}@100`, CAROL)];
  assert.ok(!signedBy([CAROL], twoSellers, pay(CAROL, ALICE, 350n)));
  const paid = [{ owner: CAROL, delta: -350n }, { owner: ALICE, delta: 250n }, { owner: BOB, delta: 100n }];
  assert.ok(signedBy([CAROL], twoSellers, paid));
  // Sellers are credited in the order they are first paid.
  assert.ok(!signedBy([CAROL], twoSellers, [paid[0], paid[2], paid[1]]));
  // A seller's purchases come together: a seller paid again later needs a credit of its own.
  const back = [...twoSellers, ...move("a3", ALICE, `${ALICE}@50`, CAROL)];
  assert.ok(!signedBy([CAROL], back, [{ owner: CAROL, delta: -400n }, { owner: ALICE, delta: 300n }, { owner: BOB, delta: 100n }]));
  assert.ok(signedBy([CAROL], back, [{ owner: CAROL, delta: -400n }, { owner: ALICE, delta: 250n }, { owner: BOB, delta: 100n }, { owner: ALICE, delta: 50n }]));
  // A free purchase in between owes nothing and doesn't split a seller's run.
  const free = [...move("a1", ALICE, `${ALICE}@5`, CAROL), ...move("b1", BOB, `${BOB}@0`, CAROL), ...move("a2", ALICE, `${ALICE}@5`, CAROL)];
  assert.ok(signedBy([CAROL], free, pay(CAROL, ALICE, 10n)));
});

test("a price is one a credit can pay", () => {
  assert.ok(signedBy([ALICE], claim("alice", ALICE, "9223372036854775807")));
  assert.ok(!signedBy([ALICE], claim("alice", ALICE, "9223372036854775808")));
});

// ---------------------------------------------------------------- offers

test("a name offered to an account is taken by it for nothing", () => {
  const offered = `${ALICE}>${BOB}`;
  assert.ok(signedBy([ALICE], [{ key: name("gift"), oldValue: ALICE, newValue: offered }]));
  assert.ok(signedBy([BOB], move("gift", ALICE, offered, BOB)));
  // Not by anyone else, and the offer can be taken back.
  assert.ok(!signedBy([CAROL], move("gift", ALICE, offered, CAROL)));
  assert.ok(signedBy([ALICE], [{ key: name("gift"), oldValue: offered, newValue: ALICE }]));
  assert.ok(!signedBy([BOB], [{ key: name("gift"), oldValue: offered, newValue: ALICE }]));
});

test("an offer is to someone else, and well formed", () => {
  for (const value of [`${ALICE}>${ALICE}`, `${ALICE}>${P}`, `${ALICE}>`, `${ALICE}@5>${BOB}`]) {
    assert.ok(!signedBy([ALICE], [{ key: name("gift"), oldValue: ALICE, newValue: value }]), value);
  }
});

test("nobody else changes the terms of a name they don't take", () => {
  // Paying the price buys the name: it may not stay with its owner on other terms.
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: `${ALICE}@5`, newValue: ALICE }], pay(BOB, ALICE, 5n)));
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: `${ALICE}@0`, newValue: `${ALICE}@9` }]));
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: `${ALICE}@0`, newValue: ALICE }]));
});

// ---------------------------------------------------------------- indexes

test("names/ keys change only with their name, and only the right way", () => {
  assert.ok(!signedBy([ALICE], [{ key: names(ALICE, "alice"), newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [{ key: names(ALICE, "alice"), oldValue: "1" }]));
  assert.ok(!signedBy([ALICE], [held("alice", ALICE), { key: names(ALICE, "alice"), oldValue: "1" }]));
  // Not for another name, or an account the name did not reach or leave.
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue: ALICE }, { key: names(ALICE, "bob"), newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue: ALICE }, { key: names(BOB, "alice"), newValue: "1" }]));
  // A price change moves nothing, and may not touch an index key.
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE, newValue: `${ALICE}@9` }, { key: names(ALICE, "alice"), newValue: "1" }]));
  // The value is 1; an overwrite or an empty write is no move.
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue: ALICE }, { key: names(ALICE, "alice"), newValue: "yes" }]));
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue: ALICE }, { key: names(ALICE, "alice"), oldValue: "1", newValue: "1" }]));
});

test("index keys come directly after their name, the one it leaves first", () => {
  const moved = move("art", ALICE, ALICE, BOB);
  assert.ok(signedBy([ALICE, BOB], moved));
  assert.ok(!signedBy([ALICE, BOB], [moved[0], moved[2], moved[1]]));
  assert.ok(!signedBy([ALICE, BOB], moved.slice(0, 2)));
  assert.ok(!signedBy([ALICE, BOB], [moved[0], moved[1], { key: `user/${ALICE}/x`, newValue: "1" }, moved[2]]));
  // A pointer doesn't come before the index keys are done.
  assert.ok(!signedBy([ALICE, BOB], [moved[0], point("art", BOB), moved[1], moved[2]]));
  assert.ok(!signedBy([ALICE, BOB], [moved[0], moved[1], point("art", BOB), moved[2]]));
});

// ---------------------------------------------------------------- pointers

test("an account shows a handle with its own user/<a>/name record", () => {
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/name`, newValue: "alice" }]));
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/name`, oldValue: "alice", newValue: "al" }]));
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/name`, oldValue: "al" }]));
  // With the name it claims and points at itself, in one transaction.
  assert.ok(signedBy([ALICE], [...claim("alice", ALICE), { key: `user/${ALICE}/name`, newValue: "alice" }]));
  // Nobody else writes or deletes it.
  assert.ok(!signedBy([BOB], [{ key: `user/${ALICE}/name`, newValue: "bob" }]));
  assert.ok(!signedBy([BOB], [{ key: `user/${ALICE}/name`, oldValue: "alice" }]));
  assert.ok(!signedBy([BOB], [held("alice", ALICE), { key: `user/${ALICE}/name`, newValue: "alice" }]));
});

test("a name's owner points it at any account, right after the name", () => {
  assert.ok(signedBy([ALICE], [held("alice", ALICE), point("alice", ALICE)]));
  assert.ok(signedBy([ALICE], [held("alice", ALICE), point("alice", BOB)]));
  assert.ok(signedBy([ALICE], claim("alice", ALICE, undefined, CAROL)));
  // Re-pointed and deleted, on a priced name too.
  assert.ok(signedBy([ALICE], [held("alice", ALICE), point("alice", BOB, ALICE)]));
  assert.ok(signedBy([ALICE], [held("alice", ALICE), point("alice", undefined, BOB)]));
  assert.ok(signedBy([ALICE], [held("alice", `${ALICE}@5`), point("alice", ALICE, BOB)]));
  // Two names, each followed by its own pointer.
  assert.ok(signedBy([ALICE], [held("alice", ALICE), point("alice", ALICE), held("al", ALICE), point("al", BOB)]));
  // A deletion has something to delete.
  assert.ok(!signedBy([ALICE], [held("alice", ALICE), { key: "points/alice" }]));
});

test("a pointer comes only right after its own name", () => {
  // Without the name before it.
  assert.ok(!signedBy([ALICE], [point("alice", ALICE)]));
  assert.ok(!signedBy([ALICE], [point("alice", ALICE), held("alice", ALICE)]));
  // Another key in between.
  assert.ok(!signedBy([ALICE], [held("alice", ALICE), { key: `user/${ALICE}/x`, newValue: "1" }, point("alice", ALICE)]));
  // For a different handle.
  assert.ok(!signedBy([ALICE], [held("bob", ALICE), point("alice", ALICE)]));
  assert.ok(!signedBy([ALICE], [held("alice", ALICE), point("alice", ALICE), point("bob", ALICE)]));
  assert.ok(!signedBy([ALICE], [held("alice", ALICE), point("alice_", ALICE)]));
});

test("only the name's owner points it", () => {
  assert.ok(!signedBy([BOB], [held("alice", ALICE), point("alice", BOB)]));
  assert.ok(!signedBy([BOB], [held("alice", ALICE), point("alice", undefined, ALICE)]));
  assert.ok(!signedBy([BOB], [held("alice", `${ALICE}@5`), point("alice", BOB)]));
  // A name offered to Bob is still Alice's until Bob takes it.
  assert.ok(!signedBy([BOB], [held("alice", `${ALICE}>${BOB}`), point("alice", BOB)]));
});

test("a pointer is the one key points/<handle>: anything after the handle is refused", () => {
  for (const key of [`points/alice/Nexus`, `points/alice/Nexus/testnet/rave-186079`, "points/alice/", `points/alice/${ALICE}`]) {
    assert.ok(!signedBy([ALICE], [held("alice", ALICE), { key, newValue: ALICE }]), key);
    assert.ok(!signedBy([ALICE], [held("alice", ALICE), { key, oldValue: ALICE }]), key);
  }
});

test("a pointer's value is an account address", () => {
  for (const value of [P, "", "x", "alice", ALICE.toUpperCase(), ALICE.slice(0, 58), `${ALICE}x`, `${ALICE}@5`, `${ALICE}>${BOB}`]) {
    assert.ok(!signedBy([ALICE], [held("alice", ALICE), point("alice", value)]), value);
  }
});

test("a release deletes the name's pointer, and sets none", () => {
  assert.ok(signedBy([ALICE], [...release("alice", ALICE), point("alice", undefined, ALICE)]));
  assert.ok(signedBy([ALICE], [...release("alice", ALICE), point("alice", undefined, BOB)]));
  assert.ok(!signedBy([ALICE], [...release("alice", ALICE), point("alice", BOB, ALICE)]));
  assert.ok(!signedBy([ALICE], [...release("alice", ALICE), point("alice", ALICE)]));
  // The pointer comes after the names/ key the release calls for.
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE }, point("alice", undefined, ALICE), { key: names(ALICE, "alice"), oldValue: "1" }]));
});

test("a name that comes to a new owner is pointed by it, right after its index keys", () => {
  const listed = `${ALICE}@500`;
  const buy = (at) => [...move("alice", ALICE, listed, BOB, BOB, null), at];
  // Set, re-set from the seller's pointer, or the seller's pointer cleared.
  assert.ok(signedBy([BOB], buy(point("alice", BOB)), pay(BOB, ALICE, 500n)));
  assert.ok(signedBy([BOB], buy(point("alice", BOB, ALICE)), pay(BOB, ALICE, 500n)));
  assert.ok(signedBy([BOB], buy(point("alice", undefined, ALICE)), pay(BOB, ALICE, 500n)));
  assert.ok(signedBy([BOB], move("gift", ALICE, `${ALICE}>${BOB}`, BOB, BOB, ALICE)));
  // Without it, a pointer an owner before left would survive: refused.
  assert.ok(!signedBy([BOB], move("alice", ALICE, listed, BOB, BOB, null), pay(BOB, ALICE, 500n)));
  assert.ok(!signedBy([ALICE], claim("alice", ALICE, undefined, null)));
  assert.ok(!signedBy([ALICE, BOB], move("alice", ALICE, ALICE, BOB, BOB, null)));
  // A claim clears a pointer a release left behind.
  assert.ok(signedBy([ALICE], [...claim("alice", ALICE, undefined, null), point("alice", undefined, CAROL)]));
  // Not after another key, and not for another name.
  assert.ok(!signedBy([ALICE], [...claim("alice", ALICE, undefined, null), { key: `user/${ALICE}/x`, newValue: "1" }, point("alice", ALICE)]));
  assert.ok(!signedBy([ALICE], [...claim("alice", ALICE, undefined, null), point("bob", ALICE)]));
  // Kept by its owner (a new price, an offer), or released: no pointer needed.
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE, newValue: listed }]));
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE, newValue: `${ALICE}>${BOB}` }]));
  assert.ok(signedBy([ALICE], release("alice", ALICE)));
  // Without taking it, the would-be buyer can't point it.
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: ALICE, newValue: ALICE }, point("alice", BOB)], pay(BOB, ALICE, 500n)));
});

// ---------------------------------------------------------------- scaling

test("the work grows with the transaction, no faster", () => {
  // Many free names taken and pointed in one transaction: every check looks
  // only at the actions just before, so twice the actions take about twice the time.
  const time = (n) => {
    const actions = [];
    for (let i = 0; i < n; i++) actions.push(...move(`h${i}`, ALICE, `${ALICE}@0`, BOB));
    const bytes = context(body(actions, [BOB]));
    const start = performance.now();
    assert.ok(validate(bytes));
    return performance.now() - start;
  };
  time(500);
  const [small, large] = [time(2000), time(8000)];
  assert.ok(large < small * 8, `${small.toFixed(1)}ms for 2000, ${large.toFixed(1)}ms for 8000`);
});

test("many signers: each check is a lookup, not a walk of the signers", () => {
  // Thousands of signers (repeated ones too) and thousands of own-record
  // writes, each asking whether its account signs.
  const time = (n) => {
    const key = (i) => core.addressFromPublicKey(core.publicKeyFromPrivate(Uint8Array.from({ length: 32 }, (_, b) => (b < 2 ? (i >> (8 * b)) & 255 : 7))));
    const signers = Array.from({ length: n }, (_, i) => key(i % (n / 2)));
    const actions = Array.from({ length: n }, (_, i) => ({ key: `user/${signers[i]}/k${i}`, newValue: "1" }));
    const bytes = context(body(actions, signers));
    const start = performance.now();
    assert.ok(validate(bytes));
    assert.ok(!validate(context(body([...actions, { key: `user/${CAROL}/x`, newValue: "1" }], signers))));
    return performance.now() - start;
  };
  time(500);
  const [small, large] = [time(1000), time(4000)];
  assert.ok(large < small * 8, `${small.toFixed(1)}ms for 1000, ${large.toFixed(1)}ms for 4000`);
});

test("signers: any order, repeats fine, each an address", () => {
  const write = [{ key: `user/${ALICE}/x`, newValue: "1" }];
  assert.ok(signedBy([BOB, CAROL, ALICE], write));
  assert.ok(signedBy([ALICE, ALICE, BOB, ALICE], write));
  assert.ok(!signedBy([BOB, CAROL], write));
  // An owner that only shares a signer's prefix, or extends it, is not that signer.
  assert.ok(!signedBy([ALICE], [{ key: `user/${ALICE.slice(0, 58)}/x`, newValue: "1" }]));
  // A signer that isn't an address: refused.
  assert.ok(!signedBy([ALICE, "bafyrei"], write));
  // Many addresses: every one is found, and no other.
  const many = Array.from({ length: 240 }, (_, i) => address(10 + i));
  for (const who of [many[0], many[120], many[239]]) assert.ok(signedBy(many, [{ key: `user/${who}/x`, newValue: "1" }]));
  assert.ok(!signedBy(many, write));
});
