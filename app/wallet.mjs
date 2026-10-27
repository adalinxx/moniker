// The wallet in the page, for anyone without Selfhold: the account's key is
// derived from a passkey (WebAuthn's PRF extension), so the passkey's
// provider keeps it and syncs it to the person's other devices, and Moniker
// stores no key, only which passkey and the address it makes. Where the
// browser or provider can't derive a key, one is kept in this browser
// instead, for the person to copy somewhere safe.
//
// It takes the same requests as Selfhold's `writeRecords` and signs as
// Selfhold would, then sends to the chain's hosts. The fee is the hosts'
// relay floor, paid from the account; an account with too few coins for it
// pays a fee sponsor in proof of work, ground here, and the sponsor adds the
// fee and co-signs. Without enough coins and with no sponsor, the write is
// refused with a `NeedsCoins` error naming what is needed.
import * as sdk from "../sdk/vendor/lattice-sdk.js";
import { transaction } from "../sdk/src/records/wallet.mjs";

const STORE = "moniker.wallet"; // { kind: "passkey", credential, address } | { kind: "browser", key, address }
const SPONSOR_CLIENT = "moniker.sponsorClient";
// What the passkey derives the key from: the same passkey and salt, the same key, on every device.
const SALT = new TextEncoder().encode("Moniker account key, v1");
// The most work (expected hashes) the page does for one fee: a few minutes of a laptop's cores.
const MOST_WORK = 2n ** 31n;

/** A write the account can't pay for: it needs `needed` coins and holds `balance`. */
export class NeedsCoins extends Error {
  constructor({ address, needed, balance }) {
    super(`Your account needs ${needed} ${needed === 1n ? "coin" : "coins"} for this and holds ${balance}.`);
    Object.assign(this, { name: "NeedsCoins", address, needed, balance });
  }
}

const saved = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE) ?? "null");
    return stored && typeof stored.address === "string" ? stored : null;
  } catch {
    return null;
  }
};
const save = (record) => {
  try {
    if (record) localStorage.setItem(STORE, JSON.stringify(record));
    else localStorage.removeItem(STORE);
  } catch {}
};
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (text) => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromBase64url = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** The browser's WebAuthn refusal, as a person reads it. */
function passkeyError(error) {
  if (error?.name === "NotAllowedError") return new Error("The passkey was cancelled. Nothing was sent.");
  if (error?.name === "InvalidStateError") return new Error("That passkey is already on this device.");
  if (error?.name === "SecurityError") return new Error("Passkeys work only on the page's own domain, or on localhost.");
  return error;
}

/** Whether the browser says passkeys here can derive a key: true, false, or undefined when it doesn't say. */
async function prfSupported() {
  if (!window.PublicKeyCredential) return false;
  try {
    const capabilities = await PublicKeyCredential.getClientCapabilities?.();
    if (capabilities && "extension:prf" in capabilities) return capabilities["extension:prf"];
  } catch {}
  return undefined;
}

/** The key a passkey derives, asking for it (any of this site's passkeys unless `credential` names one). */
async function derive(credential) {
  let assertion;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        allowCredentials: credential ? [{ type: "public-key", id: fromBase64url(credential) }] : [],
        userVerification: "required",
        extensions: { prf: { eval: { first: SALT } } },
      },
    });
  } catch (error) {
    throw passkeyError(error);
  }
  const secret = assertion.getClientExtensionResults().prf?.results?.first;
  if (!secret) throw new Error("This passkey can't make a key here. Try another browser or device, or Selfhold.");
  return { key: new Uint8Array(secret), credential: base64url(assertion.rawId) };
}

