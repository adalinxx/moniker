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
const holds = (p, handle) => `holds/${p}/${handle}`;
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
/** Name `handle` claimed for profile `p`, with its `holds/` key. */
const claim = (handle, p, price) => [
  { key: name(handle), newValue: price === undefined ? p : `${p}@${price}` },
  { key: holds(p, handle), newValue: "1" },
];
/** Name `handle` moved from profile `from` (value `old`) to profile `to` (value `fresh`), with its `holds/` keys. */
const move = (handle, from, old, to, fresh = to) => [
  { key: name(handle), oldValue: old, newValue: fresh },
  { key: holds(from, handle), oldValue: "1" },
  { key: holds(to, handle), newValue: "1" },
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
  for (const key of ["user", "user/", ALICE, `index/topic/${ALICE}`, `users/${ALICE}`, `/user/${ALICE}`, "name", "name/", "profile", "profile/", `profile/${P.slice(1)}`, `profile/${P}x`, `profile/${P.toUpperCase()}`, `profile/${P}/`, `holds/${ALICE}/alice`, `owns/${P}/${ALICE}`, `card/${P}`]) {
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

test("anyone may write a profile or a name unchanged: it only shows what it holds", () => {
  assert.ok(signedBy([CAROL], [proof(P, ALICE)]));
  assert.ok(signedBy([CAROL], [{ key: name("alice"), oldValue: P, newValue: P }]));
  // Unchanged still means well formed.
  assert.ok(!signedBy([CAROL], [{ key: name("alice"), oldValue: "junk", newValue: "junk" }]));
  assert.ok(!signedBy([CAROL], [{ key: profile(P), oldValue: "junk", newValue: "junk" }]));
});

test("a profile's fields are written only by its owner, who shows it owns the profile", () => {
  const card = { key: `${profile(P)}/card`, newValue: '{"name":"Alice"}' };
  assert.ok(signedBy([ALICE], [proof(P, ALICE), card]));
  assert.ok(signedBy([ALICE], [proof(P, `${ALICE}@9`), card]));
  // No proof, someone else's proof, or someone else signing: refused.
  assert.ok(!signedBy([ALICE], [card]));
  assert.ok(!signedBy([BOB], [proof(P, ALICE), card]));
  assert.ok(!signedBy([ALICE], [proof(Q, ALICE), card]));
  // Created and filled in one transaction; admins and app fields alike.
  assert.ok(signedBy([ALICE], [...create(ALICE, P), card, { key: `${profile(P)}/admin/${BOB}`, newValue: "1" }, { key: `${profile(P)}/app.rave.x`, newValue: "y" }]));
  assert.ok(signedBy([ALICE], [proof(P, ALICE), { key: `${profile(P)}/admin/${BOB}`, oldValue: "1" }]));
  // Bought and filled in one transaction, by the buyer.
  assert.ok(signedBy([BOB], [{ key: profile(P), oldValue: `${ALICE}@5`, newValue: BOB }, { key: owns(ALICE, P), oldValue: "1" }, { key: owns(BOB, P), newValue: "1" }, card], pay(BOB, ALICE, 5n)));
});

test("the name a profile shows is one it holds", () => {
  const shows = (handle) => ({ key: `${profile(P)}/name`, newValue: handle });
  assert.ok(signedBy([ALICE], [proof(P, ALICE), { key: name("alice"), oldValue: P, newValue: P }, shows("alice")]));
  assert.ok(signedBy([ALICE], [proof(P, ALICE), ...claim("alice", P), shows("alice")]));
  assert.ok(!signedBy([ALICE], [proof(P, ALICE), shows("alice")]));
  assert.ok(!signedBy([ALICE], [proof(P, ALICE), { key: name("bob"), oldValue: Q, newValue: Q }, shows("bob")]));
  assert.ok(signedBy([ALICE], [proof(P, ALICE), { key: `${profile(P)}/name`, oldValue: "alice" }]));
});

// ---------------------------------------------------------------- names

test("a profile's owner claims a free name for it", () => {
  assert.ok(signedBy([ALICE], [proof(P, ALICE), ...claim("alice", P)]));
  assert.ok(signedBy([ALICE], [proof(P, ALICE), ...claim("alice_2", P, 500)]));
  assert.ok(signedBy([ALICE], [...create(ALICE, P), ...claim("alice", P)]));
  // Without showing it owns the profile, for another's profile, or without holds/: refused.
  assert.ok(!signedBy([ALICE], claim("alice", P)));
  assert.ok(!signedBy([ALICE], [proof(Q, BOB), ...claim("alice", Q)]));
  assert.ok(!signedBy([ALICE], [proof(P, ALICE), { key: name("alice"), newValue: P }]));
  // A name's holder is a profile, never an account.
  assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue: ALICE }]));
});

