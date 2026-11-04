// Moniker's profile cards against a real node, with no coins: a private host
// mines Nexus and a Moniker chain from e2e/ui/spec.json with the built
// policy, a fee of at least 1 for every write, and a sponsor (lattice-sponsor)
// paid the chain's block rewards. The sponsor pays fees for shares of work
// this script grinds, as Selfhold's window does in a page, and sells storage
// for work (--sell-storage). Dana, who holds nothing, keeps a photo for good
// with her work, puts it on her card with moniker-sdk, the fee paid with work
// too, and fills in her card. A reader with nothing cached reads the card
// back, and the photo's bytes from the node, checked by CID. Bob can't write
// Dana's card, fee paid or not. Last: Dana still holds nothing.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/profile.mjs
//
// LATTICE_SPONSOR names lattice-sponsor if it isn't beside LATTICE; it must
// sell storage (0xLattice/lattice-sponsor).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { createMoniker, profileKey } from "../sdk/src/index.mjs";
import { transaction } from "../sdk/src/records/wallet.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const CHAIN = ["Nexus", "moniker"];
const [listen, rpc, publicRead, sponsorPort] = [25031, 29200, 29201, 29202];
const node = `http://127.0.0.1:${publicRead}`;
const sponsorURL = `http://127.0.0.1:${sponsorPort}`;

const root = mkdtempSync(`${tmpdir()}/moniker-profile-e2e-`);
const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
function configure(change) {
  const file = `${root}/lattice.json`;
  const topology = JSON.parse(readFileSync(file, "utf8"));
  change(topology);
  writeFileSync(file, JSON.stringify(topology, null, 2));
}

const account = () => sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const [dana, bob] = [account(), account()];

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

async function accountState(address) {
  const response = await fetch(`${node}/api/state/account/${address}?chainPath=${CHAIN.join("/")}`, { cache: "no-store" });
  return response.ok ? await response.json() : {};
}
const balance = async (address) => BigInt((await accountState(address)).balance ?? 0);
const used = new Map(); // account → the nonce after the last one sent
/** The next nonce for `who`, once the last write sent has landed, as a wallet waits. */
async function nonce(who) {
  const want = used.get(who.address) ?? 0n;
  const next = await until(`${who.address.slice(-6)}'s last write to land`, async () => {
    const n = BigInt((await accountState(who.address)).nonce ?? 0);
    return n >= want ? n + 1n : false;
  });
  used.set(who.address, next);
  return next - 1n;
}
/** Gives back a nonce a refused write didn't use. */
const unuse = (who, n) => used.set(who.address, n);

