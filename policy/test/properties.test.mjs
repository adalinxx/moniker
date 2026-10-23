// Property tests for the built policy module: many random transactions, each
// judged by the module and by the plain restatement of the rules in model.mjs,
// the safety properties checked directly on every transaction the module
// accepts, and random corruptions of encoded bodies.
//
//   cargo build --release --target wasm32-unknown-unknown
//   LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/properties.test.mjs
//
// FUZZ_RUNS sets how many transactions each test tries, FUZZ_SEED replays one
// run; a failure prints both, with the transaction. With CONTEXT_DIR set,
// every context is recorded with its verdict, named by its hash, for
// host-check to replay through the node's own WasmKit.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { context, validate } from "./host.mjs";
import { MAX_KEY_BYTES, MAX_VALUE_BYTES, accepts, isAddress, shape, token } from "./model.mjs";

const core = await import(process.env.LATTICE_SDK_CORE);
const RUNS = Number(process.env.FUZZ_RUNS ?? 5000);
const SEED = Number(process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const PATH = ["Nexus", "moniker"];

const address = (seed) => core.addressFromPublicKey(core.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));
const ACCOUNTS = [1, 2, 3, 4].map(address);
const [ALICE] = ACCOUNTS;

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

// Values near the edges of each rule.
const NOT_ADDRESSES = ["alice", ALICE.toUpperCase(), ALICE.slice(0, 58), `${ALICE}a`, `${ALICE.slice(0, 7)}z${ALICE.slice(8)}`, "abcdefghijklmnop"];
const HANDLES = ["alice", "bob", "a_1", "0"];
const NOT_HANDLES = ["", "Alice", "a-b", "a/b", "alicé"];
const PRICES = [0n, 1n, 250n, 500n, (1n << 63n) - 1n];
const NOT_TERMS = ["@", "@01", "@-1", "@1.5", "@9223372036854775808", ">", `>${ALICE.slice(0, 58)}`, "@5>x"];

