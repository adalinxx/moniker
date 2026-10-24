// The transactions Moniker's genesis carries: each name the project holds
// from the first block, claimed by the project's account with its names/ key
// and pointed at that account, one claim per transaction as the policy
// requires, at nonces 0, 1, 2, ... Each is checked against
// chain/moniker_policy.wasm before anything is written.
//
//   LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js \
//     node chain/genesis.mjs <key.json> <names.txt> [chain path] > genesis.json
//
// key.json is a `lattice key generate` file; names.txt has one handle per
// line, `#` starting a comment; the chain path defaults to Nexus/moniker. The
// output is what `lattice child create --genesis-transactions` takes.
// LATTICE_SDK (the SDK bundle, which carries core) serves in place of
// LATTICE_SDK_CORE.
import { readFileSync } from "node:fs";
import { context, validate } from "../policy/test/host.mjs";

const [keyFile, namesFile, chain = "Nexus/moniker"] = process.argv.slice(2);
if (!keyFile || !namesFile) {
  console.error("usage: node chain/genesis.mjs <key.json> <names.txt> [chain path]");
  process.exit(2);
}
const core = await import(process.env.LATTICE_SDK_CORE ?? process.env.LATTICE_SDK);
const policy = new WebAssembly.Module(readFileSync(new URL("./moniker_policy.wasm", import.meta.url)));
const chainPath = chain.split("/");

const key = JSON.parse(readFileSync(keyFile, "utf8"));
const privateKey = Uint8Array.from(Buffer.from(key.privateKey, "hex"));
const owner = core.addressFromPublicKey(core.publicKeyFromPrivate(privateKey));
if (owner !== key.address) throw new Error(`${keyFile}: its key is for ${owner}, not the ${key.address} it names`);

const handles = readFileSync(namesFile, "utf8")
  .split("\n")
  .map((line) => line.replace(/#.*/, "").trim())
  .filter(Boolean);
const seen = new Set();
for (const handle of handles) {
  if (!/^[a-z0-9_]+$/.test(handle)) throw new Error(`${handle}: a handle is lowercase letters, digits and _`);
  if (seen.has(handle)) throw new Error(`${handle} is listed twice`);
  seen.add(handle);
}

const transactions = handles.map((handle, index) => {
  const body = {
    accountActions: [],
    actions: [
      { key: `name/${handle}`, newValue: owner },
      { key: `names/${owner}/${handle}`, newValue: "1" },
      { key: `points/${handle}`, newValue: owner },
    ],
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [owner],
    nonce: BigInt(index),
    chainPath,
  };
  if (!validate(context(core.encodeTransactionBody(body).bytes, { path: chainPath, height: 0n }), policy)) {
    throw new Error(`the policy refuses the claim of @${handle}`);
  }
  const { publicKey, signature } = core.signTransactionBody(body, privateKey);
  return core.transactionPayload({ [publicKey]: signature }, body);
});

process.stdout.write(`${JSON.stringify(transactions, null, 2)}\n`);
console.error(`${transactions.length} claims for ${owner} on ${chain}`);
