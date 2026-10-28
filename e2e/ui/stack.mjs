// A private Moniker stack for the UI tests: one Lattice host mining Nexus and
// a Moniker chain from a fast test spec, with public reads and submits, and a
// static server for the repository so the real app/ page runs against it.
//
//   LATTICE=<lattice-node>/.build/debug/lattice
//   LATTICE_SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor   (default: beside lattice)
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const CHAIN = ["Nexus", "moniker"];
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const repo = here("../../");
const ports = { listen: 27101, rpc: 27180, publicRead: 27181, web: 27190, sponsor: 27191 };

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

/** Serves the repository root, as a static host does. */
function serve(port) {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(repo, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(repo) || !existsSync(file)) {
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
    // As the testnet hosts: any fee, 0 included.
    t.minRelayFee = 0;
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

  // A fee sponsor (lattice-sponsor), started on first use: it pays a fee of 1
  // for small shares of work, though these hosts would take 0, and up to 100
  // of a price. Its account holds nothing until `fund` pays it.
  let sponsor;
  async function startSponsor(fund) {
    if (sponsor) return sponsor.info;
    const key = `${root}/sponsor-key.json`;
    execFileSync(process.env.LATTICE, ["key", "generate", "--out", key]);
    const { address } = JSON.parse(readFileSync(key, "utf8"));
    await fund(address);
    const log = openSync(`${root}/sponsor.log`, "a");
    const child = spawn(process.env.LATTICE_SPONSOR || join(dirname(process.env.LATTICE), "lattice-sponsor"), [
      "--node", `http://127.0.0.1:${ports.rpc}`, "--cookie-file", `${root}/chains/Nexus/.cookie`, "--key", key,
      "--share-work", "2^12", "--fee", "1", "--most-pay", "100", "--port", String(ports.sponsor),
    ], { stdio: ["ignore", log, log] });
    sponsor = { child, info: { url: `http://127.0.0.1:${ports.sponsor}`, address } };
    await until("the sponsor prices Moniker", async () => {
      const r = await fetch(`${sponsor.info.url}/work`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chain: CHAIN.join("/") }) });
      return r.ok;
    }, 120);
    return sponsor.info;
  }

  const info = {
    root, node, app: `http://127.0.0.1:${ports.web}/app/`,
    chain: CHAIN.join("/"), minerKey: Buffer.from(minerKey).toString("hex"), miner: miner.address,
  };
  return {
    info,
    sponsor: startSponsor,
    stop: async () => {
      sponsor?.child.kill();
      web.close();
      try { lattice("mine", "stop"); } catch {}
      try { lattice("down"); } catch {}
    },
  };
}
