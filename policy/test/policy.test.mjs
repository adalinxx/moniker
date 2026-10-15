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

test("an account writes, edits and deletes its own profile records", () => {
  const card = JSON.stringify({ name: "Alice", avatar: "bafkreiexample" });
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/profile`, newValue: card }]));
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/profile`, oldValue: card, newValue: "{}" }]));
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/profile`, oldValue: "{}" }]));
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/com.github`, newValue: "alice" }]));
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/app.fanfare.anything/a/b`, newValue: "x" }]));
});

test("nobody writes or deletes another account's records", () => {
  assert.ok(!signedBy([BOB], [{ key: `user/${ALICE}/profile`, newValue: "{}" }]));
  assert.ok(!signedBy([BOB], [{ key: `user/${ALICE}/profile`, oldValue: "{}" }]));
  assert.ok(!signedBy([BOB], [{ key: `user/${ALICE}/${BOB}`, newValue: "x" }]));
  assert.ok(
    !signedBy([ALICE], [
      { key: `user/${ALICE}/profile`, newValue: "{}" },
      { key: `user/${BOB}/profile`, newValue: "{}" },
    ]),
  );
});

test("keys outside the two shapes are rejected", () => {
  for (const key of ["user", "user/", ALICE, `index/topic/${ALICE}`, `own/${ALICE}/1`, `users/${ALICE}`, `/user/${ALICE}`, "name"]) {
    assert.ok(!signedBy([ALICE], [{ key, newValue: ALICE }]), key);
  }
});

test("the policy puts no limit on key, value or handle size", () => {
  assert.ok(signedBy([ALICE], [{ key: `user/${ALICE}/${"i".repeat(5000)}`, newValue: "x".repeat(200000) }]));
  assert.ok(signedBy([ALICE], [{ key: name("a".repeat(5000)), newValue: ALICE }]));
});

test("coin actions pass untouched", () => {
  assert.ok(signedBy([ALICE], []));
  assert.ok(signedBy([ALICE], [], pay(ALICE, BOB, 998n)));
});

test("a malformed or unknown context is rejected", () => {
  const good = body([{ key: `user/${ALICE}/profile`, newValue: "{}" }], [ALICE]);
  assert.ok(run(context(good)));
  assert.ok(!run(context(good, { version: 1 })));
  assert.ok(!run(context(undefined)));
  assert.ok(!run(context(good.slice(0, good.length - 3))));
  assert.ok(!run(context(good).slice(0, 40)));
  assert.ok(!run(new Uint8Array(0)));
});

test("an account claims a free handle for itself, priced or not", () => {
  assert.ok(signedBy([ALICE], [{ key: name("alice"), newValue: ALICE }]));
  assert.ok(signedBy([ALICE], [{ key: name("alice_2"), newValue: `${ALICE}@500` }]));
  assert.ok(signedBy([ALICE], [{ key: name("0"), newValue: ALICE }]));
  // Claiming for someone else is refused: a claim is signed by its holder.
  assert.ok(!signedBy([ALICE], [{ key: name("bob"), newValue: BOB }]));
});

test("a handle is lowercase letters, digits and underscore", () => {
  for (const handle of ["", "Alice", "al-ice", "al.ice", "al ice", "al/ice", "alicé", "ALICE"]) {
    assert.ok(!signedBy([ALICE], [{ key: name(handle), newValue: ALICE }]), handle);
  }
});

test("a handle's holder is always a well-formed address", () => {
  const bad = [
    "alice-address",
    ALICE.toUpperCase(),
    ALICE.slice(0, 58),
    `${ALICE}a`,
    `bafkrei${ALICE.slice(7)}`,
    // Same length and alphabet, but unused bits set.
    `${ALICE.slice(0, 7)}z${ALICE.slice(8)}`,
    `${ALICE.slice(0, 58)}b`,
  ];
  for (const holder of bad) {
    assert.ok(!signedBy([ALICE, holder], [{ key: name("alice"), newValue: holder }]), holder);
    assert.ok(!signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE, newValue: holder }]), holder);
    assert.ok(!signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE, newValue: `${holder}@5` }]), holder);
  }
});

test("the holder transfers, prices, unprices and releases a handle", () => {
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE, newValue: BOB }]));
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE, newValue: `${ALICE}@500` }]));
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: `${ALICE}@500`, newValue: `${ALICE}@450` }]));
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: `${ALICE}@500`, newValue: ALICE }]));
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE }]));
  assert.ok(signedBy([ALICE], [{ key: name("alice"), oldValue: `${ALICE}@500` }]));
});

test("nobody else transfers, reprices or releases a handle", () => {
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: ALICE, newValue: BOB }]));
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: ALICE }]));
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: `${ALICE}@500` }], pay(BOB, ALICE, 500n)));
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: ALICE, newValue: BOB }], pay(BOB, ALICE, 10n ** 6n)));
  // A write with neither an old nor a new value is not a release.
  assert.ok(!signedBy([ALICE], [{ key: name("alice") }]));
});

test("anyone takes a priced handle by paying its holder", () => {
  const listed = `${ALICE}@500`;
  assert.ok(signedBy([BOB], [{ key: name("alice"), oldValue: listed, newValue: BOB }], pay(BOB, ALICE, 500n)));
  // Paying more is fine; the buyer may hand it on or list it again.
  assert.ok(signedBy([BOB], [{ key: name("alice"), oldValue: listed, newValue: CAROL }], pay(BOB, ALICE, 600n)));
  assert.ok(signedBy([BOB], [{ key: name("alice"), oldValue: listed, newValue: `${BOB}@900` }], pay(BOB, ALICE, 500n)));
  // A price of 0 is a giveaway.
  assert.ok(signedBy([BOB], [{ key: name("alice"), oldValue: `${ALICE}@0`, newValue: BOB }]));
  // The buyer shows it on their card in the same transaction.
  assert.ok(
    signedBy(
      [BOB],
      [
        { key: name("alice"), oldValue: listed, newValue: BOB },
        { key: `user/${BOB}/profile`, newValue: '{"handle":"alice"}' },
      ],
      pay(BOB, ALICE, 500n),
    ),
  );
});

test("a buy that underpays, pays someone else, or names a stale price is refused", () => {
  const listed = `${ALICE}@500`;
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: listed, newValue: BOB }], pay(BOB, ALICE, 499n)));
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: listed, newValue: BOB }]));
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: listed, newValue: BOB }], pay(BOB, CAROL, 500n)));
  // A debit from the holder is not a payment to them.
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: listed, newValue: BOB }], [{ owner: ALICE, delta: -500n }]));
  // The price is read from the old value, so a buyer who names a lower price
  // than the chain holds is refused by consensus, and naming it here pays it.
  assert.ok(!signedBy([BOB], [{ key: name("alice"), oldValue: `${ALICE}@900`, newValue: BOB }], pay(BOB, ALICE, 500n)));
});

test("one payment covers one price, per holder", () => {
  const two = [
    { key: name("a1"), oldValue: `${ALICE}@250`, newValue: CAROL },
    { key: name("a2"), oldValue: `${ALICE}@250`, newValue: CAROL },
  ];
  assert.ok(!signedBy([CAROL], two, pay(CAROL, ALICE, 250n)));
  assert.ok(signedBy([CAROL], two, pay(CAROL, ALICE, 500n)));
  const twoHolders = [
    { key: name("a1"), oldValue: `${ALICE}@250`, newValue: CAROL },
    { key: name("b1"), oldValue: `${BOB}@100`, newValue: CAROL },
  ];
  assert.ok(!signedBy([CAROL], twoHolders, pay(CAROL, ALICE, 350n)));
  assert.ok(
    signedBy([CAROL], twoHolders, [
      { owner: CAROL, delta: -350n },
      { owner: ALICE, delta: 250n },
      { owner: BOB, delta: 100n },
    ]),
  );
});

test("a handle value is a holder, optionally with one canonical price", () => {
  for (const newValue of ["", "@250", `${ALICE}@`, `${ALICE}@01`, `${ALICE}@-1`, `${ALICE}@1@2`, `${ALICE}@1.5`]) {
    assert.ok(!signedBy([ALICE], [{ key: name("alice"), newValue }]), newValue);
    assert.ok(!signedBy([ALICE], [{ key: name("alice"), oldValue: ALICE, newValue }]), newValue);
  }
});