/** One random transaction, built from operations the app makes, then perhaps damaged. */
function transaction(r) {
  const signers = ACCOUNTS.filter(() => r.chance(0.4));
  if (r.chance(0.03)) signers.push(r.pick(NOT_ADDRESSES));
  const account = () => (r.chance(0.95) ? r.pick(ACCOUNTS) : r.pick(NOT_ADDRESSES));
  // Mostly who a real transaction would name: an account that signs.
  const signer = () => r.pick(signers.length && r.chance(0.75) ? signers : ACCOUNTS);
  const handle = () => (r.chance(0.95) ? r.pick(HANDLES) : r.pick(NOT_HANDLES));
  const terms = (owner) => {
    const roll = r.next();
    if (roll < 0.4) return owner;
    if (roll < 0.75) return `${owner}@${r.pick(PRICES)}`;
    if (roll < 0.95) return `${owner}>${r.pick(ACCOUNTS)}`;
    return `${owner}${r.pick(NOT_TERMS)}`;
  };
  const point = (h) => {
    const roll = r.next();
    if (roll < 0.5) return { key: `points/${h}`, ...(r.chance(0.5) && { oldValue: r.pick(ACCOUNTS) }), newValue: account() };
    return { key: `points/${h}`, ...(roll < 0.95 && { oldValue: r.pick(ACCOUNTS) }) };
  };
  const index = (who, h, created) => ({ key: `names/${who}/${h}`, ...(created ? { newValue: "1" } : { oldValue: "1" }) });

  const actions = [];
  const credits = [];
  for (let n = r.int(3); n >= 0; n--) {
    const h = handle();
    const op = r.int(8);
    if (op === 0) {
      // An account's own record.
      const key = `user/${r.chance(0.9) ? signer() : account()}/${r.pick(["name", "key.x25519", "app.x/a/b"])}`;
      actions.push({ key, ...(r.chance(0.4) && { oldValue: "old" }), ...(r.chance(0.8) && { newValue: r.pick(["alice", "{}", ""]) }) });
    } else if (op === 1) {
      // A claim.
      const owner = signer();
      actions.push({ key: `name/${h}`, newValue: terms(owner) }, index(owner, h, true));
      if (r.chance(0.85)) actions.push(point(h));
    } else if (op === 2) {
      // A name written unchanged, perhaps with its pointer.
      const value = terms(r.pick(ACCOUNTS));
      actions.push({ key: `name/${h}`, oldValue: value, newValue: value });
      if (r.chance(0.6)) actions.push(point(h));
    } else if (op === 3) {
      // Its owner changes its terms.
      const owner = signer();
      actions.push({ key: `name/${h}`, oldValue: terms(owner), newValue: terms(owner) });
    } else if (op === 4 || op === 5) {
      // A move: a gift, a purchase, or an offer taken.
      const [from, to] = [r.pick(ACCOUNTS), signer()];
      const listed = op === 4 ? `${from}@${r.pick(PRICES)}` : r.chance(0.5) ? `${from}>${to}` : terms(from);
      actions.push({ key: `name/${h}`, oldValue: listed, newValue: terms(to) }, index(from, h, false), index(to, h, true));
      if (r.chance(0.85)) actions.push(point(h));
      const price = token(listed)?.price;
      if (price !== undefined && r.chance(0.85)) {
        const paid = r.pick([price, price, price - 1n, price + 50n]);
        if (paid >= 0n) credits.push({ owner: r.chance(0.9) ? from : r.pick(ACCOUNTS), delta: paid });
      }
    } else if (op === 6) {
      // A release.
      const owner = signer();
      actions.push({ key: `name/${h}`, oldValue: terms(owner) }, index(owner, h, false));
      if (r.chance(0.5)) actions.push(point(h));
    } else {
      // Something out of place.
      actions.push(r.pick([point(h), index(r.pick(ACCOUNTS), h, r.chance(0.5)), { key: r.pick(["name", "names/x", "user", "points/A", "profile/x"]), newValue: "1" }]));
    }
  }
  // Now and then, damage: a swap, a drop, a duplicate, a value or account changed.
  for (let damage = r.chance(0.35) ? 1 + r.int(2) : 0; damage > 0 && actions.length > 0; damage--) {
    const at = r.int(actions.length);
    const roll = r.int(5);
    if (roll === 0 && at + 1 < actions.length) [actions[at], actions[at + 1]] = [actions[at + 1], actions[at]];
    else if (roll === 1) actions.splice(at, 1);
    else if (roll === 2) actions.splice(at, 0, { ...actions[at] });
    else if (roll === 3) actions[at] = { ...actions[at], newValue: r.pick([...ACCOUNTS, "1", `${r.pick(ACCOUNTS)}@5`, undefined]) };
    else actions[at] = { ...actions[at], key: actions[at].key.replace(/bafyrei[a-z2-7]{52}/, r.pick(ACCOUNTS)) };
    if (actions[at] && actions[at].newValue === undefined) delete actions[at].newValue;
  }
  // Keys and values a byte either side of their limits.
  if (r.chance(0.03) && actions.length) {
    const at = r.int(actions.length);
    actions[at] = { ...actions[at], newValue: "v".repeat(MAX_VALUE_BYTES - 1 + r.int(3)) };
  }
  if (r.chance(0.03)) actions.push({ key: `user/${r.pick(ACCOUNTS)}/`.padEnd(MAX_KEY_BYTES - 1 + r.int(3), "k"), newValue: "x" });
  // The buyer's debit, and the credits in order or not.
  if (credits.length && r.chance(0.2)) credits.reverse();
  const accountActions = credits.length ? [{ owner: r.pick(ACCOUNTS), delta: -1n }, ...credits] : [];
  return { signers, actions, accountActions };
}

function encode(tx) {
  return core.encodeTransactionBody({ ...tx, depositActions: [], receiptActions: [], withdrawalActions: [], nonce: 7n, chainPath: PATH }).bytes;
}

const contextDirectory = process.env.CONTEXT_DIR;
if (contextDirectory) mkdirSync(contextDirectory, { recursive: true });

/** The module's verdict; a trap fails the test, since the host would see one too. */
function verdict(bodyBytes) {
  const bytes = context(bodyBytes, { path: PATH });
  const accepted = validate(bytes);
  if (contextDirectory) {
    const name = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    writeFileSync(`${contextDirectory}/${name}-${accepted ? "accept" : "reject"}.bin`, bytes);
  }
  return accepted;
}

const show = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v), 2);
const replay = (index) => `FUZZ_SEED=${SEED} (case ${index})`;

/** Each generated transaction the SDK can encode, with its index. */
function* cases() {
  const r = random(SEED);
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
  assert.ok(accepted > RUNS / 10, `only ${accepted} of ${RUNS} accepted`);
});

