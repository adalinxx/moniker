//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node --test client/
import assert from "node:assert/strict";
import { test } from "node:test";
import { context, validate } from "../policy/test/host.mjs";
import * as profile from "./profile.mjs";
import * as wallet from "./wallet.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const PATH = profile.MONIKER_CHAIN;
const address = (seed) => sdk.addressFromPublicKey(sdk.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));
const [ALICE, BOB, CAROL] = [address(1), address(2), address(3)];

/**
 * A chain in memory that admits a transaction the way consensus would: every
 * action's old value must be what the key holds, the built profile policy
 * must accept the body, and no balance may go below zero.
 */
function chain(balances) {
  const map = new Map();
  const coins = new Map(Object.entries(balances).map(([who, amount]) => [who, BigInt(amount)]));
  const state = {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
  };
  let nonce = 0n;
  function submit(owner, { actions, payments = [] }) {
    const body = wallet.transaction({ owner, actions, payments, fee: 1n, nonce: nonce++, chainPath: PATH });
    for (const { key, oldValue } of actions) if (map.get(key) !== oldValue) return false;
    if (!validate(context(sdk.encodeTransactionBody(body).bytes, { path: PATH }))) return false;
    const after = new Map(coins);
    for (const { owner: who, delta } of body.accountActions) after.set(who, (after.get(who) ?? 0n) + delta);
    if ([...after.values()].some((amount) => amount < 0n)) return false;
    for (const [who, amount] of after) coins.set(who, amount);
    for (const { key, newValue } of actions) {
      if (newValue === undefined) map.delete(key);
      else map.set(key, newValue);
    }
    return true;
  }
  return { state, submit, map, coins };
}

test("a card is written, edited field by field, and read back", async () => {
  const { state, submit } = chain({ [ALICE]: 100 });
  assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { name: "Alice", description: "Builds things", avatar: "bafyreiavatar" })));
  assert.deepEqual(await profile.getProfile(state, ALICE), {
    address: ALICE,
    name: "Alice",
    description: "Builds things",
    avatar: "bafyreiavatar",
  });
  assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { description: undefined, url: "https://alice.example" })));
  assert.deepEqual(await profile.getProfile(state, ALICE), {
    address: ALICE,
    name: "Alice",
    avatar: "bafyreiavatar",
    url: "https://alice.example",
  });
  // Nothing to write when nothing changes; an emptied card is deleted.
  assert.deepEqual((await profile.editCard(state, ALICE, { name: "Alice" })).actions, []);
  assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { name: "", avatar: null, url: undefined })));
  assert.equal(await state.get(profile.cardKey(ALICE)), undefined);
  assert.deepEqual(await profile.getProfile(state, ALICE), { address: ALICE });
});

test("a rewrite keeps card fields this client does not know", async () => {
  const { state, submit, map } = chain({ [ALICE]: 100 });
  map.set(profile.cardKey(ALICE), JSON.stringify({ name: "Alice", pronouns: "she/her", theme: { dark: true } }));
  assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { name: "Alice B." })));
  assert.deepEqual(JSON.parse(map.get(profile.cardKey(ALICE))), { name: "Alice B.", pronouns: "she/her", theme: { dark: true } });
});

test("an unreadable card shows nothing and is replaced on the next save", async () => {
  const { state, submit, map } = chain({ [ALICE]: 100 });
  map.set(profile.cardKey(ALICE), "not json");
  assert.deepEqual(await profile.getProfile(state, ALICE), { address: ALICE });
  map.set(profile.cardKey(ALICE), JSON.stringify({ name: 7, description: ["x"], url: "https://ok" }));
  assert.deepEqual(await profile.getProfile(state, ALICE), { address: ALICE, url: "https://ok" });
  assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { name: "Alice" })));
  assert.equal(JSON.parse(map.get(profile.cardKey(ALICE))).name, "Alice");
});

test("nobody edits another account's card or fields", async () => {
  const { state, submit } = chain({ [ALICE]: 100, [BOB]: 100 });
  assert.ok(!submit(BOB, await profile.editCard(state, ALICE, { name: "Not Alice" })));
  assert.ok(!submit(BOB, await profile.setField(state, ALICE, "app.demo.color", "red")));
});

