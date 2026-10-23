// The policy's rules restated plainly from its documentation (policy/src/lib.rs
// and rules/src/lib.rs), over a decoded body, for the property tests to check
// the built module against. Written apart from the Rust on purpose: where the
// two disagree, one of them is wrong.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const U64_MAX = (1n << 64n) - 1n;

/** An account address in its one canonical spelling. */
export function isAddress(text) {
  if (text.length !== 59 || !text.startsWith("bafyrei")) return false;
  if (![...text.slice(7)].every((c) => BASE32.includes(c))) return false;
  return BASE32.indexOf(text[7]) < 8 && BASE32.indexOf(text[58]) % 4 === 0;
}

/** `<holder>` or `<holder>@<price>`, with a canonical u64 price; otherwise null. */
export function holding(value) {
  const at = value.indexOf("@");
  const holder = at < 0 ? value : value.slice(0, at);
  if (holder === "") return null;
  if (at < 0) return { holder, price: null };
  const digits = value.slice(at + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(digits) || BigInt(digits) > U64_MAX) return null;
  return { holder, price: BigInt(digits) };
}

const isHandleKey = (key) => key.startsWith("name/");

export const MAX_ACTIONS = 256;
export const MAX_HANDLE_ACTIONS = 16;
export const MAX_SIGNERS = 8;
export const MAX_KEY_BYTES = 512;
export const MAX_VALUE_BYTES = 16 * 1024;

const bytes = (text) => Buffer.byteLength(text, "utf8");

/** Whether the policy should accept a transaction body. */
export function accepts({ signers, actions, accountActions }) {
  if (signers.length > MAX_SIGNERS || actions.length > MAX_ACTIONS) return false;
  if (actions.some((a) => bytes(a.key) > MAX_KEY_BYTES || (a.newValue != null && bytes(a.newValue) > MAX_VALUE_BYTES))) return false;
  const handleActions = actions.filter((a) => isHandleKey(a.key));
  if (handleActions.length > MAX_HANDLE_ACTIONS) return false;
  // A claim: a handle written with no value before.
  if (handleActions.filter((a) => a.oldValue == null && a.newValue != null).length > 1) return false;
  const signs = (who) => signers.includes(who);
  const owed = new Map();
  for (const { key, oldValue, newValue } of actions) {
    if (!isHandleKey(key)) {
      const [first, owner] = key.split("/");
      if (first !== "user" || owner === undefined || !signs(owner)) return false;
      continue;
    }
    if (!/^[a-z0-9_]+$/.test(key.slice("name/".length))) return false;
    const before = oldValue == null ? null : holding(oldValue);
    if (oldValue != null && !before) return false;
    if (newValue == null) {
      // A release, by its holder only.
      if (!before || !signs(before.holder)) return false;
      continue;
    }
    const after = holding(newValue);
    if (!after || !isAddress(after.holder)) return false;
    if (!before) {
      if (!signs(after.holder)) return false;
      continue;
    }
    if (signs(before.holder)) continue;
    if (before.price === null) return false;
    owed.set(before.holder, (owed.get(before.holder) ?? 0n) + before.price);
  }
  for (const [holder, price] of owed) {
    const credited = accountActions.filter((a) => a.owner === holder && a.delta > 0n).reduce((sum, a) => sum + a.delta, 0n);
    if (credited < price) return false;
  }
  return true;
}
