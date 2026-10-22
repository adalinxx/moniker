// Moniker, the names chain, against a real node: a private host mines Nexus
// and a Moniker chain launched from chain/spec.json with the built policy,
// whose genesis pays the premine to Alice. Alice claims @alice and points it
// at a profile on two app chains. Every way of taking a name, or writing its
// pointers or index keys, without the right is refused. A sale moves only
// the name: Bob buys @alice at its new price and repoints it on one chain,
// and the other pointer stays. A name offered to an account is taken by it
// alone. Releasing a name deletes its pointers. Last, moniker-sdk does the
// same through a wallet.
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
// App chains a name points on. Moniker can't see them: a pointer is a claim the app checks.
const RAVE = "Nexus/testnet/rave-186079";
const STOA = "Nexus/testnet/stoa-41d5ab";
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
/** A profile id on an app chain, as an app would make one. */
const profileId = (letter) => letter.repeat(16);
const [alicesRave, alicesStoa, bobsRave] = [profileId("a"), profileId("b"), profileId("c")];

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
    console.log(`Moniker launched under policy ${want}; Alice holds ${await balance(alice)}`);
  }
  await admitted("Alice funds Bob", alice, { actions: [], payments: [{ to: bob.address, amount: 2000n }] });
  await until("Bob is funded", async () => (await balance(bob)) === 2000n);

  // A name pointed on two app chains, and an account field.
  await admitted("Alice claims @alice, pointed at her Rave profile", alice, await names.claim(await state(), alice.address, "alice", { point: { chain: RAVE, profile: alicesRave } }));
  await until("@alice is mined", async () => (await name("alice"))?.owner === alice.address);
  await admitted("Alice points @alice at her Stoa profile", alice, await names.pointName(await state(), alice.address, "alice", STOA, alicesStoa));
  await until("@alice points on Stoa", async () => (await names.pointer(await state(), "alice", STOA)) === alicesStoa);
  await admitted("Alice keeps a field", alice, await names.setField(await state(), alice.address, "key.x25519", "alice-public-key"));
  await until("the field", async () => (await names.getField(await state(), alice.address, "key.x25519")) === "alice-public-key");
  {
    const s = await state();
    const held = await names.resolve(s, "alice");
    assert.deepEqual([held.owner, held.points], [alice.address, { [RAVE]: alicesRave, [STOA]: alicesStoa }]);
    assert.equal(await names.pointer(s, "alice", RAVE), alicesRave);
    assert.deepEqual((await names.namesOf(s, alice.address)).map((n) => n.handle), ["alice"]);
  }
  console.log("@alice is Alice's and points at a profile on Rave and one on Stoa");

  // Ways of taking a name, or writing its pointers or index keys, without the right.
  {
    const s = await state();
    const held = await names.resolve(s, "alice");
    const raveKey = names.pointsKey("alice", RAVE);
    const proof = { key: names.nameKey("alice"), oldValue: held.value, newValue: held.value };
    await refused("Bob points @alice at his Rave profile", bob, { actions: [proof, { key: raveKey, oldValue: alicesRave, newValue: bobsRave }] });
    await refused("Bob writes @alice's pointer alone", bob, { actions: [{ key: raveKey, oldValue: alicesRave, newValue: bobsRave }] });
    await refused("Bob points @alice on a new chain", bob, { actions: [proof, { key: names.pointsKey("alice", "Nexus/testnet/other"), newValue: bobsRave }] });
    await refused("Alice points @alice at something not a profile id", alice, { actions: [proof, { key: raveKey, oldValue: alicesRave, newValue: "not a profile" }] });
    await refused("Bob releases @alice", bob, { actions: [{ key: names.nameKey("alice"), oldValue: held.value }, { key: names.namesKey(alice.address, "alice"), oldValue: "1" }, { key: raveKey, oldValue: alicesRave }] });
    await refused("Bob takes @alice, unpriced, paying her", bob, {
      actions: [{ key: names.nameKey("alice"), oldValue: held.value, newValue: bob.address }, { key: names.namesKey(alice.address, "alice"), oldValue: "1" }, { key: names.namesKey(bob.address, "alice"), newValue: "1" }],
      payments: [{ to: alice.address, amount: 1000n }],
    });
    await refused("Bob claims a name without its index key", bob, { actions: [{ key: names.nameKey("bob"), newValue: bob.address }] });
    await refused("Bob claims a name onto Alice's account", bob, { actions: [{ key: names.nameKey("bob"), newValue: alice.address }, { key: names.namesKey(alice.address, "bob"), newValue: "1" }] });
    await refused("Bob lists @alice among his names", bob, { actions: [{ key: names.namesKey(bob.address, "alice"), newValue: "1" }] });
    await refused("Bob writes Alice's field", bob, { actions: [{ key: names.fieldKey(alice.address, "key.x25519"), oldValue: "alice-public-key", newValue: "bob" }] });
    await refused("Alice writes a profile on Moniker", alice, { actions: [{ key: `profile/${alicesRave}`, newValue: alice.address }] });
  }

  // A sale moves only the name: the buyer repoints one chain, the other stays.
  await admitted("Alice lists @alice at 500", alice, await names.list(await state(), alice.address, "alice", 500n));
  await until("the listing is mined", async () => (await name("alice"))?.price === 500n);
  const seenAt500 = await names.buy(await state(), bob.address, "alice", { point: { chain: RAVE, profile: bobsRave } });
  await admitted("Alice reprices @alice to 600", alice, await names.list(await state(), alice.address, "alice", 600n));
  await until("the new price is mined", async () => (await name("alice"))?.price === 600n);
  await refused("Bob buys @alice at the price he saw, 500", bob, seenAt500);
  {
    const [aliceBefore, bobBefore] = [await balance(alice), await balance(bob)];
    await admitted("Bob buys @alice at 600, pointing it at his Rave profile", bob, await names.buy(await state(), bob.address, "alice", { point: { chain: RAVE, profile: bobsRave } }));
    await until("Bob's buy is mined", async () => (await name("alice"))?.owner === bob.address);
    assert.equal(await balance(alice), aliceBefore + 600n);
    assert.equal(await balance(bob), bobBefore - 601n);
    const s = await state();
    assert.deepEqual((await names.resolve(s, "alice")).points, { [RAVE]: bobsRave, [STOA]: alicesStoa });
    assert.deepEqual(await names.namesOf(s, alice.address), []);
    assert.deepEqual((await names.namesOf(s, bob.address)).map((n) => n.handle), ["alice"]);
  }
  console.log("Bob bought @alice at 600 and repointed it on Rave; it still points at Alice's Stoa profile until he changes it");
  await refused("Alice, its seller, stops @alice pointing on Stoa", alice, {
    actions: [{ key: names.nameKey("alice"), oldValue: bob.address, newValue: bob.address }, { key: names.pointsKey("alice", STOA), oldValue: alicesStoa }],
  });
  await admitted("Bob stops @alice pointing on Stoa", bob, await names.pointName(await state(), bob.address, "alice", STOA, null));
  await until("@alice points nowhere on Stoa", async () => (await names.pointer(await state(), "alice", STOA)) === undefined);

  // A name offered to an account: only that account takes it, and its pointers stay.
  await admitted("Alice claims @alice_gift, pointed on Rave", alice, await names.claim(await state(), alice.address, "alice_gift", { point: { chain: RAVE, profile: alicesRave } }));
  await until("@alice_gift is mined", async () => (await name("alice_gift"))?.owner === alice.address);
  await admitted("Alice offers @alice_gift to Bob", alice, await names.offerName(await state(), alice.address, "alice_gift", bob.address));
  await until("the offer is mined", async () => (await name("alice_gift"))?.offer === bob.address);
  // The miner, paid on this chain, so only the policy stands in the way.
  await refused("the miner takes the name offered to Bob", miner, {
    actions: [{ key: names.nameKey("alice_gift"), oldValue: `${alice.address}>${bob.address}`, newValue: miner.address }, { key: names.namesKey(alice.address, "alice_gift"), oldValue: "1" }, { key: names.namesKey(miner.address, "alice_gift"), newValue: "1" }],
  });
  await admitted("Bob takes @alice_gift", bob, await names.buy(await state(), bob.address, "alice_gift"));
  await until("Bob holds @alice_gift", async () => (await name("alice_gift"))?.owner === bob.address);
  assert.deepEqual((await name("alice_gift")).points, { [RAVE]: alicesRave });
  console.log("a name offered to Bob: the miner can't take it, Bob does, and it points where it did");

  // Releasing a name deletes its pointers; anyone may claim it next.
  await refused("Bob releases @alice_gift and repoints it", bob, {
    actions: [{ key: names.nameKey("alice_gift"), oldValue: bob.address }, { key: names.namesKey(bob.address, "alice_gift"), oldValue: "1" }, { key: names.pointsKey("alice_gift", RAVE), oldValue: alicesRave, newValue: bobsRave }],
  });
  await admitted("Bob releases @alice_gift", bob, await names.release(await state(), bob.address, "alice_gift"));
  await until("@alice_gift is free", async () => (await name("alice_gift")) === undefined);
  {
    const s = await state();
    const left = [];
    for await (const [key] of s.list("points/alice_gift/")) left.push(key);
    assert.deepEqual(left, []);
    assert.deepEqual((await names.namesOf(s, bob.address)).map((n) => n.handle), ["alice"]);
  }
  await admitted("Alice claims the released @alice_gift", alice, await names.claim(await state(), alice.address, "alice_gift"));
  await until("@alice_gift is Alice's again", async () => (await name("alice_gift"))?.owner === alice.address);
  assert.deepEqual((await name("alice_gift")).points, {});
  console.log("a released name loses its pointers, and is claimed again pointing nowhere");

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
  await moniker.claim("@carol", { point: { chain: RAVE, profile: profileId("d") } }, { wallet: walletOf(carol) });
  await until("the library's claim", async () => (await moniker.pointer("carol", RAVE)) === profileId("d"));
  await moniker.point("carol", STOA, profileId("e"), { wallet: walletOf(carol) });
  await until("the library's pointer", async () => (await moniker.pointer("@carol", STOA)) === profileId("e"));
  await moniker.sell("@carol", 7n, { wallet: walletOf(carol) });
  await until("the library's listing", async () => (await moniker.forSale()).some((n) => n.handle === "carol" && n.price === 7n && n.owner === carol.address));
  await moniker.buy("carol", { point: { chain: STOA, profile: profileId("f") } }, { wallet: walletOf(bob) });
  await until("the library's buy", async () => (await moniker.name("carol"))?.owner === bob.address);
  assert.deepEqual((await moniker.name("carol")).points, { [RAVE]: profileId("d"), [STOA]: profileId("f") });
  assert.deepEqual((await moniker.names(bob.address)).map((n) => n.handle), ["alice", "carol"]);
  await assert.rejects(moniker.point("carol", RAVE, profileId("g"), { wallet: walletOf(carol) }), /isn't yours/);
  await moniker.release("carol", { wallet: walletOf(bob) });
  await until("the library's release", async () => (await moniker.name("carol")) === undefined);
  assert.equal(await moniker.pointer("carol", RAVE), undefined);
  await assert.rejects(moniker.claim("carol", {}, {}), /needs the Lattice Wallet/);
  console.log("the library claims, points, sells, buys with a new pointer and releases a name through a wallet");
} finally {
  try { lattice("mine", "stop"); } catch {}
  try { lattice("down"); } catch {}
}
