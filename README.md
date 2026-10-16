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

Other apps read and write Moniker through
[moniker-sdk](https://github.com/adalinxx/moniker-sdk): one import, no key
handling, writes signed in the person's Lattice Wallet.

```js
import { createMoniker, defineMonikerName } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.1.0/src/browser.mjs";
```

Its `src/records/` is a copy of `client/` here: change them together.

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
- `e2e/moniker.mjs`: the whole flow against a real node, moniker-sdk included
  (`MONIKER_SDK`, by default `../moniker-sdk` beside this checkout).

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