/** The wallet in the page. `hosts()`: the hosts to send to; `sponsor()`: a fee sponsor's URL, or "" for none. */
export function embeddedWallet({ hosts, sponsor }) {
  let key = null; // the account's private key, held only in memory
  let next = new Map(); // address → the nonce after the last one sent from this page

  const record = saved();
  if (record?.kind === "browser") key = fromHex(record.key);

  /** Takes `secret` as the account's key, and remembers how to find it again: its passkey (`credential`), or with no passkey, the key itself. */
  function hold(secret, credential) {
    const { address } = sdk.accountFromPrivateKey(secret);
    key = secret;
    save(credential ? { kind: "passkey", credential, address } : { kind: "browser", key: hex(secret), address });
    return address;
  }

  /** A host that answers, with the chain's relay floor and the account's balance and nonce there. */
  async function reach(chainPath, address) {
    const chain = chainPath.join("/");
    let failure;
    for (const host of await hosts()) {
      try {
        const get = async (path) => {
          const response = await fetch(`${host}${path}${path.includes("?") ? "&" : "?"}chainPath=${encodeURIComponent(chain)}`);
          if (response.status === 404) return {};
          if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
          return response.json();
        };
        const [info, account] = await Promise.all([get("/api/chain/info"), get(`/api/state/account/${address}`)]);
        if (info.acceptsSubmit === false) throw new Error(`${host} takes no transactions`);
        return { host, fee: BigInt(info.minRelayFee ?? 0), balance: BigInt(account.balance ?? 0), nonce: BigInt(account.nonce ?? 0) };
      } catch (error) {
        failure = error;
      }
    }
    throw new Error(`No host takes transactions for ${chain}`, { cause: failure });
  }

  /** Signs `body` (adding to `signatures`) and sends it to `host`. */
  async function submit(host, body, signatures = {}) {
    const { publicKey, signature } = sdk.signTransactionBody(body, key);
    const response = await fetch(`${host}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sdk.transactionPayload({ ...signatures, [publicKey]: signature }, body)),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`The host refused the transaction: ${text || response.status}`);
    const owner = body.signers[0];
    next.set(owner, body.nonce + 1n);
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  return {
    /** The account, without asking for anything: the one this browser remembers, or null. */
    address: async () => saved()?.address ?? null,
    /** How the key is kept: "passkey", "browser", or null with no account. */
    kind: () => saved()?.kind ?? null,
    /** Whether the key must be asked of the passkey before a write. */
    locked: () => key === null,
    /** Unlocks the account this browser remembers, asking its passkey. Call it from a click. */
    async connect() {
      const record = saved();
      if (!record) throw new Error("There is no account in this browser yet.");
      if (key) return record.address;
      const found = await derive(record.credential);
      if (sdk.accountFromPrivateKey(found.key).address !== record.address) throw new Error("That passkey makes a different account. Your names are on the other one.");
      return hold(found.key, found.credential);
    },
    /**
     * Makes a new account: a passkey, and the key it derives; where passkeys
     * here can't derive one, a key kept in this browser. Call it from a click.
     */
    async create() {
      if ((await prfSupported()) === false) return { address: hold(sdk.generatePrivateKey()), kind: "browser" };
      let created;
      try {
        created = await navigator.credentials.create({
          publicKey: {
            rp: { name: "Moniker" },
            user: { id: random(16), name: `Moniker account, ${new Date().toISOString().slice(0, 10)}`, displayName: "Moniker account" },
            challenge: random(32),
            pubKeyCredParams: [{ type: "public-key", alg: -8 }, { type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
            extensions: { prf: { eval: { first: SALT } } },
          },
        });
      } catch (error) {
        throw passkeyError(error);
      }
      const prf = created.getClientExtensionResults().prf;
      const credential = base64url(created.rawId);
      // The browser didn't say beforehand; the passkey made is left unused.
      if (prf?.enabled === false) return { address: hold(sdk.generatePrivateKey()), kind: "browser" };
      // Some providers derive at creation; the rest, on the first use.
      const first = prf?.results?.first;
      const secret = first ? new Uint8Array(first) : (await derive(credential)).key;
      return { address: hold(secret, credential), kind: "passkey" };
    },
    /** Signs in with a passkey made here before, on this device or synced to it. Call it from a click. */
    async signIn() {
      const found = await derive();
      return hold(found.key, found.credential);
    },
    /** The key, as hex, for an account kept in this browser: for the person to keep. */
    exportKey: () => (saved()?.kind === "browser" && key ? hex(key) : null),
    /** Forgets the account here. A passkey's account comes back with `signIn`; a browser key's doesn't. */
    forget() {
      key = null;
      next = new Map();
      save(null);
    },
    /**
     * Signs and sends a Selfhold write request (`{ chainPath, actions,
     * payments?, fee? }`) as the account, paying the hosts' relay floor, or a
     * sponsor in work. `progress(text)` hears what is happening.
     */
    async writeRecords(request, { progress = () => {} } = {}) {
      const record = saved();
      if (!record || !key) throw new Error("The wallet is locked: use your passkey, then try again.");
      const owner = record.address;
      const payments = (request.payments ?? []).map(({ to, amount }) => ({ to, amount: BigInt(amount) }));
      const paying = payments.reduce((sum, p) => sum + p.amount, 0n);
      const at = await reach(request.chainPath, owner);
      // Past any this page sent that the host hasn't counted yet.
      const sent = next.get(owner) ?? 0n;
      const nonce = at.nonce > sent ? at.nonce : sent;
      const fee = request.fee === undefined ? at.fee : BigInt(request.fee) > at.fee ? BigInt(request.fee) : at.fee;
      const build = (fee) => transaction({ owner, actions: request.actions, payments, fee, nonce, chainPath: request.chainPath });
      progress("Signing…");
      if (at.balance >= paying + fee) return submit(at.host, build(fee));
      const url = sponsor();
      if (fee === 0n || at.balance < paying || !url) throw new NeedsCoins({ address: owner, needed: paying + fee, balance: at.balance });
      const sponsored = await sponsorFee(url, build(0n), progress);
      return submit(at.host, sponsored.body, sponsored.signatures);
    },
  };
}

// ---------------------------------------------------------------- the fee sponsor

/** POSTs `body` to the sponsor's `path`; its refusal as an Error with the status. */
async function ask(url, path, body) {
  const response = await fetch(new URL(path, url.endsWith("/") ? url : `${url}/`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`The fee sponsor: ${text || response.status}`), { status: response.status });
  return JSON.parse(text);
}

/** A sponsor's wire body as the SDK's: its 64-bit integers as BigInt. */
const fromWire = (body) => ({
  ...body,
  accountActions: body.accountActions.map((a) => ({ owner: a.owner, delta: BigInt(a.delta) })),
  nonce: BigInt(body.nonce),
});
const toWire = (body) => sdk.transactionPayload({}, body).transaction.body;
/** JSON with every object's keys sorted: the sponsor's encoder orders them as it likes. */
const canonical = (value) =>
  JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

/**
 * The sponsored transaction for `draft` (fee 0, one signer): the sponsor's
 * fee debit and signature added, nothing else changed. Earns the fee first,
 * grinding the sponsor's shares, when this browser's credit there is short.
 */
async function sponsorFee(url, draft, progress) {
  const chain = draft.chainPath.join("/");
  let client = null;
  try {
    client = localStorage.getItem(SPONSOR_CLIENT);
  } catch {}
  const sponsored = async () => {
    const { transaction: signed, fee } = await ask(url, "sponsor", { client, transaction: { signatures: {}, body: toWire(draft) } });
    return { ...check(draft, fromWire(signed.body), BigInt(fee)), signatures: signed.signatures };
  };
  if (client) {
    try {
      return await sponsored();
    } catch (error) {
      // 402: the credit here doesn't cover the fee yet (or the sponsor restarted, forgetting it).
      if (error.status !== 402) throw error;
    }
  }
  for (;;) {
    let work;
    try {
      work = await ask(url, "work", { ...(client && { client }), chain });
    } catch (error) {
      // A token from before the sponsor restarted: start over with a new one.
      if (!client || error.status !== 400 || !/client token/.test(error.message)) throw error;
      client = null;
      continue;
    }
    client = work.client;
    try {
      localStorage.setItem(SPONSOR_CLIENT, client);
    } catch {}
    // A share is worth 2^256 / (target + 1) hashes, expected.
    const perShare = 2n ** 256n / (BigInt(`0x${work.shareTarget}`) + 1n);
    if (BigInt(work.sharesForFee) * perShare > MOST_WORK) throw new Error("The fee sponsor asks for more work than this page will do. Try again later, or add coins to your account.");
    if (await grind(url, work, progress)) return sponsored();
  }
}

/** `sponsored` if it is `draft` with only the sponsor's fee added; else throws. */
function check(draft, sponsored, fee) {
  const sponsor = sponsored.signers[1];
  const debit = sponsored.accountActions.at(-1);
  const same = canonical(toWire({ ...sponsored, accountActions: sponsored.accountActions.slice(0, -1), signers: sponsored.signers.slice(0, 1) })) === canonical(toWire(draft));
  if (!same || sponsored.signers.length !== 2 || sponsor === draft.signers[0] || debit?.owner !== sponsor || debit.delta >= 0n || -debit.delta > fee) {
    throw new Error("The fee sponsor changed the transaction. Nothing was sent.");
  }
  return { body: sponsored };
}

/**
 * Grinds `work`'s nonces in this browser's workers, sending each share,
 * until the credit covers the fee (true) or the work expires (false).
 */
function grind(url, work, progress) {
  const fee = BigInt(work.fee);
  const wanted = BigInt(work.sharesForFee);
  const count = Math.max(1, Math.min(8, (navigator.hardwareConcurrency ?? 2) - 1));
  const span = BigInt(work.count) / BigInt(count);
  const workers = [];
  let shares = 0n;
  progress(`Paying the fee with this device's work: 0 of about ${wanted} steps…`);
  return new Promise((resolve, reject) => {
    let sending = Promise.resolve();
    let over = false;
    const finish = (outcome, error) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      for (const worker of workers) worker.terminate();
      error ? reject(error) : resolve(outcome);
    };
    const timer = setTimeout(() => finish(false), Number(work.expiresInMilliseconds));
    for (let i = 0n; i < BigInt(count); i++) {
      const worker = new Worker(new URL("./share-worker.js", import.meta.url));
      worker.onmessage = ({ data }) => {
        if (!data.share) return;
        // One share at a time, so the credit heard last is the newest.
        sending = sending.then(async () => {
          if (over) return;
          try {
            const { credit } = await ask(url, "shares", { assignment: work.assignment, nonce: data.share });
            shares += 1n;
            progress(`Paying the fee with this device's work: ${shares} of about ${wanted} steps…`);
            if (BigInt(credit) >= fee) finish(true);
          } catch (error) {
            // A doubled share earns nothing; expired work, or a full block, calls for new work.
            if (/duplicateShare|missesShareTarget/.test(error.message)) return;
            if (error.status === 400 || error.status === 503) finish(false);
            else finish(false, error);
          }
        });
      };
      worker.onerror = (event) => finish(false, new Error(`The work stopped: ${event.message}`));
      worker.postMessage({ prefixHex: work.prefixHex, targetHex: work.shareTarget, start: String(BigInt(work.startNonce) + i * span), count: String(span) });
      workers.push(worker);
    }
  });
}
