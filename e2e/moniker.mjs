// Moniker against a real node: a private host mines Nexus and a Moniker
// chain launched from chain/spec.json with the built policy, whose genesis
// pays the premine to Alice. Alice funds Bob, pins an avatar, makes a profile
// with a card and @alice, and a second name, @alice_art. Every way of taking
// or forging a profile, name or index key without the right is refused. A
// name sale moves only the name: Bob buys @alice_art onto a profile of his,
// and Alice's profile keeps its card and @alice. A profile sale moves it
// whole: Bob buys Alice's profile, card and @alice with it. A lost key is
// replaced by offering the profile to a new key, which takes it. Last, the
// library does the same through a wallet.
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
  await admitted("@alice_art on the same profile", alice, await profile.claim(await state(), alice.address, P, "alice_art"));
  await until("@alice_art is mined", async () => (await profile.resolve(await state(), "alice_art"))?.profile === P);
  {
    const s = await state();
    assert.deepEqual(await profile.getProfile(s, P), { id: P, owner: alice.address, name: "Alice", description: "Builds things", avatar: avatar.cid, links, handle: "alice" });
    assert.deepEqual((await profile.namesOf(s, P)).map((e) => e.handle), ["alice", "alice_art"]);
    assert.deepEqual((await profile.profilesOf(s, alice.address)).map((x) => x.id), [P]);
    assert.deepEqual(await profile.getFields(s, alice.address), { "key.x25519": "alice-public-key" });
    const file = readMedia(sdk, await host.fetch(avatar.cid), { accept: (type) => type.startsWith("image/"), maxBytes: 1 << 20 });
    assert.equal(file?.type, "image/png");
  }
  console.log("Alice's profile: card, avatar, links, key, and two names, read back through the client");

  // New records on a profile that exists: an admin, and the name it shows.
  await admitted("Alice makes Bob an admin", alice, await profile.setAdmin(await state(), alice.address, P, bob.address));
  await until("the admin is mined", async () => profile.actsFor(await state(), bob.address, P));
  await admitted("Alice shows @alice_art", alice, await profile.showName(await state(), alice.address, P, "alice_art"));
  await until("@alice_art is shown", async () => (await page("alice")).handle === "alice_art");
  await admitted("Alice shows @alice again", alice, await profile.showName(await state(), alice.address, P, "alice"));
  await until("@alice is shown again", async () => (await page("alice")).handle === "alice");
  console.log("an admin and a shown name written onto the existing profile");

  // Ways of forging a profile, a name or an index.
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
    await refused("Bob claims a name onto Alice's profile", bob, { actions: [{ key: profile.profileKey(P), oldValue: token.value, newValue: token.value }, { key: profile.nameKey("bob"), newValue: P }, { key: profile.holdsKey(P, "bob"), newValue: "1" }] });
    await refused("Bob releases @alice", bob, { actions: [{ key: profile.profileKey(P), oldValue: token.value, newValue: token.value }, { key: profile.nameKey("alice"), oldValue: held.value }, { key: profile.holdsKey(P, "alice"), oldValue: "1" }] });
    await refused("Bob claims a name held by an account", bob, { actions: [{ key: profile.nameKey("bob"), newValue: bob.address }] });
  }

  // A name sale moves only the name.
  const bobs = await profile.createProfile(await state(), bob.address, { card: { name: "Bob" } });
  await admitted("Bob's profile", bob, bobs.write);
  await until("Bob's profile is mined", async () => (await profile.getProfile(await state(), bobs.id))?.owner === bob.address);
  await admitted("Alice lists @alice_art at 500", alice, await profile.list(await state(), alice.address, "alice_art", 500n));
  await until("the listing is mined", async () => (await profile.resolve(await state(), "alice_art"))?.price === 500n);
  const seenAt500 = await profile.buy(await state(), bob.address, "alice_art", bobs.id);
  await admitted("Alice reprices @alice_art to 600", alice, await profile.list(await state(), alice.address, "alice_art", 600n));
  await until("the new price is mined", async () => (await profile.resolve(await state(), "alice_art"))?.price === 600n);
  await refused("Bob buys @alice_art at the price he saw, 500", bob, seenAt500);
  {
    const [aliceBefore, bobBefore] = [await balance(alice), await balance(bob)];
    await admitted("Bob buys @alice_art at 600", bob, await profile.buy(await state(), bob.address, "alice_art", bobs.id));
    await until("Bob's buy is mined", async () => (await profile.resolve(await state(), "alice_art"))?.profile === bobs.id);
    assert.equal(await balance(alice), aliceBefore + 600n);
    assert.equal(await balance(bob), bobBefore - 601n);
    assert.equal((await page("alice_art")).name, "Bob");
    assert.equal((await page("alice")).name, "Alice");
  }
  console.log("Bob bought @alice_art alone at 600: it shows his card, and Alice's profile keeps its card and @alice");

  // A profile sale moves it whole.
  await admitted("Alice puts her profile up at 900", alice, await profile.setProfileTerms(await state(), alice.address, P, { price: 900n }));
  await until("the profile listing is mined", async () => (await profile.getProfile(await state(), P))?.price === 900n);
  await admitted("Bob buys Alice's profile at 900", bob, await profile.takeProfile(await state(), bob.address, P));
  await until("Bob's profile buy is mined", async () => (await profile.getProfile(await state(), P))?.owner === bob.address);
  {
    const s = await state();
    const bought = await profile.getProfile(s, P);
    assert.deepEqual([bought.name, bought.handle], ["Alice", "alice"]);
    assert.deepEqual(await profile.profilesOf(s, alice.address), []);
    assert.deepEqual((await profile.profilesOf(s, bob.address)).map((x) => x.id).sort(), [P, bobs.id].sort());
  }
  console.log("Bob bought Alice's profile whole: its card and @alice came with it");

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
  console.log("the profile moved to a new key, card and names with it");

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
  assert.deepEqual((await moniker.profiles([bobs.id, P])).map((p) => p.handle), ["alice_art", "alice"]);
  assert.equal(moniker.label(await moniker.profile(bobs.id)), "Bob");
  const { id: carols } = await moniker.createProfile({ card: { name: "Carol" }, handle: "carol" }, { wallet: walletOf(alice) });
  await until("the library's profile", async () => (await moniker.profileOf("carol"))?.id === carols);
  await moniker.save(carols, { links: [{ label: "Carol's site", url: "https://carol.example" }] }, { wallet: walletOf(alice) });
  await until("the library's save", async () => (await moniker.profile(carols))?.links?.length === 1);
  await moniker.sell("@carol", 7n, { wallet: walletOf(alice) });
  await until("the library's listing", async () => (await moniker.forSale()).some((e) => e.handle === "carol" && e.price === 7n));
  await moniker.buy("carol", bobs.id, { wallet: walletOf(bob) });
  await until("the library's buy", async () => (await moniker.resolve("carol")) === bobs.id);
  await assert.rejects(moniker.save(carols, { name: "x" }, {}), /needs the Lattice Wallet/);
  console.log("the library reads profiles and names, makes and saves a profile, and sells and buys a name through a wallet");
} finally {
  try { lattice("mine", "stop"); } catch {}
  try { lattice("down"); } catch {}
}