test("a handle is lowercase letters, digits and underscore", () => {
  for (const handle of ["", "Alice", "al-ice", "al.ice", "al ice", "alicé", "ALICE"]) {
    assert.ok(!signedBy([ALICE], [proof(P, ALICE), ...claim(handle, P)]), handle);
  }
  assert.ok(signedBy([ALICE], [proof(P, ALICE), ...claim("a".repeat(5000), P)]));
});

test("the owner prices, unprices, moves and releases a name", () => {
  const p = proof(P, ALICE);
  assert.ok(signedBy([ALICE], [p, { key: name("alice"), oldValue: P, newValue: `${P}@500` }]));
  assert.ok(signedBy([ALICE], [p, { key: name("alice"), oldValue: `${P}@500`, newValue: P }]));
  // To another of her profiles.
  assert.ok(signedBy([ALICE], [p, proof(R, ALICE), ...move("alice", P, P, R)]));
  // To someone else's profile only with their signature.
  assert.ok(!signedBy([ALICE], [p, proof(Q, BOB), ...move("alice", P, P, Q)]));
  assert.ok(signedBy([ALICE, BOB], [p, proof(Q, BOB), ...move("alice", P, P, Q)]));
  // Released, with its holds/ key.
  assert.ok(signedBy([ALICE], [p, { key: name("alice"), oldValue: P }, { key: holds(P, "alice"), oldValue: "1" }]));
  assert.ok(!signedBy([ALICE], [p, { key: name("alice"), oldValue: P }]));
});

test("nobody else changes or releases a name", () => {
  assert.ok(!signedBy([BOB], [proof(P, ALICE), { key: name("alice"), oldValue: P, newValue: `${P}@1` }]));
  assert.ok(!signedBy([BOB], [proof(P, ALICE), { key: name("alice"), oldValue: P }, { key: holds(P, "alice"), oldValue: "1" }]));
  assert.ok(!signedBy([BOB], [proof(P, ALICE), proof(Q, BOB), ...move("alice", P, P, Q)], pay(BOB, ALICE, 10n ** 6n)));
  // A name with neither an old nor a new value is no write.
  assert.ok(!signedBy([ALICE], [proof(P, ALICE), { key: name("alice") }]));
});

test("anyone buys a priced name onto their own profile, paying its profile's owner", () => {
  const listed = `${P}@500`;
  const buy = [proof(P, ALICE), proof(Q, BOB), ...move("alice", P, listed, Q)];
  assert.ok(signedBy([BOB], buy, pay(BOB, ALICE, 500n)));
  assert.ok(signedBy([BOB], [proof(P, ALICE), proof(Q, BOB), ...move("alice", P, listed, Q, `${Q}@900`)], pay(BOB, ALICE, 600n)));
  // Underpaid, paid to someone else, unpaid, or debited from the seller: refused.
  assert.ok(!signedBy([BOB], buy, pay(BOB, ALICE, 499n)));
  assert.ok(!signedBy([BOB], buy, pay(BOB, CAROL, 500n)));
  assert.ok(!signedBy([BOB], buy));
  assert.ok(!signedBy([BOB], buy, [{ owner: ALICE, delta: -500n }]));
  // The seller must be shown: without profile/<P> nobody knows whom to pay.
  assert.ok(!signedBy([BOB], [proof(Q, BOB), ...move("alice", P, listed, Q)], pay(BOB, ALICE, 500n)));
  // Paid to P's owner as the transaction shows it (consensus checks that value).
  assert.ok(!signedBy([BOB], [proof(P, CAROL), proof(Q, BOB), ...move("alice", P, listed, Q)], pay(BOB, ALICE, 500n)));
  // Onto a profile the buyer doesn't own: refused.
  assert.ok(!signedBy([BOB], [proof(P, ALICE), proof(R, ALICE), ...move("alice", P, listed, R)], pay(BOB, ALICE, 500n)));
  // A price of 0 is a giveaway.
  assert.ok(signedBy([BOB], [proof(P, ALICE), proof(Q, BOB), ...move("alice", P, `${P}@0`, Q)]));
  // Not for sale: refused whatever is paid.
  assert.ok(!signedBy([BOB], [proof(P, ALICE), proof(Q, BOB), ...move("alice", P, P, Q)], pay(BOB, ALICE, 10n ** 6n)));
});

