# Moniker

One chain, Moniker (`Nexus/moniker`), holds every account's profile and every handle.
Any app reads and writes it; no app keeps its own profile.

## Records

| Key | Value | Who may write |
| --- | --- | --- |
| `user/<a>/profile` | The card, JSON: `name`, `description`, `avatar` (CID), `header` (CID), `url`, `handle`; all optional strings | `<a>` |
| `user/<a>/com.github`, `com.twitter`, … | A linked account's name, as the owner states it | `<a>` |
| `user/<a>/key.x25519` | A public encryption key the owner manages directly (a key an app derives for its own origin goes under `app.<name>.*`, e.g. Fanfare's `app.fanfare.x25519`) | `<a>` |
| `user/<a>/app.<name>.<field>` | An app's own data | `<a>` |
| `name/<handle>` | `<holder>` or `<holder>@<price>` | see below |

The card holds what a feed shows, so one read is enough per author. A card
may carry fields this list does not name; clients keep them when they save.
Display names are not unique. Media is a CID of a one-block Volume
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

## Layout

- `rules/`: `lattice-policy-rules`, the parts Lattice policies share: reading
  the context and body, and the token rule. The Fanfare policy builds on it
  too.
- `policy/`: the chain's policy. `chain/spec.json` names the built module;
  `chain/moniker_policy.wasm` is that module.
- `client/`: `profile.mjs` (reads and writes), `state.mjs` (reads state by
  descending the trie, checked by CID), `media.mjs`, `wallet.mjs` (the request
  the Lattice wallet signs).
- `e2e/moniker.mjs`: the whole flow against a real node.

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
