// Profiles and handles on Moniker, the profile chain, read from a state view
// `{ get(key), list(prefix) }` (see state.mjs) and written as
// `{ actions, payments? }` for the wallet (see wallet.mjs).
//
// Keys:
//   user/<a>/profile   the card: JSON { name, description, avatar, header, url, handle, links }
//   user/<a>/<field>   anything else: key.x25519, app.<name>.<field>
//   name/<handle>      <holder> or <holder>@<price>
//
// Records are written by anyone the policy lets through, so every value is
// parsed as untrusted: what does not parse is left out, never fatal.

/** The CID of the profile policy module built from `policy/`. */
export const MONIKER_POLICY = "bafyreihbwjt5uuw2se5rcc4hdmbooo7wcixzsfg6geddutb6rgmbzaenxe";

/** Where Moniker lives. */
export const MONIKER_CHAIN = ["Nexus", "moniker"];

/** The card's text fields every app shows. A card may carry others; they are kept. */
export const CARD_FIELDS = ["name", "description", "avatar", "header", "url", "handle"];

/** Whether `url` is a web address a client may link to: http or https only. */
export function isWebURL(url) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * The card's `links`, in the owner's order, as `[{ label, url }]`: entries
 * that are not a label and a web address are left out.
 */
const readLinks = (links) =>
  Array.isArray(links)
    ? links
        .filter((link) => typeof link?.label === "string" && link.label !== "" && typeof link.url === "string" && isWebURL(link.url))
        .map(({ label, url }) => ({ label, url }))
    : [];

/**
 * Whether a chain spec (see state.mjs `chainSpec`) runs the Moniker policy.
 * Every policy in a spec must accept a transaction, so further policies may
 * refuse more but never let through what this one refuses.
 */
export const runsMoniker = (spec) =>
  Array.isArray(spec?.wasmPolicies) &&
  spec.wasmPolicies.some(
    (policy) =>
      policy?.moduleCID === MONIKER_POLICY &&
      policy.scope === "transaction" &&
      policy.entrypoint === "lattice_validate_transaction",
  );

export const cardKey = (address) => `user/${address}/profile`;
export const fieldKey = (address, field) => `user/${address}/${field}`;
export const handleKey = (handle) => `name/${handle}`;

/** Whether `handle` is one the policy accepts: lowercase letters, digits and `_`. */
export const isHandle = (handle) => typeof handle === "string" && /^[a-z0-9_]+$/.test(handle);

/**
 * Whether `text` is an account address in its one canonical spelling, as the
 * policy checks a handle's holder.
 */
export function isAddress(text) {
  const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
  return (
    typeof text === "string" &&
    text.length === 59 &&
    text.startsWith("bafyrei") &&
    [...text.slice(7)].every((c) => BASE32.includes(c)) &&
    BASE32.indexOf(text[7]) < 8 &&
    BASE32.indexOf(text[58]) % 4 === 0
  );
}

const parseObject = (value) => {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** The holder and price in a handle value, as the policy reads them. */
export function holding(value) {
  if (typeof value !== "string") return undefined;
  const at = value.indexOf("@");
  const holder = at < 0 ? value : value.slice(0, at);
  if (!isAddress(holder)) return undefined;
  if (at < 0) return { holder };
  const digits = value.slice(at + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(digits) || BigInt(digits) >= 2n ** 64n) return undefined;
  return { holder, price: BigInt(digits) };
}

/** A handle value: its holder, and its price when it is for sale. */
export function holdingValue(holder, price) {
  if (!isAddress(holder)) throw new Error(`not an address: ${holder}`);
  if (price === undefined) return holder;
  if (typeof price !== "bigint" || price < 0n || price >= 2n ** 64n) throw new Error(`bad price: ${price}`);
  return `${holder}@${price}`;
}

// Reading.

/**
 * `address`'s profile: the card's text fields and its links, with `handle`
 * kept only when `name/<handle>` names `address` as its holder, so a sold or
 * never-held handle is not shown. What does not parse is left out.
 */
export async function getProfile(state, address) {
  const card = parseObject(await state.get(cardKey(address))) ?? {};
  const profile = { address };
  for (const field of CARD_FIELDS) if (typeof card[field] === "string" && card[field] !== "") profile[field] = card[field];
  if (profile.url !== undefined && !isWebURL(profile.url)) delete profile.url;
  const links = readLinks(card.links);
  if (links.length > 0) profile.links = links;
  if (profile.handle !== undefined) {
    const entry = isHandle(profile.handle) ? await resolve(state, profile.handle) : undefined;
    if (entry?.holder !== address) delete profile.handle;
  }
  return profile;
}

/** Profiles for many addresses at once, in order, for a feed. */
export const getProfiles = (state, addresses) => Promise.all(addresses.map((address) => getProfile(state, address)));

/** `address`'s fields outside the card, as `{ field: value }`. */
export async function getFields(state, address) {
  const prefix = `user/${address}/`;
  const fields = {};
  for await (const [key, value] of state.list(prefix)) {
    const field = key.slice(prefix.length);
    if (field !== "profile") fields[field] = value;
  }
  return fields;
}

export const getField = (state, address, field) => state.get(fieldKey(address, field));

/** The handle as held: `{ handle, value, holder, price? }`, or undefined when free. */
export async function resolve(state, handle) {
  if (!isHandle(handle)) return undefined;
  const value = await state.get(handleKey(handle));
  const held = holding(value);
  return held && { handle, value, ...held };
}

/** Every handle, as `resolve` returns it, in handle order. Reads all of `name/`. */
export async function* handles(state) {
  for await (const [key, value] of state.list("name/")) {
    const held = holding(value);
    if (held) yield { handle: key.slice("name/".length), value, ...held };
  }
}

/** The handles for sale, cheapest first. */
export async function forSale(state) {
  const found = [];
  for await (const entry of handles(state)) if (entry.price !== undefined) found.push(entry);
  return found.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.handle < b.handle ? -1 : 1));
}

