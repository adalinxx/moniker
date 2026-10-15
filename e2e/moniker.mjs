// Moniker against a real node: a private host mines Nexus and a Moniker
// chain launched from chain/spec.json with the built policy, whose
// genesis pays the premine to Alice. Alice funds Bob, pins an avatar, writes
// her card with links and an encryption key, and claims a handle that her card shows.
// Every way of taking or forging a profile or handle without the right is
// refused. Alice lists her handle; Bob's buy at a price that went stale is
// refused, and his buy at the current price, with the handle on his card in
// the same transaction, goes through: the handle now shows on Bob's profile
// and no longer on Alice's. Last, Bob releases it and Alice claims it again.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/moniker.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mediaVolume, operator, readMedia } from "../client/media.mjs";
import * as profile from "../client/profile.mjs";
import { chainSpec, tip, view, volumeLoader } from "../client/state.mjs";
import * as wallet from "../client/wallet.mjs";

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
const [miner, alice, bob] = [account(), account(), account()];

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

const shown = async (who) => (await profile.getProfile(await state(), who.address)).handle;

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

  // A card with a pinned avatar, links, and a claimed handle shown on the card.
  const links = [{ label: "Website", url: "https://alice.example" }, { label: "GitHub", url: "https://github.com/alice" }];
  const avatar = mediaVolume(sdk, "image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const host = operator(`http://127.0.0.1:${rpc}`, readFileSync(`${root}/chains/Nexus/.cookie`, "utf8"));
  assert.ok((await host.pin(avatar)).pins.includes(avatar.cid));
  {
    const s = await state();
    await admitted(
      "Alice's card, key and handle",
      alice,
      profile.combine(
        await profile.editCard(s, alice.address, { name: "Alice", description: "Builds things", avatar: avatar.cid, handle: "alice", links }),
        await profile.setField(s, alice.address, "key.x25519", "alice-public-key"),
        await profile.claim(s, alice.address, "alice"),
      ),
    );
  }
  await until("Alice's profile is mined", async () => (await shown(alice)) === "alice");
  {
    const s = await state();
    assert.deepEqual(await profile.getProfile(s, alice.address), {
      address: alice.address,
      name: "Alice",
      description: "Builds things",
      avatar: avatar.cid,
      handle: "alice",
      links,
    });
    assert.deepEqual(await profile.getFields(s, alice.address), { "key.x25519": "alice-public-key" });
    const file = readMedia(sdk, await host.fetch(avatar.cid), { accept: (type) => type.startsWith("image/"), maxBytes: 1 << 20 });
    assert.equal(file?.type, "image/png");
  }
  console.log("Alice's card, avatar, links, key and @alice read back through the client");

  // Ways of forging a profile or taking a handle.
  const s = await state();
  const held = await profile.resolve(s, "alice");
  await refused("Bob edits Alice's card", bob, {
    actions: [{ key: profile.cardKey(alice.address), oldValue: await s.get(profile.cardKey(alice.address)), newValue: '{"name":"Not Alice"}' }],
  });
  await refused("Bob claims @alice over Alice", bob, { actions: [{ key: profile.handleKey("alice"), newValue: bob.address }] });
  await refused("Bob takes unlisted @alice, paying Alice", bob, {
    actions: [{ key: profile.handleKey("alice"), oldValue: held.value, newValue: bob.address }],
    payments: [{ to: alice.address, amount: 1000n }],
  });
  await refused("Bob claims @Bob", bob, { actions: [{ key: profile.handleKey("Bob"), newValue: bob.address }] });
  await refused("Bob claims @bob for a malformed holder", bob, {
    actions: [{ key: profile.handleKey("bob"), newValue: "bob" }],
  });
  await refused("Bob releases @alice", bob, { actions: [{ key: profile.handleKey("alice"), oldValue: held.value }] });

  // Sale: Alice lists at 500, then reprices to 600 before Bob's buy lands.
  await admitted("Alice lists @alice at 500", alice, profile.list(held, 500n));
  await until("the listing is mined", async () => (await profile.resolve(await state(), "alice"))?.price === 500n);
  const seenAt500 = await profile.resolve(await state(), "alice");
  assert.deepEqual((await profile.forSale(await state())).map((e) => [e.handle, e.price]), [["alice", 500n]]);
  await admitted("Alice reprices @alice to 600", alice, profile.list(seenAt500, 600n));
  await until("the new price is mined", async () => (await profile.resolve(await state(), "alice"))?.price === 600n);
  await refused("Bob buys @alice at the price he saw, 500", bob, profile.buy(seenAt500, bob.address));
  const at600 = await profile.resolve(await state(), "alice");
  await refused("Bob underpays for @alice", bob, { ...profile.buy(at600, bob.address), payments: [{ to: alice.address, amount: 599n }] });

  const [aliceBefore, bobBefore] = [await balance(alice), await balance(bob)];
  await admitted(
    "Bob buys @alice at 600 and shows it",
    bob,
    profile.combine(profile.buy(at600, bob.address), await profile.editCard(await state(), bob.address, { name: "Bob", handle: "alice" })),
  );
  await until("Bob's buy is mined", async () => (await shown(bob)) === "alice");
  assert.equal(await balance(alice), aliceBefore + 600n);
  assert.equal(await balance(bob), bobBefore - 601n);
  assert.equal(await shown(alice), undefined);
  console.log("Bob bought @alice alone at 600; it shows on his profile and no longer on Alice's");

  await refused("Alice takes @alice back", alice, {
    actions: [{ key: profile.handleKey("alice"), oldValue: bob.address, newValue: alice.address }],
  });
  await admitted("Bob releases @alice", bob, profile.release(await profile.resolve(await state(), "alice")));
  await until("the release is mined", async () => (await profile.resolve(await state(), "alice")) === undefined);
  await admitted("Alice claims @alice again", alice, await profile.claim(await state(), alice.address, "alice"));
  await until("Alice holds @alice again", async () => (await shown(alice)) === "alice");
  assert.equal(await shown(bob), undefined);
  console.log(`Bob released @alice and Alice claimed it again; her card shows it once more`);
} finally {
  try { lattice("mine", "stop"); } catch {}
  try { lattice("down"); } catch {}
}
