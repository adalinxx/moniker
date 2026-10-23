// The transactions Moniker's genesis carries: a claim of each name the
// project holds from the first block, one claim per transaction as the policy
// requires, signed by the project's key, at nonces 0, 1, 2, ... Each is
// checked against chain/moniker_policy.wasm before anything is written.
//
//   LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js \
//     node chain/genesis.mjs <key.json> <names.txt> > genesis.json
//
// key.json is a `lattice key generate` file; names.txt has one handle per
// line, `#` starting a comment. The output is what
// `lattice child create --genesis-transactions` takes.
import { readFileSync } from "node:fs";
import { context, validate } from "../policy/test/host.mjs";
import { MONIKER_CHAIN, isHandle } from "../sdk/src/records/profile.mjs";

const [keyFile, namesFile] = process.argv.slice(2);
if (!keyFile || !namesFile) {
  console.error("usage: node chain/genesis.mjs <key.json> <names.txt>");
  process.exit(2);
}
const core = await import(process.env.LATTICE_SDK_CORE);
const policy = new WebAssembly.Module(readFileSync(new URL("./moniker_policy.wasm", import.meta.url)));

const key = JSON.parse(readFileSync(keyFile, "utf8"));
const privateKey = Uint8Array.from(Buffer.from(key.privateKey, "hex"));
const holder = core.addressFromPublicKey(core.publicKeyFromPrivate(privateKey));
if (holder !== key.address) throw new Error(`${keyFile}: its key is for ${holder}, not the ${key.address} it names`);

const names = readFileSync(namesFile, "utf8")
  .split("\n")
  .map((line) => line.replace(/#.*/, "").trim())
  .filter(Boolean);
const seen = new Set();
for (const name of names) {
  if (!isHandle(name)) throw new Error(`${name}: a handle is lowercase letters, digits and _`);
  if (seen.has(name)) throw new Error(`${name} is listed twice`);
  seen.add(name);
}

const transactions = names.map((name, index) => {
  const body = {
    accountActions: [],
    actions: [{ key: `name/${name}`, newValue: holder }],
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [holder],
    nonce: BigInt(index),
    chainPath: MONIKER_CHAIN,
  };
  const bytes = core.encodeTransactionBody(body).bytes;
  if (!validate(context(bytes, { path: MONIKER_CHAIN, height: 0n }), policy)) {
    throw new Error(`the policy refuses the claim of @${name}`);
  }
  const { publicKey, signature } = core.signTransactionBody(body, privateKey);
  return core.transactionPayload({ [publicKey]: signature }, body);
});

process.stdout.write(`${JSON.stringify(transactions, null, 2)}\n`);
console.error(`${transactions.length} claims for ${holder}`);
