// The policy's rules restated plainly from its documentation (policy/src/lib.rs
// and rules/src/tokens.rs), over a decoded body, for the property tests to
// check the built module against. Written apart from the Rust on purpose:
// where the two disagree, one of them is wrong.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const PRICE_MAX = (1n << 63n) - 1n;
export const MAX_KEY_BYTES = 512;
export const MAX_VALUE_BYTES = 16 * 1024;

const bytes = (text) => Buffer.byteLength(text, "utf8");

/** An account address in its one canonical spelling. */
export function isAddress(text) {
  if (typeof text !== "string" || text.length !== 59 || !text.startsWith("bafyrei")) return false;
  if (![...text.slice(7)].every((c) => BASE32.includes(c))) return false;
  return BASE32.indexOf(text[7]) < 8 && BASE32.indexOf(text[58]) % 4 === 0;
}

export const isHandle = (text) => /^[a-z0-9_]+$/.test(text);

/**
 * A name's value: `<owner>` (kept), `<owner>@<price>` (for anyone at that
 * price) or `<owner>><taker>` (offered to that one account for nothing).
 * Null when it is none of these.
 */
export function token(value) {
  const at = value.search(/[@>]/);
  if (at < 0) return isAddress(value) ? { owner: value, terms: "kept" } : null;
  const [owner, rest] = [value.slice(0, at), value.slice(at + 1)];
  if (!isAddress(owner)) return null;
  if (value[at] === "@") {
    if (!/^(0|[1-9][0-9]*)$/.test(rest) || BigInt(rest) > PRICE_MAX) return null;
    return { owner, terms: "price", price: BigInt(rest) };
  }
  return isAddress(rest) && rest !== owner ? { owner, terms: "offer", to: rest } : null;
}

/** What a key is, by shape; null for anything else. */
export function shape(key) {
  const slash = key.indexOf("/");
  if (slash < 0) return null;
  const [kind, rest] = [key.slice(0, slash), key.slice(slash + 1)];
  if (kind === "user") return { kind: "own", account: rest.split("/")[0] };
  if (kind === "name") return isHandle(rest) ? { kind: "name", handle: rest } : null;
  if (kind === "points") return isHandle(rest) ? { kind: "points", handle: rest } : null;
  if (kind === "names") {
    const at = rest.indexOf("/");
    if (at < 0) return null;
    const [account, handle] = [rest.slice(0, at), rest.slice(at + 1)];
    return isAddress(account) && isHandle(handle) ? { kind: "names", account, handle } : null;
  }
  return null;
}

/** Whether the policy should accept a transaction body. */
export function accepts({ signers, actions, accountActions }) {
  if (!signers.every(isAddress)) return false;
  const signs = (account) => signers.includes(account);
  // The names/ keys a name's move calls for, in order: the one it leaves,
  // then the one it reaches.
  let due = [];
  // The name written by the action just before, while its pointer may follow.
  let last = null;
  // What purchases owe, one run per seller paid in a row.
  const runs = [];
  let claimed = false;
  // Whether the name just written came to a new owner, whose pointer must
  // come next, set or cleared.
  let unpointed = false;

  for (const { key, oldValue, newValue } of actions) {
    if (bytes(key) > MAX_KEY_BYTES || (newValue != null && bytes(newValue) > MAX_VALUE_BYTES)) return false;
    const k = shape(key);
    if (!k) return false;
    if (due.length > 0) {
      // Only the index key called for comes next.
      if (k.kind !== "names") return false;
      const created = oldValue == null && newValue === "1" ? true : oldValue != null && newValue == null ? false : null;
      const [want] = due;
      if (created === null || want.account !== k.account || want.handle !== k.handle || want.created !== created) return false;
      due = due.slice(1);
      continue;
    }
    if (unpointed) {
      if (k.kind !== "points") return false;
      unpointed = false;
    }
    if (k.kind === "points") {
      // Only the name's owner points it, right after it; a released name's
      // pointer is only deleted.
      if (!last || last.handle !== k.handle) return false;
      if (last.released) {
        if (!(oldValue != null && newValue == null)) return false;
      } else {
        if (!last.signs) return false;
        if (newValue != null ? !isAddress(newValue) : oldValue == null) return false;
      }
      continue;
    }
    last = null;
    if (k.kind === "own") {
      if (!signs(k.account)) return false;
      continue;
    }
    if (k.kind !== "name") return false;

    if (oldValue == null && newValue != null) {
      if (claimed) return false;
      claimed = true;
    }
    const before = oldValue == null ? null : token(oldValue);
    if (oldValue != null && !before) return false;
    const after = newValue == null ? null : token(newValue);
    if (newValue != null && !after) return false;
    last = { handle: k.handle, released: !after, signs: after ? signs(after.owner) : false };
    unpointed = Boolean(after) && before?.owner !== after.owner;
    if (before && oldValue === newValue) continue; // unchanged: anyone may write it
    if (!before && !after) return false;
    if (!before) {
      if (!signs(after.owner)) return false; // its owner creates a new name
    } else if (!after) {
      if (!signs(before.owner)) return false; // only its owner releases it
    } else {
      if (before.owner !== after.owner && !signs(after.owner)) return false; // nobody is given one unsigned
      if (!signs(before.owner)) {
        // Anyone else only takes it, on its terms.
        if (before.owner === after.owner) return false;
        if (before.terms === "price") {
          if (before.price > 0n) {
            const run = runs.at(-1);
            if (run && run.seller === before.owner) run.owed += before.price;
            else runs.push({ seller: before.owner, owed: before.price });
          }
        } else if (!(before.terms === "offer" && before.to === after.owner)) return false;
      }
    }
    const [from, to] = [before?.owner, after?.owner];
    if (from !== to) {
      due = [
        ...(from ? [{ account: from, handle: k.handle, created: false }] : []),
        ...(to ? [{ account: to, handle: k.handle, created: true }] : []),
      ];
    }
  }
  if (due.length > 0 || unpointed) return false;

  // Each run is paid by the seller's next credit, in order.
  let next = 0;
  for (const { seller, owed } of runs) {
    while (next < accountActions.length && accountActions[next].owner !== seller) next++;
    if (next === accountActions.length) return false;
    const { delta } = accountActions[next++];
    if (!(delta >= owed)) return false;
  }
  return true;
}
