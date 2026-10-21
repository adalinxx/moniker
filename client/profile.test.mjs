//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node --test client/
import assert from "node:assert/strict";
import { test } from "node:test";
import { context, validate } from "../policy/test/host.mjs";
import * as profile from "../sdk/src/records/profile.mjs";
import * as wallet from "../sdk/src/records/wallet.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const PATH = profile.MONIKER_CHAIN;
const address = (seed) => sdk.addressFromPublicKey(sdk.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));
const [ALICE, BOB, CAROL] = [address(1), address(2), address(3)];

/**
 * A chain in memory that admits a transaction the way consensus would: each
 * key changes once, every action's old value must be what the key holds, no
 * account action is zero, the built profile policy must accept the body, and
 * no balance may go below zero.
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
    if (new Set(actions.map((a) => a.key)).size !== actions.length) return false;
    for (const { key, oldValue } of actions) if (map.get(key) !== oldValue) return false;
    if (body.accountActions.some(({ delta }) => delta === 0n)) return false;
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

/** `who` creates a profile with `card` and `handle`; resolves to its id. */
async function made(c, who, card, handle) {
  const { id, write: w } = await profile.createProfile(c.state, who, { card, handle });
  assert.ok(c.submit(who, w), `profile for ${handle ?? "no name"}`);
  return id;
}

test("an account makes a profile with a card and a name in one write", async () => {
  const c = chain({ [ALICE]: 100 });
  const p = await made(c, ALICE, { name: "Alice", description: "Builds things", avatar: "bafyreiavatar" }, "alice");
  assert.ok(profile.isProfileId(p));
  assert.deepEqual(await profile.getProfile(c.state, p), { id: p, owner: ALICE, name: "Alice", description: "Builds things", avatar: "bafyreiavatar", handle: "alice" });
  assert.equal((await profile.profileOf(c.state, "alice")).id, p);
  assert.deepEqual((await profile.profilesOf(c.state, ALICE)).map((x) => x.id), [p]);
  assert.deepEqual((await profile.namesOf(c.state, p)).map((e) => e.handle), ["alice"]);
  assert.equal(await profile.getProfile(c.state, "aaaaaaaaaaaaaaaa"), undefined);
  await assert.rejects(profile.createProfile(c.state, ALICE, { handle: "alice" }), /taken/);
});