test("a stale edit is refused, and saveCard retries it on the new card", async () => {
  const { state, submit } = chain({ [ALICE]: 100 });
  assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { name: "Alice" })));
  const stale = await profile.editCard(state, ALICE, { description: "from app one" });
  assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { url: "https://from-app-two" })));
  assert.ok(!submit(ALICE, stale));

  // The first send is beaten by another app's save; the retry keeps both.
  let raced = false;
  const send = async (write) => {
    if (!raced) {
      raced = true;
      assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { handle: "alice" })));
    }
    if (!submit(ALICE, write)) throw new Error("refused");
    return "sent";
  };
  assert.equal(await profile.saveCard(async () => state, ALICE, { description: "from app one" }, send), "sent");
  const card = JSON.parse(await state.get(profile.cardKey(ALICE)));
  assert.equal(card.description, "from app one");
  assert.equal(card.handle, "alice");
  assert.equal(card.url, "https://from-app-two");

  // A failure that is not a conflict is not retried.
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error("declined in the wallet");
  };
  await assert.rejects(profile.saveCard(async () => state, ALICE, { name: "Again" }, failing), /declined/);
  assert.equal(calls, 1);
});

test("links are kept in order, and only web addresses are shown", async () => {
  const { state, submit, map } = chain({ [ALICE]: 100 });
  const links = [
    { label: "Website", url: "https://alice.example" },
    { label: "GitHub", url: "https://github.com/alice" },
  ];
  assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { name: "Alice", links })));
  assert.deepEqual((await profile.getProfile(state, ALICE)).links, links);
  // Reordered and trimmed in one save; an empty list removes the field.
  assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { links: [links[1]] })));
  assert.deepEqual((await profile.getProfile(state, ALICE)).links, [links[1]]);
  assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { links: [] })));
  assert.equal("links" in JSON.parse(map.get(profile.cardKey(ALICE))), false);
  // The client refuses to write a link that is not a web address.
  await assert.rejects(profile.editCard(state, ALICE, { links: [{ label: "x", url: "javascript:alert(1)" }] }), /not an http/);
  await assert.rejects(profile.editCard(state, ALICE, { links: [{ label: "", url: "https://a.example" }] }), /label/);
  // A card written by another client is read the same careful way.
  map.set(
    profile.cardKey(ALICE),
    JSON.stringify({
      url: "javascript:alert(1)",
      links: [{ label: "ok", url: "https://ok.example", extra: 1 }, { label: "bad", url: "data:text/html,x" }, { url: "https://no-label.example" }, "nonsense"],
    }),
  );
  assert.deepEqual(await profile.getProfile(state, ALICE), { address: ALICE, links: [{ label: "ok", url: "https://ok.example" }] });
});

test("fields outside the card are set, listed and removed", async () => {
  const { state, submit } = chain({ [ALICE]: 100 });
  assert.ok(submit(ALICE, await profile.setField(state, ALICE, "app.demo.color", "teal")));
  assert.ok(submit(ALICE, await profile.setField(state, ALICE, "key.x25519", "abcd")));
  assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { name: "Alice" })));
  assert.deepEqual(await profile.getFields(state, ALICE), { "app.demo.color": "teal", "key.x25519": "abcd" });
  assert.ok(submit(ALICE, await profile.setField(state, ALICE, "app.demo.color", undefined)));
  assert.equal(await profile.getField(state, ALICE, "app.demo.color"), undefined);
  await assert.rejects(profile.setField(state, ALICE, "profile", "x"), /not a field name/);
});

test("a handle is claimed once, shown only by its holder, and moves with a sale", async () => {
  const { state, submit, coins } = chain({ [ALICE]: 100, [BOB]: 1000 });
  assert.ok(submit(ALICE, await profile.claim(state, ALICE, "alice")));
  await assert.rejects(profile.claim(state, BOB, "alice"), /taken/);
  await assert.rejects(profile.claim(state, BOB, "Alice"), /lowercase/);
  // Claimed but not on the card: resolves, not shown.
  assert.equal((await profile.resolve(state, "alice")).holder, ALICE);
  assert.equal((await profile.getProfile(state, ALICE)).handle, undefined);
  assert.ok(submit(ALICE, await profile.editCard(state, ALICE, { handle: "alice" })));
  assert.equal((await profile.getProfile(state, ALICE)).handle, "alice");
  // Bob names it on his card without holding it: not shown.
  assert.ok(submit(BOB, await profile.editCard(state, BOB, { handle: "alice" })));
  assert.equal((await profile.getProfile(state, BOB)).handle, undefined);

  assert.ok(submit(ALICE, profile.list(await profile.resolve(state, "alice"), 500n)));
  assert.deepEqual(
    (await profile.forSale(state)).map(({ handle, price }) => [handle, price]),
    [["alice", 500n]],
  );
  const listed = await profile.resolve(state, "alice");
  assert.ok(submit(BOB, profile.buy(listed, BOB)));
  assert.equal(coins.get(ALICE), 100n - 1n - 1n - 1n + 500n);
  assert.equal(coins.get(BOB), 1000n - 1n - 500n - 1n);
  // Now Bob's card shows it, and Alice's no longer does.
  assert.equal((await profile.getProfile(state, BOB)).handle, "alice");
  assert.equal((await profile.getProfile(state, ALICE)).handle, undefined);
  assert.deepEqual((await profile.heldBy(state, BOB)).map((e) => e.handle), ["alice"]);
});

