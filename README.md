# Moniker

Register your name on the internet. Moniker gives you an `@handle` that
belongs to you, not to an app: no company can take it back, rename it or
hand it to someone else, and only your key can change what it says. Every
Lattice app knows you by it.

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
import { createMoniker, defineMonikerName } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.1.2/src/browser.mjs";
```

moniker-sdk is also where the record code lives (cards, fields, handles,
reading state, the wallet request). This repo holds it as the submodule `sdk/`,
pinned to a release; clone with `--recurse-submodules`, or run
`git submodule update --init`.

## The app

`app/` is a static page: one page per account, like a link page (photo,
name, `@handle`, bio, a stack of links), plus Edit and Handles. The front
door is a name search: type a handle and it says whether it is available, taken or
for sale. Registering it is the sign-up: connect the Lattice Wallet, give a
name, and one approval claims the handle and writes the page with it. Writes
are free on the trial chain (its hosts admit 0-fee transactions), so a new
account needs no coins. It reads every
record by CID from the nodes in Settings (by default the shared testnet hosts
`lattice-testnet-apps-iad` and `-ams`, chain `Nexus/testnet/moniker-da6f57`)
and asks the Lattice Wallet extension to approve each write: a save is one
transaction, a buy pays the holder in the same one. Reading needs no wallet.
A photo is kept by your own node: set its URL and cookie in Settings (the node
must list the page's origin in `rpcAllowedOrigins`). Fonts ship in
`app/fonts/` (SIL Open Font License); the app reads and writes through
`sdk/src/records/` and the Lattice SDK bundle in `sdk/vendor/`.

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
- `sdk/`: [moniker-sdk](https://github.com/adalinxx/moniker-sdk), a submodule:
  the record code (`sdk/src/records/`), the library for other apps, and the
  Lattice SDK bundle.
- `client/`: `media.mjs` (photos as one-block Volumes), and
  `profile.test.mjs`, which checks the records in `sdk/` against the policy.
- `e2e/moniker.mjs`: the whole flow against a real node, moniker-sdk included.

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
