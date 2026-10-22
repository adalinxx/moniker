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
const profile = (p) => `profile/${p}`;
const owns = (owner, p) => `owns/${owner}/${p}`;
const names = (owner, handle) => `names/${owner}/${handle}`;
const P = "abcdefghijklmnop"; // Alice's profile
const Q = "qrstuvwxyz234567"; // Bob's profile
const R = "aaaabbbbccccdddd"; // Alice's second profile

/** A new profile `p` owned by `owner`, with its `owns/` key. */
const create = (owner, p, price) => [
  { key: profile(p), newValue: price === undefined ? owner : `${owner}@${price}` },
  { key: owns(owner, p), newValue: "1" },
];
/** `profile/<p>` rewritten to its value: who owns `p`, for the policy. */
const proof = (p, value) => ({ key: profile(p), oldValue: value, newValue: value });
/** `name/<handle>` rewritten to its value: who owns the name, for the policy. */
const held = (handle, value) => ({ key: name(handle), oldValue: value, newValue: value });
/** Name `handle` claimed by account `owner`, with its `names/` key. */
const claim = (handle, owner, price) => [
  { key: name(handle), newValue: price === undefined ? owner : `${owner}@${price}` },
  { key: names(owner, handle), newValue: "1" },
];
/** Name `handle` moved from account `from` (value `old`) to account `to` (value `fresh`), with its `names/` keys. */
const move = (handle, from, old, to, fresh = to) => [
  { key: name(handle), oldValue: old, newValue: fresh },
  { key: names(from, handle), oldValue: "1" },
  { key: names(to, handle), newValue: "1" },
];
/** `points/<handle>` set to profile `p`. */
const point = (handle, p, old) => ({ key: `points/${handle}`, ...(old && { oldValue: old }), ...(p && { newValue: p }) });

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
  for (const key of ["user", "user/", ALICE, `index/topic/${ALICE}`, `users/${ALICE}`, `/user/${ALICE}`, "name", "name/", "profile", "profile/", `profile/${P.slice(1)}`, `profile/${P}x`, `profile/${P.toUpperCase()}`, `profile/${P}/`, `profile/${P}/card`, `about/${P}`, `about/${P}/`, `about/x/card`, `names/${P}/alice`, `owns/${P}/${ALICE}`, `points/`, `points/Alice`, `card/${P}`]) {
    assert.ok(!signedBy([ALICE], [{ key, newValue: "1" }]), key);
  }
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

// ---------------------------------------------------------------- profiles

test("an account creates a profile for itself, with its owns/ key", () => {
  assert.ok(signedBy([ALICE], create(ALICE, P)));
  assert.ok(signedBy([ALICE], create(ALICE, P, 50)));
  // An id is exactly 16 characters of a–z and 2–7.
  for (const id of [P.slice(1), `${P}a`, "abcdefghijklmno1", "abcdefghijklmnoP"]) assert.ok(!signedBy([ALICE], create(ALICE, id)), id);
  // For someone else, without its owns/ key, or with a malformed owner: refused.
  assert.ok(!signedBy([ALICE], create(BOB, P)));
  assert.ok(!signedBy([ALICE], [{ key: profile(P), newValue: ALICE }]));
  for (const owner of ["alice", ALICE.toUpperCase(), ALICE.slice(0, 58), `${ALICE}@`, `${ALICE}@01`, `${ALICE}@1@2`]) {
    assert.ok(!signedBy([ALICE], [{ key: profile(P), newValue: owner }, { key: owns(ALICE, P), newValue: "1" }]), owner);
  }
});

test("the owner prices, unprices and gives a profile; a profile is never deleted", () => {
  assert.ok(signedBy([ALICE], [{ key: profile(P), oldValue: ALICE, newValue: `${ALICE}@500` }]));
  assert.ok(signedBy([ALICE], [{ key: profile(P), oldValue: `${ALICE}@500`, newValue: ALICE }]));
  const give = [{ key: profile(P), oldValue: ALICE, newValue: BOB }, { key: owns(ALICE, P), oldValue: "1" }, { key: owns(BOB, P), newValue: "1" }];
  // Nobody is given a profile without signing for it.
  assert.ok(!signedBy([ALICE], give));
  assert.ok(signedBy([ALICE, BOB], give));
  assert.ok(!signedBy([ALICE, BOB], give.slice(0, 2)));
  assert.ok(!signedBy([ALICE], [{ key: profile(P), oldValue: ALICE }, { key: owns(ALICE, P), oldValue: "1" }]));
});

