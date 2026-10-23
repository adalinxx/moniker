// Property tests for the built policy module: many random transactions, each
// judged by the module and by the plain restatement of the rules in model.mjs,
// plus the safety properties checked directly on every transaction the module
// accepts, and random corruptions of encoded bodies.
//
//   cargo build --release --target wasm32-unknown-unknown
//   LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/properties.test.mjs
//
// FUZZ_RUNS sets how many transactions each test tries, FUZZ_SEED replays one
// run; a failure prints both, with the transaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { context, validate } from "./host.mjs";
import { accepts, holding, isAddress } from "./model.mjs";

const core = await import(process.env.LATTICE_SDK_CORE);
const RUNS = Number(process.env.FUZZ_RUNS ?? 5000);
const SEED = Number(process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const PATH = ["Nexus", "moniker"];

const address = (seed) => core.addressFromPublicKey(core.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));
const ACCOUNTS = [1, 2, 3, 4].map(address);
const [ALICE] = ACCOUNTS;
// Signers who hold nothing, for transactions with many signers.
const BYSTANDERS = Array.from({ length: 20 }, (_, i) => address(100 + i));

/** A small seeded generator (mulberry32), so a failing run can be replayed. */
function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const int = (n) => Math.floor(next() * n);
  return { next, int, pick: (list) => list[int(list.length)], chance: (p) => next() < p };
}

// Values near the edges of each rule: holders that are almost addresses,
// handles that are almost legal, prices that are almost canonical.
const NOT_ADDRESSES = ["", "alice", ALICE.toUpperCase(), ALICE.slice(0, 58), `${ALICE}a`, `bafkrei${ALICE.slice(7)}`, `${ALICE.slice(0, 7)}z${ALICE.slice(8)}`, `${ALICE.slice(0, 58)}b`];
const HANDLES = ["alice", "bob", "a_1", "0"];
const NOT_HANDLES = ["", "Alice", "a-b", "a.b", "a/b", "alicé", "a b"];
const PRICES = ["0", "1", "250", "500", "18446744073709551615"];
const NOT_PRICES = ["", "01", "-1", "1.5", "1@2", "18446744073709551616", " 1"];
const OTHER_KEYS = ["user", "user/", "users/x", "/user/x", "name", "index/x", "profile"];

function transaction(r) {
  const holder = () => (r.chance(0.9) ? r.pick(ACCOUNTS) : r.pick(NOT_ADDRESSES));
  const value = () => {
    const roll = r.next();
    if (roll < 0.45) return holder();
    if (roll < 0.9) return `${holder()}@${r.pick(PRICES)}`;
    return `${holder()}@${r.pick(NOT_PRICES)}`;
  };
  const key = () => {
    const roll = r.next();
    if (roll < 0.55) return `name/${r.chance(0.92) ? r.pick(HANDLES) : r.pick(NOT_HANDLES)}`;
    if (roll < 0.9) return `user/${r.pick(ACCOUNTS)}${r.pick(["", "/profile", "/com.github", "/a/b"])}`;
    return r.pick(OTHER_KEYS);
  };
  // Now and then, one near the caps on actions and signers.
  const large = r.chance(0.03);
  const actions = Array.from({ length: large ? r.int(300) : r.int(5) }, () => {
    const action = { key: key() };
    if (r.chance(0.6)) action.oldValue = value();
    if (r.chance(0.75)) action.newValue = value();
    // Keys and values a byte either side of their limits.
    if (r.chance(0.03)) action.key = `${action.key}/`.padEnd(511 + r.int(3), "k");
    if (r.chance(0.03)) action.newValue = "v".repeat(16 * 1024 - 1 + r.int(3));
    return action;
  });
  const signers = ACCOUNTS.filter(() => r.chance(0.35));
  if (large && r.chance(0.5)) signers.push(...BYSTANDERS.slice(0, 10 + r.int(10)));
  // Payments near the prices in play, to land on both sides of "enough".
  const amounts = [1n, 249n, 250n, 499n, 500n, 750n, 10n ** 6n, 18446744073709551615n];
  const accountActions = Array.from({ length: r.int(4) }, () => ({
    owner: r.pick(ACCOUNTS),
    delta: r.chance(0.8) ? r.pick(amounts) : -r.pick(amounts),
  }));
  return { signers, actions, accountActions };
}

function encode(tx) {
  return core.encodeTransactionBody({
    ...tx,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    nonce: 7n,
    chainPath: PATH,
  }).bytes;
}

