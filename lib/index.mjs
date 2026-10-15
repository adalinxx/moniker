// Moniker for other apps: read anyone's profile and handle, and let the
// person edit their own and trade handles through their Lattice Wallet.
//
//   const moniker = createMoniker({ sdk });           // sdk: the Lattice SDK module
//   const p = await moniker.profile(address);         // { address, name?, handle?, … }
//   const ps = await moniker.profiles([a, b, c]);      // for a feed, in order
//   const address = await moniker.resolve("@alice");   // or undefined
//   img.src = await moniker.photo(p.avatar);           // an object URL, or null
//   await moniker.save({ name: "Alice" }, { wallet: window.lattice });
//
// Reads go to the first of `nodes` that answers and are checked by CID, so
// they do not depend on trusting that node. Writes go to the wallet, which
// shows them to the person and signs; this library never holds a key.
import * as profileRecords from "../client/profile.mjs";
import { anyHost, tip, view, volumeLoader } from "../client/state.mjs";
import { writeRequest } from "../client/wallet.mjs";

/** Where Moniker lives now: the testnet trial chain and its shared hosts. */
export const DEFAULTS = {
  chain: ["Nexus", "testnet", "moniker-da6f57"],
  nodes: ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"],
  app: "https://adalinxx.github.io/moniker/app/",
  fee: 1n,
  // How long a read state is reused before asking for the tip again.
  freshFor: 10_000,
};

// Raster images only: an SVG is a document that can run script.
const PHOTO_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;

export function createMoniker(options) {
  const { sdk, chain, nodes, app, fee, freshFor } = { ...DEFAULTS, ...options };
  if (!sdk) throw new Error("createMoniker needs { sdk }: the Lattice SDK module");
  const volumes = new sdk.VolumeClient(anyHost(nodes.map((node) => new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: chain }))));
  const load = volumeLoader(volumes, sdk.decodeDagCbor);

  let current = null; // { at, state: Promise }
  /** The chain's state at the tip of the first node that answers, reused for `freshFor` ms. */
  function state({ fresh = false } = {}) {
    if (!fresh && current && Date.now() - current.at < freshFor) return current.state;
    const read = (async () => {
      let failure;
      for (const node of nodes) {
        try {
          const { generalStateCID } = await tip(sdk, node, chain, volumes);
          return view(load, generalStateCID);
        } catch (error) {
          failure = error;
        }
      }
      throw new Error(`No node is serving ${chain.join("/")}`, { cause: failure });
    })();
    current = { at: Date.now(), state: read };
    read.catch(() => current?.state === read && (current = null));
    return read;
  }

  const photos = new Map();
  /** An object URL for the photo at `cid`, or null when no node serves it or it is not an image. */
  function photo(cid) {
    if (typeof cid !== "string" || cid === "") return Promise.resolve(null);
    if (!photos.has(cid)) {
      photos.set(
        cid,
        (async () => {
          const volume = await volumes.get(cid);
          const file = sdk.decodeDagCbor(volume.bytes(cid));
          if (typeof file?.type !== "string" || !PHOTO_TYPES.test(file.type) || !(file.bytes instanceof Uint8Array)) return null;
          return URL.createObjectURL(new Blob([file.bytes], { type: file.type }));
        })().catch(() => {
          photos.delete(cid);
          return null;
        }),
      );
    }
    return photos.get(cid);
  }

  /** The wallet request for a write, sent; resolves when the wallet has sent it. */
  const needWallet = (wallet) => {
    if (!wallet?.writeRecords) throw new Error("This needs the Lattice Wallet extension (window.lattice).");
    return wallet;
  };
  const send = (wallet) => (write) => needWallet(wallet).writeRecords(writeRequest(chain, write, fee));
  const me = async (wallet) => (await needWallet(wallet).address?.()) ?? (await wallet.connect());
  const entry = async (handle) => {
    const found = await profileRecords.resolve(await state({ fresh: true }), String(handle).replace(/^@/, ""));
    if (!found) throw new Error(`No one holds @${String(handle).replace(/^@/, "")}`);
    return found;
  };

  return {
    chain,
    nodes,
    state,

    // ---- reading

    /** `address`'s profile: `{ address, name?, description?, avatar?, header?, url?, handle?, links? }`. */
    profile: async (address) => profileRecords.getProfile(await state(), address),
    /** Profiles for many addresses, in order, from one state. */
    profiles: async (addresses) => profileRecords.getProfiles(await state(), addresses),
    /** The address that holds `@handle` (with or without the @), or undefined. */
    resolve: async (handle) => (await profileRecords.resolve(await state(), String(handle).replace(/^@/, "")))?.holder,
    /** A field outside the card, such as `key.x25519` or `app.<name>.<field>`. */
    field: async (address, name) => profileRecords.getField(await state(), address, name),
    /** Handles for sale, cheapest first: `[{ handle, holder, price }]`. */
    forSale: async () => profileRecords.forSale(await state()),
    photo,
    /** A link to `address`'s Moniker page, or to `@handle`'s. */
    pageURL: (who) => `${app}#/${encodeURIComponent(who)}`,
    /** What to show for an account in a byline: its name, else @handle, else a short address. */
    label: (p) => p.name ?? (p.handle ? `@${p.handle}` : `${p.address.slice(0, 7)}…${p.address.slice(-5)}`),

    // ---- writing, through the person's wallet

    /**
     * Changes the connected account's card: each key of `changes` sets a
     * field (`name`, `description`, `avatar`, `header`, `url`, `handle`,
     * `links`, or one of your own) or removes it when undefined, null or "".
     * Fields this library does not know are kept. Retried if another app
     * saved the card meanwhile. Resolves to the wallet's answer, or undefined
     * when nothing changed.
     */
    save: async (changes, { wallet }) =>
      profileRecords.saveCard(() => state({ fresh: true }), await me(wallet), changes, send(wallet)),
    /** Sets a field outside the card for the connected account, or removes it with undefined. */
    setField: async (name, value, { wallet }) =>
      send(wallet)(await profileRecords.setField(await state({ fresh: true }), await me(wallet), name, value)),
    /** Claims a free handle for the connected account. */
    claim: async (handle, { wallet }) =>
      send(wallet)(await profileRecords.claim(await state({ fresh: true }), await me(wallet), String(handle).replace(/^@/, ""))),
    /** Puts a handle the connected account holds up for sale: anyone may then buy it at `price` at once. */
    sell: async (handle, price, { wallet }) => send(wallet)(profileRecords.list(await entry(handle), BigInt(price))),
    /** Takes a handle off sale. */
    unlist: async (handle, { wallet }) => send(wallet)(profileRecords.unlist(await entry(handle))),
    /** Buys a handle at the price the chain holds now; the holder is paid in the same transaction. */
    buy: async (handle, { wallet }) => send(wallet)(profileRecords.buy(await entry(handle), await me(wallet))),
    /** Gives a handle to `address`. */
    give: async (handle, address, { wallet }) => send(wallet)(profileRecords.transfer(await entry(handle), address)),
    /** Gives a handle up; anyone may claim it next. */
    release: async (handle, { wallet }) => send(wallet)(profileRecords.release(await entry(handle))),
  };
}

export const { isAddress, isHandle, isWebURL } = profileRecords;