async function submit(signatures, body) {
  const response = await fetch(new URL("/transactions", node), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload(signatures, body)),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

/** A `width` × `height` PNG of a soft gradient: a real picture, made here. */
function png(width, height) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const t = x / width, u = y / height;
      rows.set([Math.round(20 + 60 * u), Math.round(120 + 100 * t), Math.round(110 + 90 * (1 - t) * (1 - u))], row + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
}

// ---------------------------------------------------------------- work, as a device grinds it

/** The nonces in `work`'s range whose SHA-256 over its prefix and the nonce (8 bytes, big-endian) is at or under its share target. */
function* shares(work) {
  const prefix = Buffer.from(work.prefixHex, "hex");
  const target = BigInt(`0x${work.shareTarget}`);
  const input = Buffer.alloc(prefix.length + 8);
  prefix.copy(input);
  for (let n = BigInt(work.startNonce), end = n + BigInt(work.count); n < end; n++) {
    input.writeBigUInt64BE(n, prefix.length);
    if (BigInt(`0x${createHash("sha256").update(input).digest("hex")}`) <= target) yield n;
  }
}

/** Grinds a sponsor's work on this machine, as the page does on a device: `hash(work, found, hashed)` for the SDK. */
function hash(work, found, hashed) {
  let stopped = false;
  const done = (async () => {
    let count = 0;
    for (const nonce of shares(work)) {
      if (stopped) return;
      found(nonce);
      // Let the shares go out while the hashing runs on.
      if (++count % 4 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    hashed(Number(work.count));
  })();
  return { done, stop: () => (stopped = true) };
}

// ---------------------------------------------------------------- the fee sponsor, as a wallet uses it

async function ask(path, body) {
  const response = await fetch(`${sponsorURL}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`${path}: ${response.status} ${text}`), { status: response.status });
  return JSON.parse(text);
}

let sponsor;
const clients = new Map(); // account → the sponsor's token for it
/** `draft` (fee 0, one signer) with the sponsor's fee debit and signature, earned with work first when the credit is short. */
async function sponsored(who, draft) {
  const toWire = (body) => sdk.transactionPayload({}, body).transaction.body;
  const fromWire = (body) => ({ ...body, accountActions: body.accountActions.map((a) => ({ owner: a.owner, delta: BigInt(a.delta) })), nonce: BigInt(body.nonce) });
  const sign = async () => {
    const answer = await ask("sponsor", { client: clients.get(who.address), transaction: { signatures: {}, body: toWire(draft) } });
    const body = fromWire(answer.transaction.body);
    // Only the sponsor's debit and signature added.
    assert.deepEqual(body.signers, [who.address, sponsor.address]);
    assert.deepEqual(body.actions, draft.actions);
    assert.ok(body.accountActions.every((a) => a.owner === sponsor.address && a.delta < 0n));
    return { body, signatures: answer.transaction.signatures };
  };
  for (let round = 0; ; round++) {
    if (clients.has(who.address)) {
      try {
        return await sign();
      } catch (error) {
        if (error.status === 400 && /client token/.test(error.message)) clients.delete(who.address);
        else if (error.status !== 402) throw error;
      }
    }
    if (round > 20) throw new Error("the sponsor took none of this work");
    let work;
    try {
      work = await ask("work", { ...(clients.has(who.address) && { client: clients.get(who.address) }), chain: draft.chainPath.join("/") });
    } catch (error) {
      if (error.status === 400 && /client token/.test(error.message)) {
        clients.delete(who.address);
        continue;
      }
      if (error.status !== 503) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    clients.set(who.address, work.client);
    let found = 0;
    for (const n of shares(work)) {
      try {
        const { credit } = await ask("shares", { assignment: work.assignment, nonce: String(n) });
        if (BigInt(credit) >= BigInt(work.fee) || ++found >= Number(work.sharesForFee)) break;
      } catch (error) {
        // Stale work: the chain moved on. Ask again.
        if (error.status === 400 || error.status === 410) break;
        throw error;
      }
    }
  }
}

/** `actions` by `who`, its fee paid by the sponsor; the node's answer. */
async function send(who, { actions }) {
  const n = await nonce(who);
  const draft = transaction({ owner: who.address, actions, fee: 0n, nonce: n, chainPath: CHAIN });
  let result;
  try {
    const { body, signatures } = await sponsored(who, draft);
    const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
    result = await submit({ ...signatures, [publicKey]: signature }, body);
  } catch (error) {
    unuse(who, n);
    throw error;
  }
  if (!result.ok) unuse(who, n);
  return result;
}

/** A wallet holding `who`'s key, as Selfhold's window answers the library: it has the fee sponsored, signs and sends. */
const walletOf = (who) => ({
  address: async () => who.address,
  writeRecords: async (request) => {
    assert.equal(request.fee, undefined, "the app leaves the fee to the wallet");
    const result = await send(who, request);
    if (!result.ok) throw new Error(`${result.status} ${result.text}`);
    return { transactionCID: "sent" };
  },
});

let sponsorChild;
try {
  lattice("init");
  configure((topology) => {
    Object.assign(topology, { listen, rpc, publicRead, webSocket: 0, publicSubmit: true });
    // As the shared testnet hosts: a fee of at least 1, so no write is free.
    topology.minRelayFee = 1;
    topology.publicReadExpensiveRate = 10000;
    topology.publicReadRate = 10000;
    topology.publicReadMaxRate = 100000;
    topology.peers = [];
    topology.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("child", "create", CHAIN.join("/"), "--spec", here("./ui/spec.json"), "--policy-module", here("../chain/moniker_policy.wasm"));

  // The sponsor is paid Moniker's block rewards, and so holds coins there to pay fees with.
  const keyFile = `${root}/sponsor-key.json`;
  execFileSync(process.env.LATTICE, ["key", "generate", "--out", keyFile]);
  sponsor = JSON.parse(readFileSync(keyFile, "utf8"));
  configure((topology) => {
    topology.mine.recipients = { Nexus: account().address, [CHAIN.join("/")]: sponsor.address };
  });
  lattice("up");
  lattice("mine", "start");
  await until("the sponsor's first coins on Moniker", async () => (await balance(sponsor.address)) > 10n);
  const log = openSync(`${root}/sponsor.log`, "a");
  sponsorChild = spawn(process.env.LATTICE_SPONSOR || join(dirname(process.env.LATTICE), "lattice-sponsor"), [
    "--node", `http://127.0.0.1:${rpc}`, "--cookie-file", `${root}/chains/Nexus/.cookie`, "--key", keyFile,
    "--share-work", "2^12", "--fee", "1", "--port", String(sponsorPort),
    "--sell-storage", "--storage-rate", `${CHAIN.join("/")}=1000000`, "--storage-file", `${root}/sponsor-storage.json`,
  ], { stdio: ["ignore", log, log] });
  await until("the sponsor prices Moniker", async () => Boolean(await ask("work", { chain: CHAIN.join("/") })), 120);
  const terms = await (await fetch(`${sponsorURL}/terms`)).json();
  assert.ok(Number(terms.storageRates?.[CHAIN.join("/")]) > 0, `the sponsor keeps no files for Moniker: ${JSON.stringify(terms)}`);
  console.log(`Moniker launched; the sponsor (${sponsor.address.slice(-6)}) pays fees and keeps files for work`);

  // ------------------------------------------------------------ no write is free
  {
    const body = transaction({ owner: dana.address, actions: [{ key: profileKey(dana.address), newValue: "{}" }], fee: 0n, nonce: 0n, chainPath: CHAIN });
    const { publicKey, signature } = sdk.signTransactionBody(body, dana.privateKey);
    const free = await submit({ [publicKey]: signature }, body);
    assert.ok(!free.ok, "a zero-fee write was admitted: this run proves nothing about sponsors");
    console.log(`  refused: Dana's card with no fee, unsponsored (${free.status})`);
  }

  // ------------------------------------------------------------ a photo, kept for good with work, on Dana's card
  const moniker = createMoniker({ sdk, nodes: [node], chain: CHAIN, freshFor: 0, sponsor: sponsorURL, hash });
  const picture = png(256, 256);
  const stages = new Set();
  await moniker.setPhoto({ type: "image/png", bytes: picture }, { wallet: walletOf(dana), progress: ({ stage }) => stages.add(stage) });
  assert.deepEqual([...stages].filter((s) => ["prepare", "upload", "pin", "card"].includes(s)), ["prepare", "upload", "pin", "card"]);
  const avatar = await until("Dana's photo is on her card", async () => (await moniker.profile(dana.address))?.avatar);
  assert.ok((await (await fetch(`${sponsorURL}/store/${avatar}`)).json()).stored, "the sponsor says it hasn't kept it");
  console.log(`  kept: a ${picture.length}-byte photo, paid with work (${[...stages].join(", ")}), and on Dana's card`);

  const card = { name: "Dana Okafor", description: "Birds, bikes and bread. No coins.", url: "https://dana.example/", links: [{ label: "Blog", url: "https://blog.dana.example/" }] };
  await moniker.setProfile({ ...card, name: "@Dana Okafor" }, { wallet: walletOf(dana) });
  await until("Dana's card is filled in", async () => (await moniker.profile(dana.address))?.name === card.name);
  console.log("  admitted: Dana fills in her card, the fee paid with work");

  // ------------------------------------------------------------ a reader with nothing cached
  const reader = createMoniker({ sdk, nodes: [node], chain: CHAIN, freshFor: 0 });
  assert.deepEqual(await reader.profile(dana.address), { ...card, avatar });
  assert.deepEqual(await reader.profiles([bob.address, dana.address]), [undefined, { ...card, avatar }]);
  const photo = await reader.photo(avatar);
  assert.equal(photo.type, "image/png");
  assert.deepEqual(photo.bytes, picture);
  console.log("a reader read Dana's card, and her photo from the node, the same bytes");

  // ------------------------------------------------------------ nobody writes another's card, fee paid or not
  const value = await (await reader.state({ fresh: true })).get(profileKey(dana.address));
  for (const [label, actions] of [
    ["Bob writes Dana's card", [{ key: profileKey(dana.address), oldValue: value, newValue: JSON.stringify({ name: "Not Dana" }) }]],
    ["Bob deletes Dana's card", [{ key: profileKey(dana.address), oldValue: value }]],
  ]) {
    let result;
    try {
      result = await send(bob, { actions });
    } catch (error) {
      // The sponsor's own checks may refuse it first; either way nothing lands.
      result = { ok: false, status: error.status, text: error.message };
    }
    assert.ok(!result.ok, `${label} was admitted`);
    console.log(`  refused: ${label} (${result.status} ${String(result.text).trim().slice(0, 120)})`);
  }

  // ------------------------------------------------------------ the photo taken off
  await moniker.clearPhoto({ wallet: walletOf(dana) });
  await until("Dana's photo is off her card", async () => (await moniker.profile(dana.address))?.avatar === undefined);
  assert.deepEqual(await reader.profile(dana.address), card);
  console.log("  admitted: Dana takes her photo off her card");

  assert.equal(await balance(dana.address), 0n, "Dana holds coins");
  assert.equal(await balance(bob.address), 0n, "Bob holds coins");
  console.log("Dana holds no coins: her work paid for the photo and every fee");
  console.log("e2e passed");
} finally {
  sponsorChild?.kill();
  try { lattice("mine", "stop"); } catch {}
  try { lattice("down"); } catch {}
}
