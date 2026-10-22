// Moniker against a real node: a private host mines Nexus and a Moniker
// chain launched from chain/spec.json with the built policy, whose genesis
// pays the premine to Alice. Alice funds Bob, pins an avatar, makes a profile
// with a card and @alice, and a second name, @alice_art, pointed at it. Every
// way of taking or forging a profile, name, pointer or index key without the
// right is refused. A name sale moves only the name: Bob buys @alice_art and
// points it at his profile, and Alice's keeps its card and @alice. A name may
// point at anyone's profile, which may show it; a name may point nowhere. A
// profile sale moves its card: Bob buys Alice's profile, and @alice stays
// hers, still pointing at it. A lost key is replaced by offering the profile
// to a new key, which takes it. Last, the library does the same through a
// wallet.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/moniker.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mediaVolume, operator, readMedia } from "../client/media.mjs";
import * as profile from "../sdk/src/records/profile.mjs";
import { chainSpec, tip, view, volumeLoader } from "../sdk/src/records/state.mjs";
import * as wallet from "../sdk/src/records/wallet.mjs";
import { createMoniker } from "../sdk/src/index.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const CHAIN = profile.MONIKER_CHAIN;
const [listen, rpc, publicRead] = [25021, 29190, 29191];
const node = `http://127.0.0.1:${publicRead}`;
const MODULE = here("../policy/target/wasm32-unknown-unknown/release/moniker_policy.wasm");
const SPEC = here("../chain/spec.json");

const root = mkdtempSync(`${tmpdir()}/moniker-e2e-`);
const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
function configure(change) {
  const file = `${root}/lattice.json`;
  const topology = JSON.parse(readFileSync(file, "utf8"));
  change(topology);
  writeFileSync(file, JSON.stringify(topology, null, 2));
}

const account = () => sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const [miner, alice, bob, newKey] = [account(), account(), account(), account()];