test("nobody else changes a profile, but anyone buys a priced one by paying its owner", () => {
  const take = (old) => [{ key: profile(P), oldValue: old, newValue: BOB }, { key: owns(ALICE, P), oldValue: "1" }, { key: owns(BOB, P), newValue: "1" }];
  assert.ok(!signedBy([BOB], take(ALICE), pay(BOB, ALICE, 10n ** 6n)));
  assert.ok(!signedBy([BOB], [{ key: profile(P), oldValue: ALICE, newValue: `${ALICE}@1` }]));
  assert.ok(signedBy([BOB], take(`${ALICE}@500`), pay(BOB, ALICE, 500n)));
  assert.ok(!signedBy([BOB], take(`${ALICE}@500`), pay(BOB, ALICE, 499n)));
  assert.ok(!signedBy([BOB], take(`${ALICE}@500`), pay(BOB, CAROL, 500n)));
  assert.ok(signedBy([BOB], take(`${ALICE}@0`)));
});

test("anyone may write a profile or a name unchanged: it only shows who owns it", () => {
  assert.ok(signedBy([CAROL], [proof(P, ALICE)]));
  assert.ok(signedBy([CAROL], [held("alice", ALICE)]));
  // Unchanged still means well formed.
  assert.ok(!signedBy([CAROL], [held("alice", "junk")]));
  assert.ok(!signedBy([CAROL], [held("alice", P)]));
  assert.ok(!signedBy([CAROL], [{ key: profile(P), oldValue: "junk", newValue: "junk" }]));
});

test("a profile's fields are written only by its owner, right after its profile", () => {
  const card = { key: `about/${P}/card`, newValue: '{"name":"Alice"}' };
  assert.ok(signedBy([ALICE], [proof(P, ALICE), card]));
  assert.ok(signedBy([ALICE], [proof(P, `${ALICE}@9`), card]));
  // No proof, someone else's proof, or someone else signing: refused.
  assert.ok(!signedBy([ALICE], [card]));
  assert.ok(!signedBy([BOB], [proof(P, ALICE), card]));
  assert.ok(!signedBy([ALICE], [proof(Q, ALICE), card]));
  // Created and filled in one transaction; admins, default name and app fields alike.
  assert.ok(signedBy([ALICE], [...create(ALICE, P), card, { key: `about/${P}/admin/${BOB}`, newValue: "1" }, { key: `about/${P}/name`, newValue: "anything" }, { key: `about/${P}/app.rave.x`, newValue: "y" }]));
  assert.ok(signedBy([ALICE], [proof(P, ALICE), { key: `about/${P}/admin/${BOB}`, oldValue: "1" }]));
  // Bought and filled in one transaction, by the buyer.
  assert.ok(signedBy([BOB], [{ key: profile(P), oldValue: `${ALICE}@5`, newValue: BOB }, { key: owns(ALICE, P), oldValue: "1" }, { key: owns(BOB, P), newValue: "1" }, card], pay(BOB, ALICE, 5n)));
  // A record comes while its profile is the last one written; a name in between doesn't change that.
  assert.ok(signedBy([ALICE], [proof(P, ALICE), ...claim("alice", ALICE), point("alice", P), { key: `about/${P}/name`, newValue: "alice" }]));
  assert.ok(!signedBy([ALICE], [proof(P, ALICE), proof(R, ALICE), card]));
  assert.ok(!signedBy([ALICE], [card, proof(P, ALICE)]));
});

// ---------------------------------------------------------------- names

test("an account claims a free name for itself", () => {
  assert.ok(signedBy([ALICE], claim("alice", ALICE)));
  assert.ok(signedBy([ALICE], claim("alice_2", ALICE, 500)));
  // For someone else, or without names/: refused.
  assert.ok(!signedBy([ALICE], claim("alice", BOB)));
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue: ALICE }]));
  // A name's owner is an account, never a profile.
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue: P }]));
});

test("a handle is lowercase letters, digits and underscore", () => {
  for (const handle of ["", "Alice", "al-ice", "al.ice", "al ice", "alicé", "ALICE"]) {
    assert.ok(!signedBy([ALICE], claim(handle, ALICE)), handle);
  }
  assert.ok(signedBy([ALICE], claim("a".repeat(5000), ALICE)));
});