/** The module's verdict; a trap fails the test, since the host would see one too. */
function verdict(bodyBytes) {
  return validate(context(bodyBytes, { path: PATH }));
}

const show = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v), 2);
const replay = (index) => `FUZZ_SEED=${SEED} (case ${index})`;

/** Each generated transaction the SDK can encode, with its index. */
function* cases(seed = SEED) {
  const r = random(seed);
  for (let index = 0; index < RUNS; index++) {
    const tx = transaction(r);
    let bytes;
    try {
      bytes = encode(tx);
    } catch {
      continue;
    }
    yield { index, tx, bytes };
  }
}

test("the module and the plain rules agree on random transactions", () => {
  let accepted = 0;
  for (const { index, tx, bytes } of cases()) {
    const actual = verdict(bytes);
    assert.equal(actual, accepts(tx), `${replay(index)}: module ${actual ? "accepts" : "rejects"}\n${show(tx)}`);
    accepted += actual;
  }
  // A generator that only ever produced rejections would prove little.
  assert.ok(accepted > RUNS / 20, `only ${accepted} of ${RUNS} accepted`);
});

test("an accepted transaction writes profile records only of accounts that sign", () => {
  for (const { index, tx, bytes } of cases()) {
    if (!verdict(bytes)) continue;
    for (const { key } of tx.actions.filter((a) => !a.key.startsWith("name/"))) {
      assert.ok(tx.signers.includes(key.split("/")[1]), `${replay(index)}: ${key}\n${show(tx)}`);
    }
  }
});

test("an accepted transaction takes a handle only from a holder who signs or is paid its price", () => {
  for (const { index, tx, bytes } of cases()) {
    if (!verdict(bytes)) continue;
    const owed = new Map();
    for (const { key, oldValue, newValue } of tx.actions) {
      if (!key.startsWith("name/")) continue;
      if (newValue != null) assert.ok(isAddress(holding(newValue).holder), `${replay(index)}: ${key} left to ${newValue}`);
      if (oldValue == null) {
        assert.ok(tx.signers.includes(holding(newValue).holder), `${replay(index)}: ${key} claimed for someone else`);
        continue;
      }
      const { holder, price } = holding(oldValue);
      if (tx.signers.includes(holder)) continue;
      assert.ok(newValue != null && price !== null, `${replay(index)}: ${key} changed without its holder\n${show(tx)}`);
      owed.set(holder, (owed.get(holder) ?? 0n) + price);
    }
    for (const [holder, price] of owed) {
      const paid = tx.accountActions.filter((a) => a.owner === holder && a.delta > 0n).reduce((sum, a) => sum + a.delta, 0n);
      assert.ok(paid >= price, `${replay(index)}: ${holder} paid ${paid} of ${price}\n${show(tx)}`);
    }
  }
});

/** One random corruption of an encoded body. */
function corrupt(r, bytes) {
  const out = [...bytes];
  for (let edits = 1 + r.int(3); edits > 0; edits--) {
    const at = r.int(out.length + 1);
    const roll = r.next();
    if (roll < 0.4 && out.length) out[at % out.length] = r.int(256);
    else if (roll < 0.6 && out.length) out[at % out.length] ^= 1 << r.int(8);
    else if (roll < 0.8) out.splice(at, 0, r.int(256));
    else out.splice(at, 1 + r.int(4));
  }
  return Uint8Array.from(out);
}

test("a corrupted body never traps the module, and is accepted only as a body the SDK reads and the rules allow", () => {
  const r = random(SEED ^ 0x5eed);
  for (const { index, tx, bytes } of cases()) {
    for (let round = 0; round < 4; round++) {
      const mangled = corrupt(r, bytes);
      if (!verdict(mangled)) continue;
      let decoded;
      try {
        decoded = core.decodeDagCbor(mangled);
      } catch (error) {
        // The module is laxer than DAG-CBOR (it skips strings it never reads,
        // for one), which is safe only because the node decodes bodies
        // strictly and hands the policy its own canonical re-encoding. STRICT
        // shows what the module would accept without that.
        if (process.env.STRICT) assert.fail(`${replay(index)}: accepted a body that is not canonical DAG-CBOR (${error.message}): ${Buffer.from(mangled).toString("hex")}`);
        continue;
      }
      const { signers, actions, accountActions } = decoded;
      assert.ok(
        accepts({ signers, actions, accountActions }),
        `${replay(index)}: accepted ${Buffer.from(mangled).toString("hex")}\n${show(decoded)}\nfrom\n${show(tx)}`,
      );
    }
  }
});
