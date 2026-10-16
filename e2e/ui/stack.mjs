// A private Moniker stack for the UI tests: one Lattice host mining Nexus and
// a Moniker chain from a fast test spec, with public reads and submits, and a
// static server for the repository so the real app/ page runs against it,
// with moniker-sdk under /sdk/ for its demo page.
//
//   LATTICE=<lattice-node>/.build/debug/lattice
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js
//   MONIKER_SDK=<moniker-sdk>   (by default ../moniker-sdk beside this checkout)
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const CHAIN = ["Nexus", "moniker"];
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const repo = here("../../");
const sdkRepo = process.env.MONIKER_SDK ? `${normalize(process.env.MONIKER_SDK)}/` : here("../../../moniker-sdk/");
const ports = { listen: 27101, rpc: 27180, publicRead: 27181, web: 27190 };

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2" };

/** Serves the repository root, and moniker-sdk under /sdk/, as a static host does. */
function serve(port) {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    const base = path.startsWith("/sdk/") ? sdkRepo : repo;
    let file = join(base, base === sdkRepo ? path.slice("/sdk".length) : path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(base) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function until(label, condition, seconds = 300) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await condition().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function start() {
  const sdk = await import(process.env.LATTICE_SDK);
  const root = mkdtempSync(`${tmpdir()}/moniker-ui-`);
  const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
  const configure = (edit) => {
    const file = `${root}/lattice.json`;
    const topology = JSON.parse(readFileSync(file, "utf8"));
    edit(topology);
    writeFileSync(file, JSON.stringify(topology, null, 2));
  };
  const minerKey = sdk.generatePrivateKey();
  const miner = sdk.accountFromPrivateKey(minerKey);
  lattice("init");
  configure((t) => {
    Object.assign(t, { listen: ports.listen, rpc: ports.rpc, publicRead: ports.publicRead, webSocket: 0, publicSubmit: true });
    // As the testnet hosts: a fee of 1 per transaction.
    t.minRelayFee = 1;
    // Reads are many (one per trie node): no rate ceilings in the way.
    t.publicReadExpensiveRate = 10000;
    t.publicReadRate = 10000;
    t.publicReadMaxRate = 100000;
    t.peers = [];
    t.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("child", "create", CHAIN.join("/"), "--spec", here("./spec.json"), "--policy-module", here("../../chain/moniker_policy.wasm"));
  configure((t) => {
    t.mine.recipients = { Nexus: miner.address, [CHAIN.join("/")]: miner.address };
  });
  lattice("up");
  lattice("mine", "start");
  const node = `http://127.0.0.1:${ports.publicRead}`;
  await until("Moniker funds the miner", async () => {
    const r = await fetch(`${node}/api/state/account/${miner.address}?chainPath=${CHAIN.join("/")}`);
    return r.ok && BigInt((await r.json()).balance ?? 0) > 5000n;
  });
  const web = await serve(ports.web);
  const info = {
    root, node, rpc: `http://127.0.0.1:${ports.rpc}`, app: `http://127.0.0.1:${ports.web}/app/`,
    chain: CHAIN.join("/"), minerKey: Buffer.from(minerKey).toString("hex"), miner: miner.address,
  };
  return {
    info,
    stop: async () => {
      web.close();
      try { lattice("mine", "stop"); } catch {}
      try { lattice("down"); } catch {}
    },
  };
}