test("the owner prices, unprices, gives and releases a name", () => {
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE, newValue: `${ALICE}@500` }]));
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: `${ALICE}@500`, newValue: ALICE }]));
  // To another account only with its signature.
  assert.ok(!signedBy([ALICE], move("alice", ALICE, ALICE, BOB)));
  assert.ok(signedBy([ALICE, BOB], move("alice", ALICE, ALICE, BOB)));
  // Released, with its names/ key, and its pointer if it has one.
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE }, { key: names(ALICE, "alice"), oldValue: "1" }]));
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE }, { key: names(ALICE, "alice"), oldValue: "1" }, point("alice", undefined, P)]));
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE }]));
  // A release only deletes its pointer: it doesn't point it anew.
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE }, { key: names(ALICE, "alice"), oldValue: "1" }, point("alice", Q, P)]));
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE }, { key: names(ALICE, "alice"), oldValue: "1" }, point("alice", Q)]));
});

test("nobody else changes or releases a name", () => {
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: ALICE, newValue: `${ALICE}@1` }]));
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: ALICE }, { key: names(ALICE, "alice"), oldValue: "1" }]));
  assert.ok(!signedBy([BOB], move("alice", ALICE, ALICE, BOB), pay(BOB, ALICE, 10n ** 6n)));
  // A name with neither an old nor a new value is no write.
  assert.ok(!signedBy([ALICE], [{ key: name("alice") }]));
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
  // Bought and pointed at the buyer's profile in one transaction.
  assert.ok(signedBy([BOB], [...buy, point("alice", Q, P)], pay(BOB, ALICE, 500n)));
});

