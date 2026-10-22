# Moniker

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="app/brand/moniker-lockup-dark.svg">
  <img src="app/brand/moniker-lockup-light.svg" alt="Moniker" width="393" height="100">
</picture>

Own your name on the internet. Moniker sells you an `@handle` that
belongs to you, not to an app: no company can take it back, rename it or
hand it to someone else, and only your key can change where it points. Any
app can know you by it.

Moniker (`Nexus/moniker` in tests, `Nexus/testnet/moniker-01c01f` on the
testnet trial) is the names chain: it holds names, where each one points,
and the handle each account shows. There are no profiles and no admins:
an account is the identity, and apps keep their own records (cards
included) on their own chains, keyed by account.

## Names and accounts

- An **account** is a key, kept in the person's wallet. It is never shown,
  only checked ("Owned by …1a2b3c"). It owns names.
- A **name** (`@handle`) is an asset its account owns, like a domain: it
  sells it, gives it or releases it, and points it at one account, any
  account.

An account `a` shows `@h` in every app only while `points/h` is `a` **and**
`user/<a>/name` is `h`: either side alone shows nothing, so no one shows a
name that doesn't point at them, and no name shows on an account that
doesn't choose it. One read of Moniker decides.

Selling or giving a name moves the name and clears its pointer (the buyer
may set it, to itself, in the same transaction), so a seller stops showing
a name it sold. Releasing a name deletes its pointer; anyone may claim it
next.

## Records

| Key | Value | Who may write |
| --- | --- | --- |
| `name/<h>` | `<owner>`, `<owner>@<price>` (for sale to anyone) or `<owner>><account>` (offered to one account) | its owner, who may also release it; anyone buys at the price; the account it is offered to takes it |
| `names/<a>/<h>` | `1` while account `<a>` owns `@h`: an account's names in one read | only together with the name it indexes |
| `points/<h>` | The account `@h` points at | the name's owner, right after the name; deleted when it is released |
| `user/<a>/name` | The handle account `<a>` shows, while it points at `<a>` | `<a>` |
| `user/<a>/...` | An account's other values, such as `key.x25519` or `app.<name>.<field>` | `<a>` |

A handle is lowercase letters, digits and `_`. The first to claim a free
name owns it. A buyer names the value they read, so if the price changed,
the purchase is refused.

The policy sees only a transaction, so a write acting for a name rewrites
its token to the value it has: consensus checks every old value, and the
policy reads the owner from it. Nothing is put on an account without its
signature, which is why a gift is an offer the receiver takes. The policy
reads the actions once, in order: a name, then the index keys it moves (the
one it leaves first), then its pointer; a seller's purchases one after
another. The SDK writes this order; anyone writing transactions by hand
follows it.

The policy module is
`bafyreihnnbeuihjlw23xswfhduf23xbltsmn37oymwshmenmzsabgv4fzu`
(`chain/spec.json`; `chain/moniker_policy.wasm` is that module).

## Use Moniker in your app

Apps read and write Moniker through
[moniker-sdk](https://github.com/adalinxx/moniker-sdk): one import, no key
handling, writes signed in the person's Selfhold wallet.

```js
import { createMoniker } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@<release>/src/browser.mjs";

const moniker = createMoniker();
await moniker.name("@alice");                       // { handle, owner, price?, offer?, pointer? }
await moniker.handleOf(address);                    // "alice" while both sides agree, else undefined
await moniker.handlesOf(addresses);                 // for a feed, in order, from one read
await moniker.label(address, card);                 // "Alice @alice"
await moniker.claim("@alice", { show: true }, { wallet: window.lattice }); // point it at you and show it, in one transaction
```

This repo holds the SDK as the submodule `sdk/`; clone with
`--recurse-submodules`, or run `git submodule update --init`.

## The app

Logo masters, transparent PNG exports, and favicons live in [`app/brand/`](app/brand/).
See the [asset guide](app/brand/README.txt) for colors, spacing, and usage.

`app/` is a static names manager laid out like a domain registrar:

- **Search**: a name's page says whether it is free (Claim it, pointed at
  you, optionally listed at a price at once, optionally shown as your
  handle in the same approval), for sale (Buy: it comes pointing at you),
  offered to you (Take), yours or taken; who owns it ("Owned by …" and the
  account's last 6 characters, linking to its page); where it points
  ("Points at …", linking to that account) and whether that account shows
  it. A name pointing at you offers Show this handle.
- **My names**: the handle your account shows, with Stop showing; each
  name with a menu: Show this handle, Point at me, Point at an account…,
  Stop pointing, Sell, Give to an account, Stop selling or Take back the
  offer, and Release (confirmed in the page); others' names pointing at you,
  each with Show this handle; and Claim a new name. A gift is an offer: the
  giver gets a link to send, and the receiver takes it from there.
- **For sale**: names their owners are selling.
- **Accounts** (`#/account/<address>`): the handle an account shows, and
  the names it owns.

There is no log in: the page asks the wallet only where a key is needed,
and only from a click, as Selfhold requires. Without a wallet it shows how to
add Selfhold where a key is needed; back on the tab after adding it, the
page reloads at the same place, and on a phone it offers the link to finish
on a computer. Writes are free on the trial chain (its hosts admit 0-fee
transactions). It reads every record by CID from the nodes in Settings (by
default the shared testnet hosts `lattice-testnet-apps-iad` and `-ams`,
chain `Nexus/testnet/moniker-01c01f`); settings saved for an older trial
chain follow the move. Fonts ship in `app/fonts/` (SIL Open Font License).

```sh
python3 -m http.server 8765   # from the repository root, then open http://127.0.0.1:8765/app/
```

## Layout

- `rules/`: `lattice-policy-rules`, the parts Lattice policies share:
  reading the context and body, and the token rule.
- `policy/`: the Moniker policy.
- `chain/`: the chain spec and the built policy module it names.
- `sdk/`: [moniker-sdk](https://github.com/adalinxx/moniker-sdk), a
  submodule: the record code (`sdk/src/records/`), the library for apps, and
  the Lattice SDK bundle.
- `e2e/moniker.mjs`: names against a real node, moniker-sdk included.
- `e2e/ui/`: the page in headless Chromium with the real Selfhold wallet.

## Build and test

```
cd policy
cargo build --release --target wasm32-unknown-unknown
LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/policy.test.mjs
cd ..
LATTICE=<lattice-node>/.build/debug/lattice \
  LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/moniker.mjs
cd e2e/ui && npm install
LATTICE=<lattice-node>/.build/debug/lattice \
  LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js \
  LATTICE_WALLET=<selfhold>/dist npm test
```

After building the policy, copy the module to `chain/moniker_policy.wasm`
and put its CID (`policy/host-check/.build/debug/host-check <wasm> <dir>`
prints it) in `chain/spec.json` and `e2e/ui/spec.json`. To replay every
policy test context through Lattice's own host, run the policy tests with
`CONTEXT_DIR=<dir>`, then
`swift run --package-path policy/host-check host-check policy/target/wasm32-unknown-unknown/release/moniker_policy.wasm <dir>`.
