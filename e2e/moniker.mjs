// Moniker, the names chain, against a real node: a private host mines Nexus
// and a Moniker chain launched from chain/spec.json with the built policy,
// whose genesis pays the premine to Alice. Alice claims @alice pointed at
// herself and shows it. A name points at any account, which shows it only
// once it names it too. Every way of taking a name, or writing its pointer,
// index keys or another account's records, without the right is refused. A
// sale moves the name and clears its pointer: Alice stops showing it until
// she points another name at herself; Bob shows it once he points it at
// himself. A name offered to an account is taken by it alone. Releasing a
// name deletes its pointer. Last, moniker-sdk does the same through a wallet.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/moniker.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as names from "../sdk/src/records/names.mjs";
import { chainSpec, tip, view, volumeLoader } from "../sdk/src/records/state.mjs";
import * as wallet from "../sdk/src/records/wallet.mjs";
import { createMoniker } from "../sdk/src/index.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const CHAIN = ["Nexus", "moniker"];
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
const [miner, alice, bob, carol] = [account(), account(), account(), account()];

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
const name = async (handle) => names.resolve(await state(), handle);
const shows = async (who) => names.handleOf(await state(), who.address);

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
    const spec = await chainSpec(sdk, client, (await tip(sdk, node, CHAIN, client)).specCID);
    const want = JSON.parse(readFileSync(SPEC, "utf8")).wasmPolicies[0].moduleCID;
    assert.deepEqual(spec.wasmPolicies.map((p) => p.moduleCID), [want]);
    assert.ok(names.runsMoniker(spec), "the SDK finds the Moniker policy in the spec");
    console.log(`Moniker launched under policy ${want}; Alice holds ${await balance(alice)}`);
  }
  await admitted("Alice funds Bob", alice, { actions: [], payments: [{ to: bob.address, amount: 2000n }] });
  await until("Bob is funded", async () => (await balance(bob)) === 2000n);

  // A name pointed at its owner, then shown by her.
  await admitted("Alice claims @alice, pointed at herself", alice, await names.claim(await state(), alice.address, "alice", { point: true }));
  await until("@alice is mined", async () => (await name("alice"))?.pointer === alice.address);
  assert.equal(await shows(alice), undefined);
  await admitted("Alice shows @alice", alice, await names.showName(await state(), alice.address, "alice"));
  await until("Alice shows @alice", async () => (await shows(alice)) === "alice");
  {
    const s = await state();
    const held = await names.resolve(s, "alice");
    assert.deepEqual([held.owner, held.pointer], [alice.address, alice.address]);
    assert.deepEqual((await names.namesOf(s, alice.address)).map((n) => n.handle), ["alice"]);
    assert.equal(await names.getField(s, alice.address, "name"), "alice");
  }
  console.log("@alice is Alice's, points at her, and her account shows it");

  // A name pointed at another account shows there once that account names it; pointed away, it stops.
  await admitted("Alice claims @alice_lend, pointed at Bob", alice, await names.claim(await state(), alice.address, "alice_lend", { point: bob.address }));
  await until("@alice_lend points at Bob", async () => (await name("alice_lend"))?.pointer === bob.address);
  assert.equal(await shows(bob), undefined);
  await admitted("Bob shows @alice_lend", bob, await names.showName(await state(), bob.address, "alice_lend"));
  await until("Bob shows @alice_lend", async () => (await shows(bob)) === "alice_lend");
  await admitted("Alice points @alice_lend at herself", alice, await names.pointName(await state(), alice.address, "alice_lend", true));
  await until("@alice_lend points at Alice", async () => (await name("alice_lend"))?.pointer === alice.address);
  assert.equal(await shows(bob), undefined);
  assert.equal(await shows(alice), "alice");
  // Naming a handle that points elsewhere shows nothing.
  await admitted("Bob names @alice on his account", bob, { actions: [{ key: names.shownKey(bob.address), oldValue: "alice_lend", newValue: "alice" }] });
  await until("Bob names @alice", async () => (await names.getField(await state(), bob.address, "name")) === "alice");
  assert.equal(await shows(bob), undefined);
  await admitted("Bob stops showing", bob, await names.stopShowing(await state(), bob.address));
  await until("Bob names nothing", async () => (await names.getField(await state(), bob.address, "name")) === undefined);
  console.log("a name lent to Bob showed on his account until pointed away; naming a handle alone shows nothing");

  // Ways of taking a name, or writing its pointer, index keys or another's records, without the right.
  {
    const s = await state();
    const held = await names.resolve(s, "alice");
    const proof = { key: names.nameKey("alice"), oldValue: held.value, newValue: held.value };
    await refused("Bob points @alice at himself", bob, { actions: [proof, { key: names.pointsKey("alice"), oldValue: alice.address, newValue: bob.address }] });
    await refused("Bob writes @alice's pointer alone", bob, { actions: [{ key: names.pointsKey("alice"), oldValue: alice.address, newValue: bob.address }] });
    await refused("Alice points @alice at something not an account", alice, { actions: [proof, { key: names.pointsKey("alice"), oldValue: alice.address, newValue: "not an account" }] });
    await refused("Bob releases @alice", bob, { actions: [{ key: names.nameKey("alice"), oldValue: held.value }, { key: names.namesKey(alice.address, "alice"), oldValue: "1" }, { key: names.pointsKey("alice"), oldValue: alice.address }] });
    await refused("Bob takes @alice, unpriced, paying her", bob, {
      actions: [{ key: names.nameKey("alice"), oldValue: held.value, newValue: bob.address }, { key: names.namesKey(alice.address, "alice"), oldValue: "1" }, { key: names.namesKey(bob.address, "alice"), newValue: "1" }],
      payments: [{ to: alice.address, amount: 1000n }],
    });
    await refused("Bob claims a name without its index key", bob, { actions: [{ key: names.nameKey("bob"), newValue: bob.address }] });
    await refused("Bob claims a name onto Alice's account", bob, { actions: [{ key: names.nameKey("bob"), newValue: alice.address }, { key: names.namesKey(alice.address, "bob"), newValue: "1" }] });
    await refused("Bob lists @alice among his names", bob, { actions: [{ key: names.namesKey(bob.address, "alice"), newValue: "1" }] });
    await refused("Bob changes the handle Alice shows", bob, { actions: [{ key: names.shownKey(alice.address), oldValue: "alice", newValue: "alice_lend" }] });
    await refused("Alice writes a per-chain pointer", alice, { actions: [proof, { key: "points/alice/Nexus/testnet/rave", newValue: alice.address }] });
  }

  // A sale moves the name and clears its pointer: the seller stops showing it.
  await admitted("Alice lists @alice at 500", alice, await names.list(await state(), alice.address, "alice", 500n));
  await until("the listing is mined", async () => (await name("alice"))?.price === 500n);
  const seenAt500 = await names.buy(await state(), bob.address, "alice");
  await admitted("Alice reprices @alice to 600", alice, await names.list(await state(), alice.address, "alice", 600n));
  await until("the new price is mined", async () => (await name("alice"))?.price === 600n);
  await refused("Bob buys @alice at the price he saw, 500", bob, seenAt500);
  {
    const [aliceBefore, bobBefore] = [await balance(alice), await balance(bob)];
    await admitted("Bob buys @alice at 600", bob, await names.buy(await state(), bob.address, "alice"));
    await until("Bob's buy is mined", async () => (await name("alice"))?.owner === bob.address);
    assert.equal(await balance(alice), aliceBefore + 600n);
    assert.equal(await balance(bob), bobBefore - 601n);
    const s = await state();
    assert.equal((await names.resolve(s, "alice")).pointer, undefined);
    assert.equal(await names.handleOf(s, alice.address), undefined);
    assert.deepEqual((await names.namesOf(s, alice.address)).map((n) => n.handle), ["alice_lend"]);
  }
  await refused("Alice, its seller, points @alice back at herself", alice, {
    actions: [{ key: names.nameKey("alice"), oldValue: bob.address, newValue: bob.address }, { key: names.pointsKey("alice"), newValue: alice.address }],
  });
  await admitted("Bob shows @alice, pointing it at himself in the same write", bob, await names.showName(await state(), bob.address, "alice"));
  await until("Bob shows @alice", async () => (await shows(bob)) === "alice");
  await admitted("Alice shows @alice_lend", alice, await names.showName(await state(), alice.address, "alice_lend"));
  await until("Alice shows @alice_lend", async () => (await shows(alice)) === "alice_lend");
  console.log("Bob bought @alice at 600: its pointer cleared, Alice stopped showing it, and Bob shows it now");

  // A name offered to an account: only that account takes it.
  await admitted("Alice claims @alice_gift, pointed at herself", alice, await names.claim(await state(), alice.address, "alice_gift", { point: true }));
  await until("@alice_gift is mined", async () => (await name("alice_gift"))?.owner === alice.address);
  await admitted("Alice offers @alice_gift to Bob", alice, await names.offerName(await state(), alice.address, "alice_gift", bob.address));
  await until("the offer is mined", async () => (await name("alice_gift"))?.offer === bob.address);
  // The miner, paid on this chain, so only the policy stands in the way.
  await refused("the miner takes the name offered to Bob", miner, {
    actions: [{ key: names.nameKey("alice_gift"), oldValue: `${alice.address}>${bob.address}`, newValue: miner.address }, { key: names.namesKey(alice.address, "alice_gift"), oldValue: "1" }, { key: names.namesKey(miner.address, "alice_gift"), newValue: "1" }],
  });
  await admitted("Bob takes @alice_gift, pointing it at himself", bob, await names.buy(await state(), bob.address, "alice_gift", { point: true }));
  await until("Bob holds @alice_gift", async () => (await name("alice_gift"))?.owner === bob.address);
  assert.equal((await name("alice_gift")).pointer, bob.address);
  console.log("a name offered to Bob: the miner can't take it, Bob does, pointing it at himself");

  // Releasing a name deletes its pointer; anyone may claim it next.
  await refused("Bob releases @alice_gift and repoints it", bob, {
    actions: [{ key: names.nameKey("alice_gift"), oldValue: bob.address }, { key: names.namesKey(bob.address, "alice_gift"), oldValue: "1" }, { key: names.pointsKey("alice_gift"), oldValue: bob.address, newValue: alice.address }],
  });
  await admitted("Bob releases @alice_gift", bob, await names.release(await state(), bob.address, "alice_gift"));
  await until("@alice_gift is free", async () => (await name("alice_gift")) === undefined);
  assert.equal(await names.pointer(await state(), "alice_gift"), undefined);
  await admitted("Alice claims the released @alice_gift", alice, await names.claim(await state(), alice.address, "alice_gift"));
  await until("@alice_gift is Alice's again", async () => (await name("alice_gift"))?.owner === alice.address);
  assert.equal((await name("alice_gift")).pointer, undefined);
  console.log("a released name loses its pointer, and is claimed again pointing nowhere");

  // The library, as another app uses it: reads, and writes through a wallet.
  const moniker = createMoniker({ sdk, nodes: [node], chain: CHAIN, freshFor: 0, fee: 1n });
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
  await admitted("Alice funds Carol", alice, { actions: [], payments: [{ to: carol.address, amount: 100n }] });
  await until("Carol is funded", async () => (await balance(carol)) === 100n);
  await moniker.claim("@carol", { point: true }, { wallet: walletOf(carol) });
  await until("the library's claim", async () => (await moniker.pointer("carol")) === carol.address);
  await moniker.showName("@carol", { wallet: walletOf(carol) });
  await until("the library's show", async () => (await moniker.handleOf(carol.address)) === "carol");
  assert.deepEqual(await moniker.handlesOf([carol.address, bob.address, miner.address]), ["carol", "alice", undefined]);
  assert.equal(await moniker.label(carol.address, { name: "Carol" }), "Carol @carol");
  await moniker.sell("@carol", 7n, { wallet: walletOf(carol) });
  await until("the library's listing", async () => (await moniker.forSale()).some((n) => n.handle === "carol" && n.price === 7n && n.owner === carol.address));
  await moniker.buy("carol", {}, { wallet: walletOf(bob) });
  await until("the library's buy", async () => (await moniker.name("carol"))?.owner === bob.address);
  assert.equal((await moniker.name("carol")).pointer, undefined);
  assert.equal(await moniker.handleOf(carol.address), undefined);
  assert.deepEqual((await moniker.names(bob.address)).map((n) => n.handle), ["alice", "carol"]);
  await assert.rejects(moniker.point("carol", true, { wallet: walletOf(carol) }), /isn't yours/);
  await moniker.point("carol", carol.address, { wallet: walletOf(bob) });
  await until("the library's pointer", async () => (await moniker.handleOf(carol.address)) === "carol");
  await moniker.stopShowing({ wallet: walletOf(carol) });
  await until("the library's stop", async () => (await moniker.handleOf(carol.address)) === undefined);
  await moniker.release("carol", { wallet: walletOf(bob) });
  await until("the library's release", async () => (await moniker.name("carol")) === undefined);
  assert.equal(await moniker.pointer("carol"), undefined);
  await assert.rejects(moniker.claim("carol", {}, {}), /needs the Lattice Wallet/);
  console.log("the library claims, shows, sells, buys, points, stops showing and releases a name through a wallet");
} finally {
  try { lattice("mine", "stop"); } catch {}
  try { lattice("down"); } catch {}
}