test("one payment covers one price, per seller", () => {
  const two = [...move("a1", ALICE, `${ALICE}@250`, CAROL), ...move("a2", ALICE, `${ALICE}@250`, CAROL)];
  assert.ok(!signedBy([CAROL], two, pay(CAROL, ALICE, 250n)));
  assert.ok(signedBy([CAROL], two, pay(CAROL, ALICE, 500n)));
  // A name and a profile from one seller add up.
  const both = [...move("a1", ALICE, `${ALICE}@250`, CAROL), { key: profile(P), oldValue: `${ALICE}@100`, newValue: CAROL }, { key: owns(ALICE, P), oldValue: "1" }, { key: owns(CAROL, P), newValue: "1" }];
  assert.ok(!signedBy([CAROL], both, pay(CAROL, ALICE, 250n)));
  assert.ok(signedBy([CAROL], both, pay(CAROL, ALICE, 350n)));
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

// ---------------------------------------------------------------- pointers

test("a name's owner points it at any profile, right after the name", () => {
  assert.ok(signedBy([ALICE], [held("alice", ALICE), point("alice", P)]));
  // Any profile: Bob's too, or one that doesn't exist yet.
  assert.ok(signedBy([ALICE], [held("alice", ALICE), point("alice", Q, P)]));
  assert.ok(signedBy([ALICE], [held("alice", `${ALICE}@5`), point("alice", undefined, Q)]));
  assert.ok(signedBy([ALICE], [...claim("alice", ALICE), point("alice", P)]));
  // Not by anyone else, not without the name just before, not at a non-profile.
  assert.ok(!signedBy([BOB], [held("alice", ALICE), point("alice", Q)]));
  assert.ok(!signedBy([ALICE], [point("alice", P)]));
  assert.ok(!signedBy([ALICE], [held("alice", ALICE), proof(P, ALICE), point("alice", P)]));
  assert.ok(!signedBy([ALICE], [held("bob", ALICE), point("alice", P)]));
  for (const value of [ALICE, "", "x", `${P}x`]) assert.ok(!signedBy([ALICE], [held("alice", ALICE), point("alice", value)]), value);
});

test("a name offered to an account is taken by it for nothing, and pointed", () => {
  const offered = `${ALICE}>${BOB}`;
  assert.ok(signedBy([ALICE], [{ key: name("gift"), oldValue: ALICE, newValue: offered }]));
  assert.ok(signedBy([BOB], [...move("gift", ALICE, offered, BOB), point("gift", Q, P)]));
  // Not by anyone else, and the offer can be taken back.
  assert.ok(!signedBy([CAROL], move("gift", ALICE, offered, CAROL)));
  assert.ok(signedBy([ALICE], [{ key: name("gift"), oldValue: offered, newValue: ALICE }]));
  assert.ok(!signedBy([BOB], [{ key: name("gift"), oldValue: offered, newValue: ALICE }]));
});

// ---------------------------------------------------------------- indexes

test("owns/ and names/ keys change only with their token, and only the right way", () => {
  assert.ok(!signedBy([ALICE], [{ key: owns(ALICE, P), newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [{ key: owns(ALICE, P), oldValue: "1" }]));
  assert.ok(!signedBy([ALICE], [{ key: names(ALICE, "alice"), newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [held("alice", ALICE), { key: names(ALICE, "alice"), oldValue: "1" }]));
  // Not for another token, or an account the token did not reach or leave.
  assert.ok(!signedBy([ALICE], [...create(ALICE, P), { key: owns(ALICE, Q), newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [...create(ALICE, P), { key: owns(BOB, P), newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue: ALICE }, { key: names(ALICE, "bob"), newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue: ALICE }, { key: owns(ALICE, P), newValue: "1" }]));
  // A price change moves nothing, and may not touch an index key.
  assert.ok(!signedBy([ALICE], [{ key: profile(P), oldValue: ALICE, newValue: `${ALICE}@9` }, { key: owns(ALICE, P), newValue: "1" }]));
  // The value is 1; an overwrite or an empty write is no move.
  assert.ok(!signedBy([ALICE], [{ key: profile(P), newValue: ALICE }, { key: owns(ALICE, P), newValue: "yes" }]));
  assert.ok(!signedBy([ALICE], [{ key: profile(P), newValue: ALICE }, { key: owns(ALICE, P), oldValue: "1", newValue: "1" }]));
});

test("index keys come directly after their token, the one it leaves first", () => {
  const take = { key: profile(P), oldValue: ALICE, newValue: BOB };
  const [leave, reach] = [{ key: owns(ALICE, P), oldValue: "1" }, { key: owns(BOB, P), newValue: "1" }];
  assert.ok(signedBy([ALICE, BOB], [take, leave, reach]));
  assert.ok(!signedBy([ALICE, BOB], [take, reach, leave]));
  assert.ok(!signedBy([ALICE, BOB], [take, leave, { key: `about/${P}/card`, newValue: "{}" }, reach]));
  assert.ok(!signedBy([ALICE, BOB], [take, leave]));
  const moved = move("art", ALICE, ALICE, BOB);
  assert.ok(signedBy([ALICE, BOB], moved));
  assert.ok(!signedBy([ALICE, BOB], [moved[0], moved[2], moved[1]]));
});

// ---------------------------------------------------------------- offers

test("a profile offered to one account is taken by that account, for nothing", () => {
  const take = (old, to) => [{ key: profile(P), oldValue: old, newValue: to }, { key: owns(ALICE, P), oldValue: "1" }, { key: owns(to, P), newValue: "1" }];
  assert.ok(signedBy([BOB], take(`${ALICE}>${BOB}`, BOB)));
  assert.ok(!signedBy([CAROL], take(`${ALICE}>${BOB}`, CAROL)));
});

test("an offer is to someone else, and well formed", () => {
  for (const value of [`${ALICE}>${ALICE}`, `${ALICE}>${P}`, `${ALICE}>`, `${ALICE}@5>${BOB}`]) {
    assert.ok(!signedBy([ALICE], [{ key: name("gift"), oldValue: ALICE, newValue: value }]), value);
    assert.ok(!signedBy([ALICE], [{ key: profile(P), oldValue: ALICE, newValue: value }]), value);
  }
});

test("nobody else changes the terms of a token they don't take", () => {
  // Paying the price buys the token: it may not stay with its owner on other terms.
  assert.ok(!signedBy([BOB], [{ key: profile(P), oldValue: `${ALICE}@5`, newValue: ALICE }], pay(BOB, ALICE, 5n)));
  assert.ok(!signedBy([BOB], [{ key: profile(P), oldValue: `${ALICE}@0`, newValue: `${ALICE}@9` }]));
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: `${ALICE}@0`, newValue: ALICE }]));
});

test("a price is one a credit can pay", () => {
  assert.ok(signedBy([ALICE], [...create(ALICE, P, "9223372036854775807")]));
  assert.ok(!signedBy([ALICE], [...create(ALICE, P, "9223372036854775808")]));
  assert.ok(!signedBy([ALICE], claim("alice", ALICE, "9223372036854775808")));
});

test("the work grows with the transaction, no faster", () => {
  // Many free names taken and pointed in one transaction: every check looks
  // only at the actions just before, so twice the actions take about twice the time.
  const time = (n) => {
    const actions = [];
    for (let i = 0; i < n; i++) actions.push(...move(`h${i}`, ALICE, `${ALICE}@0`, BOB), point(`h${i}`, Q, P));
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