async function until(label, condition, seconds = Number(process.env.E2E_SECONDS ?? 300)) {
  const deadline = Date.now() + seconds * 1000;
  let failure;
  for (;;) {
    const value = await condition().catch((error) => void (failure = error));
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`, { cause: failure });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function api(path) {
  const url = new URL(path, node);
  url.searchParams.set("chainPath", CHAIN.join("/"));
  const response = await fetch(url);
  return response.ok ? response.json() : undefined;
}
const balance = async (who) => BigInt((await api(`/api/state/account/${who.address}`))?.balance ?? 0);
const nonce = async (who) => BigInt((await api(`/api/state/account/${who.address}`))?.nonce ?? 0);

const volumes = () => new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: CHAIN }));

/** The chain's state at the node's tip, read through the client. */
async function state() {
  const client = volumes();
  const { generalStateCID } = await tip(sdk, node, CHAIN, client);
  return view(volumeLoader(client, sdk.decodeDagCbor), generalStateCID);
}

/** Signs a body by `who` and submits it. Resolves to `{ ok, status, text }`. */
async function submit(who, body) {
  const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
  const response = await fetch(new URL("/transactions", node), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

/** `who` sends a client write (`{ actions, payments }`), paying a fee of 1. */
async function send(who, write) {
  const body = wallet.transaction({ owner: who.address, ...write, fee: 1n, nonce: await nonce(who), chainPath: CHAIN });
  return submit(who, body);
}

async function admitted(label, who, write) {
  const result = await send(who, write);
  assert.ok(result.ok, `${label}: ${result.status} ${result.text}`);
}

async function refused(label, who, write) {
  const result = await send(who, write);
  assert.ok(!result.ok, `${label} was admitted`);
  console.log(`  refused: ${label} (${result.status} ${result.text.trim()})`);
}

/** The profile holding `@handle`, as any app reads it. */
const page = async (handle) => profile.profileOf(await state(), handle);

try {
  lattice("init");
  configure((topology) => {
    Object.assign(topology, { listen, rpc, publicRead, webSocket: 0, publicSubmit: true });
    topology.publicReadExpensiveRate = 1000;
    topology.peers = [];
    topology.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("child", "create", CHAIN.join("/"), "--spec", SPEC, "--policy-module", MODULE, "--premine-to", alice.address);
  configure((topology) => {
    topology.mine.recipients = { Nexus: miner.address, [CHAIN.join("/")]: miner.address };
  });
  lattice("up");
  lattice("mine", "start");

  await until("the Moniker genesis is mined", async () => (await balance(alice)) > 0n);
  {
    const client = volumes();
    assert.ok(profile.runsMoniker(await chainSpec(sdk, client, (await tip(sdk, node, CHAIN, client)).specCID)));
    console.log(`Moniker launched; the client finds the Moniker policy in its spec; Alice holds ${await balance(alice)}`);
  }
  await admitted("Alice funds Bob", alice, { actions: [], payments: [{ to: bob.address, amount: 2000n }] });
  await until("Bob is funded", async () => (await balance(bob)) === 2000n);

  // A profile with a pinned avatar, links and @alice, in one write.
  const links = [{ label: "Website", url: "https://alice.example" }, { label: "GitHub", url: "https://github.com/alice" }];
  const avatar = mediaVolume(sdk, "image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const host = operator(`http://127.0.0.1:${rpc}`, readFileSync(`${root}/chains/Nexus/.cookie`, "utf8"));
  assert.ok((await host.pin(avatar)).pins.includes(avatar.cid));
  const made = await profile.createProfile(await state(), alice.address, { card: { name: "Alice", description: "Builds things", avatar: avatar.cid, links }, handle: "alice" });
  const P = made.id;
  await admitted("Alice's profile with @alice", alice, profile.combine(made.write, await profile.setField(await state(), alice.address, "key.x25519", "alice-public-key")));
  await until("Alice's profile is mined", async () => (await page("alice"))?.id === P);
  await admitted("@alice_art pointed at the same profile", alice, await profile.claim(await state(), alice.address, "alice_art", { point: P }));
  await until("@alice_art is mined", async () => (await profile.resolve(await state(), "alice_art"))?.profile === P);
  {
    const s = await state();
    assert.deepEqual(await profile.getProfile(s, P), { id: P, owner: alice.address, name: "Alice", description: "Builds things", avatar: avatar.cid, links, handle: "alice" });
    assert.deepEqual((await profile.namesOf(s, alice.address)).map((e) => [e.handle, e.profile]), [["alice", P], ["alice_art", P]]);
    assert.deepEqual((await profile.profilesOf(s, alice.address)).map((x) => x.id), [P]);
    assert.deepEqual(await profile.getFields(s, alice.address), { "key.x25519": "alice-public-key" });
    const file = readMedia(sdk, await host.fetch(avatar.cid), { accept: (type) => type.startsWith("image/"), maxBytes: 1 << 20 });
    assert.equal(file?.type, "image/png");
  }
  console.log("Alice's profile: card, avatar, links, key, and two names pointing at it, read back through the client");

  // New records on a profile that exists: an admin, and its default name.
  await admitted("Alice makes Bob an admin", alice, await profile.setAdmin(await state(), alice.address, P, bob.address));
  await until("the admin is mined", async () => profile.actsFor(await state(), bob.address, P));
  await admitted("Alice shows @alice_art", alice, await profile.showName(await state(), alice.address, P, "alice_art"));
  await until("@alice_art is shown", async () => (await page("alice")).handle === "alice_art");
  await admitted("Alice shows @alice again", alice, await profile.showName(await state(), alice.address, P, "alice"));
  await until("@alice is shown again", async () => (await page("alice")).handle === "alice");
  console.log("an admin and a default name written onto the existing profile");

  const bobs = await profile.createProfile(await state(), bob.address, { card: { name: "Bob" } });
  await admitted("Bob's profile", bob, bobs.write);
  await until("Bob's profile is mined", async () => (await profile.getProfile(await state(), bobs.id))?.owner === bob.address);

  // Ways of forging a profile, a name, a pointer or an index.
  {
    const s = await state();
    const token = await profile.profileToken(s, P);
    const held = await profile.resolve(s, "alice");
    await refused("Bob edits Alice's card", bob, {
      actions: [{ key: profile.profileKey(P), oldValue: token.value, newValue: token.value }, { key: profile.cardKey(P), oldValue: await s.get(profile.cardKey(P)), newValue: '{"name":"Not Alice"}' }],
    });
    await refused("Bob takes Alice's unpriced profile", bob, {
      actions: [{ key: profile.profileKey(P), oldValue: token.value, newValue: bob.address }, { key: profile.ownsKey(alice.address, P), oldValue: "1" }, { key: profile.ownsKey(bob.address, P), newValue: "1" }],
      payments: [{ to: alice.address, amount: 1000n }],
    });
    await refused("Bob lists Alice's profile among his", bob, { actions: [{ key: profile.ownsKey(bob.address, P), newValue: "1" }] });
    await refused("Bob points @alice at his profile", bob, { actions: [{ key: profile.nameKey("alice"), oldValue: held.value, newValue: held.value }, { key: profile.pointsKey("alice"), oldValue: P, newValue: bobs.id }] });
    await refused("Bob writes @alice's pointer alone", bob, { actions: [{ key: profile.pointsKey("alice"), oldValue: P, newValue: bobs.id }] });
    await refused("Bob releases @alice", bob, { actions: [{ key: profile.nameKey("alice"), oldValue: held.value }, { key: profile.namesKey(alice.address, "alice"), oldValue: "1" }, { key: profile.pointsKey("alice"), oldValue: P }] });
    await refused("Bob claims a name without its index key", bob, { actions: [{ key: profile.nameKey("bob"), newValue: bob.address }] });
    await refused("Bob claims a name onto Alice's account", bob, { actions: [{ key: profile.nameKey("bob"), newValue: alice.address }, { key: profile.namesKey(alice.address, "bob"), newValue: "1" }] });
    await refused("Bob lists @alice among his names", bob, { actions: [{ key: profile.namesKey(bob.address, "alice"), newValue: "1" }] });
  }

  // A name sale moves only the name.
  await admitted("Alice lists @alice_art at 500", alice, await profile.list(await state(), alice.address, "alice_art", 500n));
  await until("the listing is mined", async () => (await profile.resolve(await state(), "alice_art"))?.price === 500n);
  const seenAt500 = await profile.buy(await state(), bob.address, "alice_art", { point: bobs.id });
  await admitted("Alice reprices @alice_art to 600", alice, await profile.list(await state(), alice.address, "alice_art", 600n));
  await until("the new price is mined", async () => (await profile.resolve(await state(), "alice_art"))?.price === 600n);
  await refused("Bob buys @alice_art at the price he saw, 500", bob, seenAt500);
  {
    const [aliceBefore, bobBefore] = [await balance(alice), await balance(bob)];
    await admitted("Bob buys @alice_art at 600, pointing it at his profile", bob, await profile.buy(await state(), bob.address, "alice_art", { point: bobs.id }));
    await until("Bob's buy is mined", async () => (await profile.resolve(await state(), "alice_art"))?.profile === bobs.id);
    assert.equal(await balance(alice), aliceBefore + 600n);
    assert.equal(await balance(bob), bobBefore - 601n);
    assert.equal((await profile.resolve(await state(), "alice_art")).owner, bob.address);
    assert.deepEqual((await profile.namesOf(await state(), alice.address)).map((e) => e.handle), ["alice"]);
    assert.equal((await page("alice_art")).name, "Bob");
    assert.equal((await page("alice")).name, "Alice");
  }
  console.log("Bob bought @alice_art alone at 600 and pointed it at his card; Alice's profile keeps its card and @alice");

  // A name lent to someone else's profile, which shows it; then pointed nowhere.
  await admitted("Alice claims @alice_lend pointed at Bob's profile", alice, await profile.claim(await state(), alice.address, "alice_lend", { point: bobs.id }));
  await until("@alice_lend points at Bob's", async () => (await profile.resolve(await state(), "alice_lend"))?.profile === bobs.id);
  await admitted("Bob shows @alice_lend", bob, await profile.showName(await state(), bob.address, bobs.id, "alice_lend"));
  await until("Bob's profile shows @alice_lend", async () => (await profile.getProfile(await state(), bobs.id))?.handle === "alice_lend");
  await admitted("Alice points @alice_lend nowhere", alice, await profile.pointName(await state(), alice.address, "alice_lend", undefined));
  await until("@alice_lend points nowhere", async () => (await profile.resolve(await state(), "alice_lend"))?.pointer === undefined);
  assert.equal((await profile.getProfile(await state(), bobs.id)).handle, undefined);
  assert.equal(await profile.profileOf(await state(), "alice_lend"), undefined);
  console.log("a name lent to Bob's profile was shown there, and stopped showing once pointed nowhere");

  // A name offered to an account: taken, it keeps pointing where it did.
  await admitted("Alice points @alice_lend at her profile", alice, await profile.pointName(await state(), alice.address, "alice_lend", P));
  await until("@alice_lend points at Alice's", async () => (await profile.resolve(await state(), "alice_lend"))?.profile === P);
  await admitted("Alice offers @alice_lend to Bob", alice, await profile.offerName(await state(), alice.address, "alice_lend", bob.address));
  await until("the name offer is mined", async () => (await profile.resolve(await state(), "alice_lend"))?.offer === bob.address);
  // The miner, paid on this chain, so only the policy stands in the way.
  await refused("the miner takes the name offered to Bob", miner, {
    actions: [{ key: profile.nameKey("alice_lend"), oldValue: `${alice.address}>${bob.address}`, newValue: miner.address }, { key: profile.namesKey(alice.address, "alice_lend"), oldValue: "1" }, { key: profile.namesKey(miner.address, "alice_lend"), newValue: "1" }],
  });
  await admitted("Bob takes @alice_lend", bob, await profile.buy(await state(), bob.address, "alice_lend"));
  await until("Bob holds @alice_lend", async () => (await profile.resolve(await state(), "alice_lend"))?.owner === bob.address);
  assert.equal((await profile.resolve(await state(), "alice_lend")).profile, P);
  console.log("a name offered to Bob's account: taken, still pointing at Alice's profile until he points it");

  // A name with no profile.
  await admitted("Bob releases @alice_lend", bob, await profile.release(await state(), bob.address, "alice_lend"));
  await until("@alice_lend is free", async () => (await profile.resolve(await state(), "alice_lend")) === undefined);
  await admitted("Bob claims @bobs_spare, pointing nowhere", bob, await profile.claim(await state(), bob.address, "bobs_spare"));
  await until("@bobs_spare is mined", async () => (await profile.resolve(await state(), "bobs_spare"))?.owner === bob.address);
  assert.equal((await profile.resolve(await state(), "bobs_spare")).profile, undefined);
  console.log("a name released frees it and its pointer; a name may point at no profile");

  // A profile sale moves its card; names stay with their owner.
  await admitted("Alice puts her profile up at 900", alice, await profile.setProfileTerms(await state(), alice.address, P, { price: 900n }));
  await until("the profile listing is mined", async () => (await profile.getProfile(await state(), P))?.price === 900n);
  await admitted("Bob buys Alice's profile at 900", bob, await profile.takeProfile(await state(), bob.address, P));
  await until("Bob's profile buy is mined", async () => (await profile.getProfile(await state(), P))?.owner === bob.address);
  {
    const s = await state();
    const bought = await profile.getProfile(s, P);
    // @alice is still Alice's, still pointing at it, so it still shows it.
    assert.deepEqual([bought.name, bought.handle], ["Alice", "alice"]);
    assert.equal((await profile.resolve(s, "alice")).owner, alice.address);
    assert.equal(await profile.actsFor(s, bob.address, P), true);
    assert.deepEqual(await profile.adminsOf(s, P), []);
    assert.deepEqual(await profile.profilesOf(s, alice.address), []);
    assert.deepEqual((await profile.profilesOf(s, bob.address)).map((x) => x.id).sort(), [P, bobs.id].sort());
  }
  console.log("Bob bought Alice's profile: its card came, its admins were cleared, and @alice stayed Alice's");

  // A lost key: Bob offers the profile to a new key of his, which takes it.
  await admitted("Bob offers the profile to his new key", bob, await profile.setProfileTerms(await state(), bob.address, P, { offer: newKey.address }));
  await until("the offer is mined", async () => (await profile.getProfile(await state(), P))?.offer === newKey.address);
  // The SDK won't build it; written by hand, the policy refuses it.
  await refused("Alice takes the profile offered to Bob's new key", alice, {
    actions: [{ key: profile.profileKey(P), oldValue: `${bob.address}>${newKey.address}`, newValue: alice.address }, { key: profile.ownsKey(bob.address, P), oldValue: "1" }, { key: profile.ownsKey(alice.address, P), newValue: "1" }],
  });
  await admitted("Bob funds the new key", bob, { actions: [], payments: [{ to: newKey.address, amount: 10n }] });
  await until("the new key is funded", async () => (await balance(newKey)) === 10n);
  await admitted("The new key takes the profile", newKey, await profile.takeProfile(await state(), newKey.address, P));
  await until("the move is mined", async () => (await profile.getProfile(await state(), P))?.owner === newKey.address);
  console.log("the profile moved to a new key");

  // The library, as another app uses it: reads, and writes through a wallet.
  const moniker = createMoniker({ sdk, nodes: [node], chain: CHAIN, freshFor: 0 });
  /** A stand-in for window.lattice holding `who`'s key: it signs what a wallet would. */
  const walletOf = (who) => ({
    address: async () => who.address,
    connect: async () => who.address,
    async writeRecords(request) {
      const payments = (request.payments ?? []).map(({ to, amount }) => ({ to, amount: BigInt(amount) }));
      const body = wallet.transaction({ owner: who.address, actions: request.actions, payments, fee: BigInt(request.fee), nonce: await nonce(who), chainPath: request.chainPath });
      const result = await submit(who, body);
      if (!result.ok) throw new Error(`refused: ${result.text}`);
      return JSON.parse(result.text);
    },
  });
  assert.equal(await moniker.resolve("@alice"), P);
  assert.equal((await moniker.profileOf("alice")).owner, newKey.address);
  assert.equal((await moniker.name("alice")).owner, alice.address);
  // Bob's profile shows @alice_lend, released since: it shows no name.
  assert.deepEqual((await moniker.profiles([bobs.id, P])).map((p) => p.handle), [undefined, "alice"]);
  assert.equal(moniker.label(await moniker.profile(bobs.id)), "Bob");
  const { id: carols } = await moniker.createProfile({ card: { name: "Carol" }, handle: "carol" }, { wallet: walletOf(alice) });
  await until("the library's profile", async () => (await moniker.profileOf("carol"))?.id === carols);
  await moniker.save(carols, { links: [{ label: "Carol's site", url: "https://carol.example" }] }, { wallet: walletOf(alice) });
  await until("the library's save", async () => (await moniker.profile(carols))?.links?.length === 1);
  await moniker.sell("@carol", 7n, { wallet: walletOf(alice) });
  await until("the library's listing", async () => (await moniker.forSale()).some((e) => e.handle === "carol" && e.price === 7n && e.owner === alice.address));
  await moniker.buy("carol", { point: bobs.id }, { wallet: walletOf(bob) });
  await until("the library's buy", async () => (await moniker.resolve("carol")) === bobs.id);
  assert.deepEqual((await moniker.names(bob.address)).map((n) => n.handle), ["alice_art", "bobs_spare", "carol"]);
  await moniker.point("carol", carols, { wallet: walletOf(bob) });
  await until("the library's pointer", async () => (await moniker.resolve("carol")) === carols);
  await assert.rejects(moniker.save(carols, { name: "x" }, {}), /needs the Lattice Wallet/);
  console.log("the library reads profiles and names, makes and saves a profile, and sells, buys and points a name through a wallet");
} finally {
  try { lattice("mine", "stop"); } catch {}
  try { lattice("down"); } catch {}
}