test("a buyer whose price went stale is refused and pays nothing", async () => {
  const { state, submit, coins } = chain({ [ALICE]: 100, [BOB]: 1000 });
  assert.ok(submit(ALICE, await profile.claim(state, ALICE, "rare", 300n)));
  const seen = await profile.resolve(state, "rare");
  assert.ok(submit(ALICE, profile.list(seen, 900n)));
  const before = coins.get(BOB);
  assert.ok(!submit(BOB, profile.buy(seen, BOB)));
  assert.equal(coins.get(BOB), before);
  assert.equal((await profile.resolve(state, "rare")).holder, ALICE);
});

test("the holder unlists, transfers and releases; a released handle is free again", async () => {
  const { state, submit } = chain({ [ALICE]: 100, [BOB]: 100, [CAROL]: 100 });
  assert.ok(submit(ALICE, await profile.claim(state, ALICE, "gift", 50n)));
  assert.ok(submit(ALICE, profile.unlist(await profile.resolve(state, "gift"))));
  assert.throws(() => profile.buy({ handle: "gift", holder: ALICE }, BOB), /not for sale/);
  assert.ok(submit(ALICE, profile.transfer(await profile.resolve(state, "gift"), BOB)));
  assert.equal((await profile.resolve(state, "gift")).holder, BOB);
  // The giver can no longer change it.
  assert.ok(!submit(ALICE, profile.release(await profile.resolve(state, "gift"))));
  assert.ok(submit(BOB, profile.release(await profile.resolve(state, "gift"))));
  assert.equal(await profile.resolve(state, "gift"), undefined);
  assert.ok(submit(CAROL, await profile.claim(state, CAROL, "gift")));
  const gift = await profile.resolve(state, "gift");
  assert.throws(() => profile.transfer(gift, "not-an-address"), /not an address/);
});

test("a buy and a card change go in one transaction", async () => {
  const { state, submit } = chain({ [ALICE]: 100, [BOB]: 1000 });
  assert.ok(submit(ALICE, await profile.claim(state, ALICE, "both", 10n)));
  const both = profile.combine(profile.buy(await profile.resolve(state, "both"), BOB), await profile.editCard(state, BOB, { handle: "both" }));
  assert.ok(submit(BOB, both));
  assert.equal((await profile.getProfile(state, BOB)).handle, "both");
});

test("the wallet request carries the buy's payment", async () => {
  const { state, submit } = chain({ [ALICE]: 100 });
  assert.ok(submit(ALICE, await profile.claim(state, ALICE, "w", 25n)));
  const request = wallet.writeRequest(PATH, profile.buy(await profile.resolve(state, "w"), BOB), 2n);
  assert.deepEqual(request.chainPath, ["Nexus", "moniker"]);
  assert.deepEqual(request.payments, [{ to: ALICE, amount: "25" }]);
  assert.equal(request.fee, "2");
});

test("the client's address and handle checks match the policy's", () => {
  assert.ok(profile.isAddress(ALICE));
  for (const bad of [ALICE.toUpperCase(), ALICE.slice(0, 58), `${ALICE.slice(0, 7)}z${ALICE.slice(8)}`, `${ALICE.slice(0, 58)}b`]) {
    assert.ok(!profile.isAddress(bad), bad);
  }
  assert.ok(profile.isHandle("a_1"));
  for (const bad of ["", "A", "a-b", "a.b", "é"]) assert.ok(!profile.isHandle(bad), bad);
});

test("runsMoniker recognises the chain spec", () => {
  const policy = { moduleCID: profile.MONIKER_POLICY, scope: "transaction", entrypoint: "lattice_validate_transaction" };
  assert.ok(profile.runsMoniker({ wasmPolicies: [policy] }));
  assert.ok(!profile.runsMoniker({ wasmPolicies: [{ ...policy, moduleCID: "bafyreiother" }] }));
  assert.ok(!profile.runsMoniker({}));
});