test("an accepted transaction keeps every account's records, names and payments safe", () => {
  for (const { index, tx, bytes } of cases()) {
    if (!verdict(bytes)) continue;
    // Consensus refuses a key written twice in a block, so such a
    // transaction never lands; the agreement test above still covers it.
    if (new Set(tx.actions.map((a) => a.key)).size !== tx.actions.length) continue;
    const where = `${replay(index)}\n${show(tx)}`;
    const signs = (account) => tx.signers.includes(account);
    const owed = new Map();
    const moves = [];
    let claims = 0;
    for (const { key, oldValue, newValue } of tx.actions) {
      assert.ok(Buffer.byteLength(key) <= MAX_KEY_BYTES && (newValue == null || Buffer.byteLength(newValue) <= MAX_VALUE_BYTES), `too big: ${where}`);
      const k = shape(key);
      if (k.kind === "own") assert.ok(signs(k.account), `wrote another's record: ${where}`);
      if (k.kind !== "name" || oldValue === newValue) continue;
      const [before, after] = [oldValue == null ? null : token(oldValue), newValue == null ? null : token(newValue)];
      claims += before === null;
      if (after && after.owner !== before?.owner) assert.ok(signs(after.owner), `a name put on an account unsigned: ${where}`);
      if (before && !signs(before.owner)) {
        // Taken from an owner who doesn't sign: only on its terms.
        assert.ok(after && after.owner !== before.owner, `changed without its owner: ${where}`);
        assert.ok(before.terms === "price" || (before.terms === "offer" && before.to === after.owner), `taken unoffered: ${where}`);
        if (before.terms === "price") owed.set(before.owner, (owed.get(before.owner) ?? 0n) + before.price);
      }
      if (before?.owner !== after?.owner) moves.push({ handle: k.handle, from: before?.owner, to: after?.owner });
      if (after && before?.owner !== after.owner) {
        assert.ok(tx.actions.some((a) => a.key === `points/${k.handle}`), `a pointer an owner before left could survive: ${where}`);
      }
    }
    assert.ok(claims <= 1, `more than one claim: ${where}`);
    for (const [seller, price] of owed) {
      const paid = tx.accountActions.filter((a) => a.owner === seller && a.delta > 0n).reduce((sum, a) => sum + a.delta, 0n);
      assert.ok(paid >= price, `${seller} paid ${paid} of ${price}: ${where}`);
    }
    // names/ keys change exactly as the names move.
    const expected = moves.flatMap(({ handle, from, to }) => [
      ...(from ? [`names/${from}/${handle} -`] : []),
      ...(to ? [`names/${to}/${handle} +`] : []),
    ]);
    const written = tx.actions
      .filter((a) => a.key.startsWith("names/"))
      .map((a) => `${a.key} ${a.oldValue == null && a.newValue === "1" ? "+" : a.oldValue != null && a.newValue == null ? "-" : "?"}`);
    assert.deepEqual(written.sort(), expected.sort(), `names/ out of step with names: ${where}`);
    // A pointer is written only for a name in the same transaction, by its owner.
    for (const { key, newValue } of tx.actions.filter((a) => a.key.startsWith("points/"))) {
      const handle = key.slice("points/".length);
      const named = tx.actions.find((a) => a.key === `name/${handle}`);
      assert.ok(named, `a pointer without its name: ${where}`);
      const owner = token(named.newValue ?? named.oldValue)?.owner;
      assert.ok(named.newValue == null ? newValue == null : signs(owner), `pointed by someone else: ${where}`);
      if (newValue != null) assert.ok(isAddress(newValue), `pointed at a non-account: ${where}`);
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
        // The module is laxer than DAG-CBOR (it skips what it never reads),
        // which is safe only because the node decodes bodies strictly and
        // hands the policy its own canonical re-encoding. STRICT shows what
        // the module would accept without that.
        if (process.env.STRICT) assert.fail(`${replay(index)}: accepted a body that is not canonical DAG-CBOR (${error.message})`);
        continue;
      }
      const { signers, actions, accountActions } = decoded;
      assert.ok(accepts({ signers, actions, accountActions }), `${replay(index)}: accepted ${Buffer.from(mangled).toString("hex")}\n${show(decoded)}\nfrom\n${show(tx)}`);
    }
  }
});