/** The handles `address` holds. */
export async function heldBy(state, address) {
  const found = [];
  for await (const entry of handles(state)) if (entry.holder === address) found.push(entry);
  return found;
}

// Writing. Each change names the value the writer read as the old one, so if
// the key changed since, consensus refuses it: nothing is overwritten unseen,
// and nobody pays a price they did not see.

const write = (actions, payments = []) => ({ actions, payments });

/** One write of several, as one transaction. */
export const combine = (...writes) =>
  write(
    writes.flatMap((w) => w.actions),
    writes.flatMap((w) => w.payments ?? []),
  );

/**
 * A change to `address`'s card: each of `changes` sets a field, or removes it
 * when undefined, null, "" or an empty `links`. Text fields are strings;
 * `links` is `[{ label, url }]` with web addresses. Fields the client does not
 * know are kept. An empty card is deleted. Nothing to write when nothing
 * changes.
 */
export async function editCard(state, address, changes) {
  const key = cardKey(address);
  const oldValue = await state.get(key);
  const card = { ...(parseObject(oldValue) ?? {}) };
  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined || value === null || value === "" || (field === "links" && value.length === 0)) delete card[field];
    else if (field === "links") card.links = checkedLinks(value);
    else if (typeof value === "string") card[field] = value;
    else throw new Error(`${field}: card fields are strings`);
  }
  const newValue = Object.keys(card).length > 0 ? JSON.stringify(card) : undefined;
  if (newValue === oldValue) return write([]);
  return write([{ key, ...(oldValue !== undefined && { oldValue }), ...(newValue !== undefined && { newValue }) }]);
}

function checkedLinks(links) {
  if (!Array.isArray(links)) throw new Error("links: a list of { label, url }");
  return links.map(({ label, url }) => {
    if (typeof label !== "string" || label === "") throw new Error("links: every link needs a label");
    if (!isWebURL(url)) throw new Error(`links: ${url} is not an http or https address`);
    return { label, url };
  });
}

/** Sets `address`'s field outside the card, or removes it when undefined. */
export async function setField(state, address, field, value) {
  if (field === "profile" || field === "") throw new Error(`${field || "(empty)"}: not a field name`);
  const key = fieldKey(address, field);
  const oldValue = await state.get(key);
  if (value === oldValue) return write([]);
  return write([{ key, ...(oldValue !== undefined && { oldValue }), ...(value !== undefined && { newValue: value }) }]);
}

/**
 * Edits the card and sends it with `send(write)`. If the send fails because
 * the card changed meanwhile (another app saved first), reads again and
 * retries; any other failure is thrown.
 */
export async function saveCard(readState, address, changes, send, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    const state = await readState();
    const change = await editCard(state, address, changes);
    if (change.actions.length === 0) return undefined;
    try {
      return await send(change);
    } catch (error) {
      const read = change.actions[0].oldValue;
      const now = await (await readState()).get(cardKey(address));
      if (attempt >= attempts || now === read) throw error;
    }
  }
}

/** `address` claims the free `handle`, for sale at `price` or not. */
export async function claim(state, address, handle, price) {
  if (!isHandle(handle)) throw new Error(`${handle}: a handle is lowercase letters, digits and _`);
  if ((await state.get(handleKey(handle))) !== undefined) throw new Error(`@${handle} is taken`);
  return write([{ key: handleKey(handle), newValue: holdingValue(address, price) }]);
}

/** The holder's change of `entry` (as `resolve` returns it) to `holder`, for sale at `price` or not. */
const hold = (entry, holder, price) =>
  write([{ key: handleKey(entry.handle), oldValue: entry.value, newValue: holdingValue(holder, price) }]);

/** The holder puts `entry` up for sale at `price`. Anyone may then take it at that price. */
export const list = (entry, price) => {
  if (price === undefined) throw new Error("a listing needs a price");
  return hold(entry, entry.holder, price);
};

/** The holder takes `entry` off sale. */
export const unlist = (entry) => hold(entry, entry.holder);

/** The holder gives `entry` to `to`, not for sale. */
export const transfer = (entry, to) => hold(entry, to);

/** The holder gives `entry` up; anyone may claim it next. */
export const release = (entry) => write([{ key: handleKey(entry.handle), oldValue: entry.value }]);

/** `buyer` takes `entry` at its price. */
export function buy(entry, buyer) {
  if (entry.price === undefined) throw new Error(`@${entry.handle} is not for sale`);
  if (entry.holder === buyer) throw new Error(`@${entry.handle} is already yours`);
  return write(
    [{ key: handleKey(entry.handle), oldValue: entry.value, newValue: holdingValue(buyer) }],
    [{ to: entry.holder, amount: entry.price }],
  );
}