test("one payment covers one price, per seller", () => {
  const two = [proof(P, ALICE), proof(Q, CAROL), ...move("a1", P, `${P}@250`, Q), ...move("a2", P, `${P}@250`, Q)];
  assert.ok(!signedBy([CAROL], two, pay(CAROL, ALICE, 250n)));
  assert.ok(signedBy([CAROL], two, pay(CAROL, ALICE, 500n)));
  const twoSellers = [proof(P, ALICE), proof("bbbbbbbbbbbbbbbb", BOB), proof(Q, CAROL), ...move("a1", P, `${P}@250`, Q), ...move("b1", "bbbbbbbbbbbbbbbb", "bbbbbbbbbbbbbbbb@100", Q)];
  assert.ok(!signedBy([CAROL], twoSellers, pay(CAROL, ALICE, 350n)));
  assert.ok(signedBy([CAROL], twoSellers, [{ owner: CAROL, delta: -350n }, { owner: ALICE, delta: 250n }, { owner: BOB, delta: 100n }]));
});

test("a profile bought with its names: the names stay on it and pay nothing more", () => {
  const take = [{ key: profile(P), oldValue: `${ALICE}@700`, newValue: BOB }, { key: owns(ALICE, P), oldValue: "1" }, { key: owns(BOB, P), newValue: "1" }];
  assert.ok(signedBy([BOB], [...take, { key: name("alice"), oldValue: `${P}@5`, newValue: P }], pay(BOB, ALICE, 700n)));
});

// ---------------------------------------------------------------- indexes

test("owns/ and holds/ keys change only with their token, and only the right way", () => {
  assert.ok(!signedBy([ALICE], [{ key: owns(ALICE, P), newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [{ key: owns(ALICE, P), oldValue: "1" }]));
  assert.ok(!signedBy([ALICE], [proof(P, ALICE), { key: holds(P, "alice"), newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [proof(P, ALICE), { key: holds(P, "alice"), oldValue: "1" }]));
  // Not for another token, or an account or profile the token did not reach or leave.
  assert.ok(!signedBy([ALICE], [...create(ALICE, P), { key: owns(ALICE, Q), newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [...create(ALICE, P), { key: owns(BOB, P), newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [proof(P, ALICE), ...claim("alice", P), { key: holds(Q, "alice"), newValue: "1" }]));
  // A price change moves nothing, and may not touch an index key.
  assert.ok(!signedBy([ALICE], [{ key: profile(P), oldValue: ALICE, newValue: `${ALICE}@9` }, { key: owns(ALICE, P), newValue: "1" }]));
  // The value is 1; an overwrite or an empty write is no move.
  assert.ok(!signedBy([ALICE], [{ key: profile(P), newValue: ALICE }, { key: owns(ALICE, P), newValue: "yes" }]));
  assert.ok(!signedBy([ALICE], [{ key: profile(P), newValue: ALICE }, { key: owns(ALICE, P), oldValue: "1", newValue: "1" }]));
});

// ---------------------------------------------------------------- offers

test("a name offered to one profile is taken by that profile's owner, for nothing", () => {
  const offered = `${P}>${Q}`;
  assert.ok(signedBy([ALICE], [proof(P, ALICE), { key: name("gift"), oldValue: P, newValue: offered }]));
  assert.ok(signedBy([BOB], [proof(P, ALICE), proof(Q, BOB), ...move("gift", P, offered, Q)]));
  // Not by anyone else, not onto another profile, and the offer can be taken back.
  assert.ok(!signedBy([CAROL], [proof(P, ALICE), proof("cccccccccccccccc", CAROL), ...move("gift", P, offered, "cccccccccccccccc")]));
  assert.ok(!signedBy([BOB], [proof(P, ALICE), proof("bbbbbbbbbbbbbbbb", BOB), ...move("gift", P, offered, "bbbbbbbbbbbbbbbb")]));
  assert.ok(signedBy([ALICE], [proof(P, ALICE), { key: name("gift"), oldValue: offered, newValue: P }]));
  assert.ok(!signedBy([BOB], [proof(P, ALICE), proof(Q, BOB), { key: name("gift"), oldValue: offered, newValue: P }]));
});

test("a profile offered to one account is taken by that account, for nothing", () => {
  const take = (old, to) => [{ key: profile(P), oldValue: old, newValue: to }, { key: owns(ALICE, P), oldValue: "1" }, { key: owns(to, P), newValue: "1" }];
  assert.ok(signedBy([BOB], take(`${ALICE}>${BOB}`, BOB)));
  assert.ok(!signedBy([CAROL], take(`${ALICE}>${BOB}`, CAROL)));
});

test("an offer is to someone else, and well formed", () => {
  for (const value of [`${P}>${P}`, `${P}>`, `${P}>junk`, `${P}>${ALICE}`, `${P}@5>${Q}`]) {
    assert.ok(!signedBy([ALICE], [proof(P, ALICE), { key: name("gift"), oldValue: P, newValue: value }]), value);
  }
  for (const value of [`${ALICE}>${ALICE}`, `${ALICE}>${P}`, `${ALICE}>`]) {
    assert.ok(!signedBy([ALICE], [{ key: profile(P), oldValue: ALICE, newValue: value }]), value);
  }
});