test("a card is edited field by field by the profile's owner alone", async () => {
  const c = chain({ [ALICE]: 100, [BOB]: 100 });
  const p = await made(c, ALICE, { name: "Alice" }, "alice");
  assert.ok(c.submit(ALICE, await profile.editCard(c.state, ALICE, p, { description: "Builds things", url: "https://alice.example" })));
  assert.deepEqual(await profile.getProfile(c.state, p), { id: p, owner: ALICE, name: "Alice", description: "Builds things", url: "https://alice.example", handle: "alice" });
  assert.deepEqual((await profile.editCard(c.state, ALICE, p, { name: "Alice" })).actions, []);
  await assert.rejects(profile.editCard(c.state, BOB, p, { name: "Not Alice" }), /isn't yours/);
  // Written by hand, Bob's card is refused by the policy, with or without the proof.
  const forged = { key: profile.cardKey(p), oldValue: c.map.get(profile.cardKey(p)), newValue: '{"name":"Not Alice"}' };
  assert.ok(!c.submit(BOB, { actions: [forged] }));
  assert.ok(!c.submit(BOB, { actions: [{ key: profile.profileKey(p), oldValue: ALICE, newValue: ALICE }, forged] }));
  assert.ok(c.submit(ALICE, await profile.editCard(c.state, ALICE, p, { name: "", description: null, url: undefined })));
  assert.equal(c.map.get(profile.cardKey(p)), undefined);
});

test("a rewrite keeps card fields this client does not know; an unreadable card shows nothing", async () => {
  const c = chain({ [ALICE]: 100 });
  const p = await made(c, ALICE, undefined, "alice");
  c.map.set(profile.cardKey(p), JSON.stringify({ name: "Alice", pronouns: "she/her", theme: { dark: true } }));
  assert.ok(c.submit(ALICE, await profile.editCard(c.state, ALICE, p, { name: "Alice B." })));
  assert.deepEqual(JSON.parse(c.map.get(profile.cardKey(p))), { name: "Alice B.", pronouns: "she/her", theme: { dark: true } });
  c.map.set(profile.cardKey(p), "not json");
  assert.deepEqual(await profile.getProfile(c.state, p), { id: p, owner: ALICE, handle: "alice" });
  c.map.set(profile.cardKey(p), JSON.stringify({ name: 7, url: "https://ok", links: [{ label: "bad", url: "javascript:x" }, { label: "ok", url: "https://ok.example" }, "junk"] }));
  assert.deepEqual(await profile.getProfile(c.state, p), { id: p, owner: ALICE, url: "https://ok", links: [{ label: "ok", url: "https://ok.example" }], handle: "alice" });
  await assert.rejects(profile.editCard(c.state, ALICE, p, { links: [{ label: "x", url: "javascript:alert(1)" }] }), /not an http/);
  await assert.rejects(profile.editCard(c.state, ALICE, p, { links: [{ label: "", url: "https://a.example" }] }), /label/);
});

test("a stale edit is refused, and saveCard retries it on the new card", async () => {
  const c = chain({ [ALICE]: 100 });
  const p = await made(c, ALICE, { name: "Alice" }, "alice");
  const stale = await profile.editCard(c.state, ALICE, p, { description: "from app one" });
  assert.ok(c.submit(ALICE, await profile.editCard(c.state, ALICE, p, { url: "https://from-app-two" })));
  assert.ok(!c.submit(ALICE, stale));
  let first = true;
  const send = async (w) => {
    if (first) {
      first = false;
      assert.ok(c.submit(ALICE, await profile.editCard(c.state, ALICE, p, { name: "Alice R." })));
    }
    if (!c.submit(ALICE, w)) throw new Error("stale");
    return "sent";
  };
  assert.equal(await profile.saveCard(async () => c.state, ALICE, p, { description: "from app one" }, send), "sent");
  assert.deepEqual(JSON.parse(c.map.get(profile.cardKey(p))), { name: "Alice R.", url: "https://from-app-two", description: "from app one" });
  await assert.rejects(profile.saveCard(async () => c.state, ALICE, p, { name: "Again" }, async () => { throw new Error("declined"); }), /declined/);
});

test("an account's own fields are set, listed and removed, by it alone", async () => {
  const c = chain({ [ALICE]: 100, [BOB]: 100 });
  assert.ok(c.submit(ALICE, await profile.setField(c.state, ALICE, "app.demo.color", "teal")));
  assert.ok(c.submit(ALICE, await profile.setField(c.state, ALICE, "key.x25519", "abcd")));
  assert.deepEqual(await profile.getFields(c.state, ALICE), { "app.demo.color": "teal", "key.x25519": "abcd" });
  assert.ok(c.submit(ALICE, await profile.setField(c.state, ALICE, "app.demo.color", undefined)));
  assert.equal(await profile.getField(c.state, ALICE, "app.demo.color"), undefined);
  assert.ok(!c.submit(BOB, await profile.setField(c.state, ALICE, "app.demo.color", "red")));
});

test("a profile holds several names, shows one, and names move between one's profiles", async () => {
  const c = chain({ [ALICE]: 100 });
  const bakery = await made(c, ALICE, { name: "Tess Bakes" }, "tessbakes");
  assert.ok(c.submit(ALICE, await profile.claim(c.state, ALICE, bakery, "tess_cafe")));
  // The first name stays the one shown.
  assert.equal((await profile.getProfile(c.state, bakery)).handle, "tessbakes");
  assert.ok(c.submit(ALICE, await profile.showName(c.state, ALICE, bakery, "tess_cafe")));
  assert.equal((await profile.getProfile(c.state, bakery)).handle, "tess_cafe");
  await assert.rejects(profile.showName(c.state, ALICE, bakery, "nobody"), /isn't on this profile/);
  // @tess_cafe to its own profile: it leaves showing it, the new one shows it.
  const cafe = await made(c, ALICE, { name: "Tess Café" });
  assert.ok(c.submit(ALICE, await profile.moveName(c.state, ALICE, "tess_cafe", cafe)));
  assert.equal((await profile.getProfile(c.state, cafe)).handle, "tess_cafe");
  assert.equal((await profile.getProfile(c.state, bakery)).handle, undefined);
  assert.deepEqual((await profile.namesOf(c.state, bakery)).map((e) => e.handle), ["tessbakes"]);
  assert.deepEqual((await profile.profilesOf(c.state, ALICE)).map((x) => x.id).sort(), [bakery, cafe].sort());
});

test("a sold name moves alone: the buyer's profile gets it, the seller keeps their card", async () => {
  const c = chain({ [ALICE]: 100, [BOB]: 1000 });
  const mira = await made(c, ALICE, { name: "Mira" }, "mira");
  assert.ok(c.submit(ALICE, await profile.claim(c.state, ALICE, mira, "mira_music")));
  assert.ok(c.submit(ALICE, await profile.list(c.state, ALICE, "mira", 500n)));
  assert.deepEqual((await profile.forSale(c.state)).map(({ handle, price }) => [handle, price]), [["mira", 500n]]);
  // Bob has no profile: one write makes it and buys the name onto it.
  const { id: bobs, write: make } = await profile.createProfile(c.state, BOB, { card: { name: "Bob" } });
  assert.ok(c.submit(BOB, profile.combine(make, await profile.buy(c.state, BOB, "mira", bobs, { created: true }))));
  assert.equal(c.coins.get(BOB), 1000n - 500n - 1n);
  assert.equal((await profile.profileOf(c.state, "mira")).name, "Bob");
  assert.equal((await profile.getProfile(c.state, bobs)).handle, "mira");
  // Alice's profile, card and other name stay hers; it no longer shows @mira.
  const after = await profile.getProfile(c.state, mira);
  assert.equal(after.name, "Mira");
  assert.equal(after.handle, undefined);
  assert.deepEqual((await profile.namesOf(c.state, mira)).map((e) => e.handle), ["mira_music"]);
});

test("a buyer whose price went stale, or a name not for sale, is refused and pays nothing", async () => {
  const c = chain({ [ALICE]: 100, [BOB]: 1000 });
  const a = await made(c, ALICE, undefined, "rare");
  const b = await made(c, BOB);
  assert.ok(c.submit(ALICE, await profile.list(c.state, ALICE, "rare", 300n)));
  const seen = await profile.buy(c.state, BOB, "rare", b);
  assert.ok(c.submit(ALICE, await profile.list(c.state, ALICE, "rare", 900n)));
  const before = c.coins.get(BOB);
  assert.ok(!c.submit(BOB, seen));
  assert.equal(c.coins.get(BOB), before);
  assert.ok(c.submit(ALICE, await profile.unlist(c.state, ALICE, "rare")));
  await assert.rejects(profile.buy(c.state, BOB, "rare", b), /not for sale/);
  assert.equal((await profile.resolve(c.state, "rare")).profile, a);
});

test("a name offered to a profile is taken by its owner for nothing, and by no one else", async () => {
  const c = chain({ [ALICE]: 100, [BOB]: 100, [CAROL]: 100 });
  await made(c, ALICE, undefined, "gift");
  const b = await made(c, BOB);
  const carols = await made(c, CAROL);
  assert.ok(c.submit(ALICE, await profile.offerName(c.state, ALICE, "gift", b)));
  await assert.rejects(profile.buy(c.state, CAROL, "gift", carols), /not for sale/);
  assert.ok(c.submit(BOB, await profile.moveName(c.state, BOB, "gift", b)));
  assert.equal((await profile.resolve(c.state, "gift")).profile, b);
  assert.equal(c.coins.get(ALICE), 100n - 2n);
});

test("a released name is free again, and its profile stops showing it", async () => {
  const c = chain({ [ALICE]: 100, [BOB]: 100 });
  const p = await made(c, ALICE, undefined, "gone");
  await assert.rejects(profile.release(c.state, BOB, "gone"), /isn't yours/);
  assert.ok(c.submit(ALICE, await profile.release(c.state, ALICE, "gone")));
  assert.equal(await profile.resolve(c.state, "gone"), undefined);
  assert.equal((await profile.getProfile(c.state, p)).handle, undefined);
  assert.deepEqual(await profile.namesOf(c.state, p), []);
  await made(c, BOB, undefined, "gone");
});

test("a sold profile moves whole: card, names and all", async () => {
  const c = chain({ [ALICE]: 100, [BOB]: 1000 });
  const p = await made(c, ALICE, { name: "Tess Bakes" }, "tessbakes");
  assert.ok(c.submit(ALICE, await profile.claim(c.state, ALICE, p, "tess_cafe")));
  assert.ok(c.submit(ALICE, await profile.setProfileTerms(c.state, ALICE, p, { price: 700n })));
  assert.ok(c.submit(BOB, await profile.takeProfile(c.state, BOB, p)));
  assert.equal(c.coins.get(ALICE), 100n - 3n + 700n);
  const now = await profile.getProfile(c.state, p);
  assert.deepEqual([now.owner, now.name, now.handle], [BOB, "Tess Bakes", "tessbakes"]);
  assert.deepEqual((await profile.namesOf(c.state, p)).map((e) => e.handle), ["tess_cafe", "tessbakes"]);
  assert.deepEqual(await profile.profilesOf(c.state, ALICE), []);
  assert.deepEqual((await profile.profilesOf(c.state, BOB)).map((x) => x.id), [p]);
  // The new owner edits it; the old one no longer can.
  assert.ok(c.submit(BOB, await profile.editCard(c.state, BOB, p, { description: "Under new ownership" })));
  await assert.rejects(profile.editCard(c.state, ALICE, p, { name: "Mine" }), /isn't yours/);
});

test("a profile's admins go with a sale: the seller's other account can't act for it", async () => {
  const c = chain({ [ALICE]: 100, [BOB]: 1000 });
  const p = await made(c, ALICE, { name: "Band" }, "band");
  assert.ok(c.submit(ALICE, await profile.setAdmin(c.state, ALICE, p, CAROL)));
  assert.ok(c.submit(ALICE, await profile.setProfileTerms(c.state, ALICE, p, { price: 50n })));
  assert.ok(c.submit(BOB, await profile.takeProfile(c.state, BOB, p)));
  assert.deepEqual(await profile.adminsOf(c.state, p), []);
  assert.ok(!(await profile.actsFor(c.state, CAROL, p)));
});

test("a name or profile priced at 0 is taken free: no payment", async () => {
  const c = chain({ [ALICE]: 100, [BOB]: 100 });
  const p = await made(c, ALICE, undefined, "gift");
  const b = await made(c, BOB);
  assert.ok(c.submit(ALICE, await profile.list(c.state, ALICE, "gift", 0n)));
  const buy = await profile.buy(c.state, BOB, "gift", b);
  assert.deepEqual(buy.payments, []);
  assert.ok(c.submit(BOB, buy));
  assert.ok(c.submit(ALICE, await profile.setProfileTerms(c.state, ALICE, p, { price: 0n })));
  assert.ok(c.submit(BOB, await profile.takeProfile(c.state, BOB, p)));
  assert.equal((await profile.profileToken(c.state, p)).owner, BOB);
});

test("offers go to someone else; prices fit a credit", async () => {
  const c = chain({ [ALICE]: 100 });
  const p = await made(c, ALICE, undefined, "mine");
  await assert.rejects(profile.setProfileTerms(c.state, ALICE, p, { offer: ALICE }), /someone else/);
  await assert.rejects(profile.offerName(c.state, ALICE, "mine", p), /someone else/);
  await assert.rejects(profile.list(c.state, ALICE, "mine", 2n ** 63n), /bad price/);
  assert.ok(c.submit(ALICE, await profile.list(c.state, ALICE, "mine", 2n ** 63n - 1n)));
});

test("combine keeps each key where it first comes, and refuses a key changed twice", async () => {
  const c = chain({ [ALICE]: 100 });
  const p = await made(c, ALICE, undefined, "one");
  const both = profile.combine(await profile.list(c.state, ALICE, "one", 5n), await profile.setProfileTerms(c.state, ALICE, p, { price: 9n }));
  assert.deepEqual(both.actions.map((a) => a.key), [`profile/${p}`, "name/one"]);
  assert.equal(both.actions[0].newValue, `${ALICE}@9`);
  assert.ok(c.submit(ALICE, both));
  const twice = [await profile.list(c.state, ALICE, "one", 1n), await profile.list(c.state, ALICE, "one", 2n)];
  assert.throws(() => profile.combine(...twice), /changed twice/);
});

test("a profile offered to an account is taken by it for nothing; that is how a lost key moves on", async () => {
  const c = chain({ [ALICE]: 100, [BOB]: 100, [CAROL]: 100 });
  const p = await made(c, ALICE, { name: "Alice" }, "alice");
  assert.ok(c.submit(ALICE, await profile.setProfileTerms(c.state, ALICE, p, { offer: BOB })));
  await assert.rejects(profile.takeProfile(c.state, CAROL, p), /not for sale/);
  assert.ok(c.submit(BOB, await profile.takeProfile(c.state, BOB, p)));
  assert.equal((await profile.profileOf(c.state, "alice")).owner, BOB);
});

test("admins are set and cleared by the owner; they act for the profile, not on its records", async () => {
  const c = chain({ [ALICE]: 100, [BOB]: 100 });
  const p = await made(c, ALICE, { name: "Band" }, "band");
  assert.ok(c.submit(ALICE, await profile.setAdmin(c.state, ALICE, p, BOB)));
  assert.deepEqual(await profile.adminsOf(c.state, p), [BOB]);
  assert.ok(await profile.actsFor(c.state, BOB, p));
  assert.ok(await profile.actsFor(c.state, ALICE, p));
  // On Moniker only the owner writes the profile's records.
  await assert.rejects(profile.editCard(c.state, BOB, p, { name: "Mine" }), /isn't yours/);
  assert.ok(c.submit(ALICE, await profile.setAdmin(c.state, ALICE, p, BOB, false)));
  assert.ok(!(await profile.actsFor(c.state, BOB, p)));
});

test("the wallet request carries the buy's payment", async () => {
  const c = chain({ [ALICE]: 100, [BOB]: 100 });
  await made(c, ALICE, undefined, "w");
  const b = await made(c, BOB);
  assert.ok(c.submit(ALICE, await profile.list(c.state, ALICE, "w", 25n)));
  const request = wallet.writeRequest(PATH, await profile.buy(c.state, BOB, "w", b), 2n);
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
  assert.ok(profile.isProfileId(profile.newProfileId()));
  for (const bad of ["", "abcdefghijklmno", "abcdefghijklmnop1", "ABCDEFGHIJKLMNOP", "abcdefghijklmno1"]) assert.ok(!profile.isProfileId(bad), bad);
  for (const bad of ["", "A", "a-b", "a.b", "é"]) assert.ok(!profile.isHandle(bad), bad);
});

test("runsMoniker recognises the chain spec", () => {
  const policy = { moduleCID: profile.MONIKER_POLICY, scope: "transaction", entrypoint: "lattice_validate_transaction" };
  assert.ok(profile.runsMoniker({ wasmPolicies: [policy] }));
  assert.ok(!profile.runsMoniker({ wasmPolicies: [{ ...policy, moduleCID: "bafyreiother" }] }));
  assert.ok(!profile.runsMoniker({}));
});
