# Moniker

One chain, Moniker (`Nexus/moniker`), holds every account's profile and every handle.
Any app reads and writes it; no app keeps its own profile.

## Records

| Key | Value | Who may write |
| --- | --- | --- |
| `user/<a>/profile` | The card, JSON: `name`, `description`, `avatar` (CID), `header` (CID), `url`, `handle` (strings) and `links` (`[{ label, url }]`, in order); all optional | `<a>` |
| `user/<a>/key.x25519` | A public encryption key the owner manages directly (a key an app derives for its own origin goes under `app.<name>.*`, e.g. Fanfare's `app.fanfare.x25519`) | `<a>` |
| `user/<a>/app.<name>.<field>` | An app's own data | `<a>` |
| `name/<handle>` | `<holder>` or `<holder>@<price>` | see below |

The card holds what a feed shows, so one read is enough per author. A card
may carry fields this list does not name; clients keep them when they save.
Display names are not unique. `url` and every link are http or https
addresses; clients show nothing else. Media is a CID of a one-block Volume
`{ type, bytes }` that the author pins; never a URL.

## Handles

A handle is lowercase letters, digits and `_`. Its value is its holder, an
account address, optionally with an asking price.

- **Claim**: the first to write a free handle holds it.
- **Holder**: may transfer, price, unprice or release it.
- **Anyone**: may take a priced handle by paying the holder at least the price
  in the same transaction. The buyer names the value they read, so if the
  price changed, the purchase is refused.

An app shows `@h` on `<a>`'s profile only when `<a>`'s card says
`handle: "h"` and `name/h` is held by `<a>`.

## Use Moniker in your app

One import, no key handling: reads come from Moniker's nodes and are checked by
CID; writes go to the person's Lattice Wallet, which shows and signs them.

Import a release, never the live site: code your users run should change only
when you choose to upgrade. A tag through jsDelivr's GitHub mirror is fixed
(`@v0.1.0`; a commit hash pins harder still), or vendor a copy of `lib/`,
`client/` and `app/vendor/` and review upgrades like any dependency.
`https://adalinxx.github.io/moniker/lib/browser.mjs` follows `main` and is for
trying things out.

```js
import { createMoniker, defineMonikerName } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker@v0.1.0/lib/browser.mjs";

const moniker = createMoniker();                 // testnet trial by default; or { nodes, chain }
const p = await moniker.profile(address);        // { address, name?, description?, avatar?, url?, handle?, links? }
const people = await moniker.profiles(authors);  // a feed's bylines, in order, from one read
const who = await moniker.resolve("@alice");     // the holder's address, or undefined
img.src = await moniker.photo(p.avatar);         // an object URL, or null
moniker.label(p);                                // name, else @handle, else a short address
moniker.pageURL(address);                        // their Moniker page

const wallet = window.lattice;                   // the Lattice Wallet extension
await moniker.save({ name: "Alice", links: [{ label: "Site", url: "https://alice.example" }] }, { wallet });
await moniker.setField("app.myapp.theme", "dark", { wallet });
await moniker.claim("alice", { wallet });        // also sell, unlist, buy, give, release

defineMonikerName(moniker);                      // <moniker-name address="bafyrei…" size="24"></moniker-name>
```

`save` keeps card fields it does not know and retries when another app saved
the card first. Store your app's own data in fields named `app.<your app>.*`.
`<moniker-name>` shows the photo, name and `@handle`, linked to the page
(`plain` drops the link); restyle it with `--moniker-ink`, `--moniker-muted`,
`--moniker-accent` and `--moniker-avatar`. See `lib/demo.html`.

In Node or a bundler, import `lib/index.mjs` and pass the SDK:
`createMoniker({ sdk })`.

## The app

`app/` is a static page: one page per account, like a link page (photo,
name, `@handle`, bio, a stack of links), plus Edit and Handles. It reads every
record by CID from the nodes in Settings (by default the shared testnet hosts
`lattice-testnet-apps-iad` and `-ams`, chain `Nexus/testnet/moniker-da6f57`)
and asks the Lattice Wallet extension to approve each write: a save is one
transaction, a buy pays the holder in the same one. Reading needs no wallet.
A photo is kept by your own node: set its URL and cookie in Settings (the node
must list the page's origin in `rpcAllowedOrigins`). Fonts ship in
`app/fonts/` (SIL Open Font License) and the SDK in `app/vendor/` (see Stoa's
`app/vendor/README.md` for the bundle command).

```sh
python3 -m http.server 8765   # from the repository root, then open http://127.0.0.1:8765/app/
```

`e2e/ui/` runs the page in headless Chromium with the real wallet extension
against a private stack:

```sh
cd e2e/ui && npm install
LATTICE=<lattice-node>/.build/debug/lattice \
  LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js \
  LATTICE_WALLET=<lattice-wallet>/dist npm test
```

## Layout

- `rules/`: `lattice-policy-rules`, the parts Lattice policies share: reading
  the context and body, and the token rule. The Fanfare policy builds on it
  too.
- `policy/`: the chain's policy. `chain/spec.json` names the built module;
  `chain/moniker_policy.wasm` is that module.
- `client/`: `profile.mjs` (reads and writes), `state.mjs` (reads state by
  descending the trie, checked by CID), `media.mjs`, `wallet.mjs` (the request
  the Lattice wallet signs).
- `lib/`: the library for other apps (`index.mjs`, `browser.mjs`, the `<moniker-name>` element, `demo.html`).
- `e2e/moniker.mjs`: the whole flow against a real node, the library included.

## Build and test

```
cd policy
cargo build --release --target wasm32-unknown-unknown
LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/policy.test.mjs
cd ..
LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node --test client/*.test.mjs
LATTICE=<lattice-node>/.build/debug/lattice \
  LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/moniker.mjs
```

To replay every policy test context through Lattice's own host, run the policy
tests with `CONTEXT_DIR=<dir>`, then
`swift run --package-path policy/host-check host-check policy/target/wasm32-unknown-unknown/release/moniker_policy.wasm <dir>`.
