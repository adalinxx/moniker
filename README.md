# Moniker

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="app/brand/moniker-lockup-dark.svg">
  <img src="app/brand/moniker-lockup-light.svg" alt="Moniker" width="393" height="100">
</picture>

Own your name on the internet. Moniker sells you an `@handle` that
belongs to you, not to an app: no company can take it back, rename it or
hand it to someone else, and only your key can change where it points. Any
app can know you by it.

Moniker (`Nexus/moniker`, launched 2026-10-24) is the names chain: it holds names, where each one points,
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

A name that comes to a new owner, claimed, bought or taken as offered, is
pointed by that owner in the same transaction: at itself (the SDK's
default), at any account, or cleared if a pointer is there. Consensus checks
the pointer's old value, so none a seller or an earlier owner left survives,
and a seller stops showing a name it sold. Releasing a name may delete its
pointer; whoever claims it next points it again.

## Records

| Key | Value | Who may write |
| --- | --- | --- |
| `name/<h>` | `<owner>`, `<owner>@<price>` (for sale to anyone) or `<owner>><account>` (offered to one account) | its owner, who may also release it; anyone buys at the price; the account it is offered to takes it |
| `names/<a>/<h>` | `1` while account `<a>` owns `@h`: an account's names in one read | only together with the name it indexes |
| `points/<h>` | The account `@h` points at | the name's owner, right after the name; written whenever the name comes to a new owner; deleted when it is released |
| `user/<a>/name` | The handle account `<a>` shows, while it points at `<a>` | `<a>` |
| `user/<a>/...` | An account's other values, such as `key.x25519` or `app.<name>.<field>` | `<a>` |

A handle is lowercase letters, digits and `_`. The first to claim a free
name owns it, one claim per transaction. Every node keeps what is written
for good and writes may be free, so a key is at most 512 bytes (a handle at
most 446 characters, for its `names/<a>/<h>` key) and a value at most 16 KiB. A buyer names the value they read, so if the price changed,
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
`bafyreicybs2dkpihbguywhftikjqbeh566p3zk5visa7bh2wxttdjinfp4`
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
  handle in the same approval), for sale (Buy opens a checkout, `#/buy/<h>`;
  see below), offered to you (Take), yours or taken; who owns it ("Owned by …" and the
  account's last 6 characters, linking to its page); where it points
  ("Points at …", linking to that account) and whether that account shows
  it. A name pointing at you offers Show this handle.
- **Checkout** (`#/buy/<h>`): the price and whom it pays, the way to pay
  first offered, and the others folded under "Other ways to pay". Only Pay
  asks a wallet anything, and the name comes pointing at the paying account.
  - *Selfhold*: Selfhold's window, with the account it gave this site, or
    Continue with Selfhold to get one. Its fee reads "Free, paid with this
    device's GPU", so the account pays the price alone. Short of it, the
    page offers "Pay with this device's GPU" first: the GPU earns what the
    account lacks as it earns the fee, from a sponsor that pays prices
    (`--most-pay`). Add coins comes second, and is what remains where the
    sponsor won't pay that much.
  - *Selfhold for Chrome*: only where it is the wallet, the account it
    connects. Each Selfhold keeps its own account, so the checkout never offers
    the other's beside it; the checkout, My names and Settings say which
    wallet keeps the account in use.
  - *Another wallet or device*: the purchase as a `lattice://write` request
    (moniker-sdk's `writeRequestURI`), good for 15 minutes, as a QR code to
    scan, text to copy, and a card to drag into a wallet's tab, as Selfhold
    reads a drop. It names no account and no fee: the wallet picks both. The
    page watches the chain and follows the name to its buyer.
  The QR code is drawn by paulmillr's `qr` 0.7.2 (`app/vendor/qr.mjs`, its
  encoder, at Selfhold's pin; MIT).
- **My names**: the handle your account shows, with Stop showing; each
  name with a menu: Show this handle, Point at me, Point at an account…,
  Stop pointing, Sell, Give to an account, Stop selling or Take back the
  offer, and Release (confirmed in the page); others' names pointing at you,
  each with Show this handle; and Claim a name. A gift is an offer: the
  giver gets a link to send, and the receiver takes it from there.
- **For sale**: names their owners are selling.
- **Accounts** (`#/account/<address>`): the handle an account shows, and
  the names it owns.

There is no log in: the page asks the wallet only where a key is needed,
and only from a click. Its wallet is Selfhold's window, at
`wallet.selfhold.app` ([selfhold-wallet](https://github.com/adalinxx/selfhold-wallet),
its client vendored as `app/vendor/selfhold.mjs`), so nothing needs
installing, phones included. Selfhold for Chrome is an option: Settings can
choose it, a checkout can pay with it, and whoever connected it here while
it was the default keeps it:

- **The window keeps the key.** Continue with Selfhold opens Selfhold's
  window over the page, as a payment window does. There a passkey makes the
  account, or brings back one made before: its key is derived through
  WebAuthn's PRF extension and kept by the passkey's provider, synced to the
  person's other devices. Moniker gets the address and each write's answer,
  never the key.
- **A write opens the window from its click**, while the page reads the
  chain and builds the write for the account it was given; the window shows
  it with its fee, asks the passkey, and signs only as that account.
- **Fees.** With a **fee sponsor** set, the window pays every fee in this
  device's work first: by default Moniker's sponsor, at
  `https://lattice-testnet-apps-iad.fly.dev:8650/sponsor`
  (0xLattice/lattice-sponsor), changed or turned off in Settings ("Pay fees
  with this device's GPU"). The checkout says only that this device's GPU
  pays it. Where the sponsor can't help, the account's coins pay the fee if
  it has them; if not, the page asks for coins, shows the account ID to send
  them to, and says why: the fee is usually paid with the GPU. How the window
  grinds the shares, and checks what the sponsor adds before signing, is in
  selfhold-wallet's README.
- Anyone who prefers an extension can still add Selfhold for Chrome from the
  account panel; back on the tab after adding it, the page reloads at the
  same place.

With Selfhold for Chrome, a write asks for no fee: it pays the fee the person
sets there for the chain (1 unit until they change it), so an account needs
coins to write unless its fee is 0.
It reads every record by CID from the hosts Nexus lists for `Nexus/moniker`,
found through Nexus's seeds (`seed1` to `seed4.lattice.build`), or from the
nodes named in Settings. A listed host is not verified: its Volumes are
checked by CID, but its tip is taken as it reports it. Settings saved for a
trial chain, or with the hosts once named by default, follow the move. Fonts ship in `app/fonts/` (SIL Open Font License).

```sh
python3 -m http.server 8765   # from the repository root, then open http://localhost:8765/app/
```

## Layout

- `rules/`: `lattice-policy-rules`, the parts Lattice policies share:
  reading the context and body, and the token rule.
- `policy/`: the Moniker policy, fixed at genesis. It and `rules/` are one
  Cargo workspace, so the module is built with paths relative to the
  repository: the same bytes wherever it is built, naming no machine.
- `chain/`: the chain spec, the built policy module it names, and
  `genesis.mjs`, the transactions the genesis carries.
- `sdk/`: [moniker-sdk](https://github.com/adalinxx/moniker-sdk), a
  submodule: the record code (`sdk/src/records/`), the library for apps, and
  the Lattice SDK bundle.
- `e2e/moniker.mjs`: names against a real node, launched as the launch is,
  with names claimed in the genesis; moniker-sdk included.
- `e2e/ui/`: the page in headless Chromium with Selfhold for Chrome, or with
  Selfhold's window (selfhold-wallet's `dist-web/`, served on `localhost`)
  and a virtual passkey authenticator.
- `index.html`, `CNAME`: the app on GitHub Pages at
  [app.moniker.bio](https://app.moniker.bio/), `app/` served from the root.

## Build and test

```
cd policy
cargo build --release --target wasm32-unknown-unknown
LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/policy.test.mjs test/properties.test.mjs
cd ..
LATTICE=<lattice-node>/.build/debug/lattice \
  LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/moniker.mjs
cd e2e/ui && npm install
LATTICE=<lattice-node>/.build/debug/lattice \
  LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js \
  LATTICE_WALLET=<selfhold>/dist LATTICE_WALLET_WEB=<selfhold>/dist-web npm test
```

`<selfhold>` is selfhold-wallet built with `npm run build` (Selfhold for
Chrome, `dist/`) and `npm run build:web` (Selfhold's window, `dist-web/`).

The UI tests run `lattice-sponsor` from beside `lattice` (lattice-node
builds both). Selfhold's window grinds its shares on the machine's graphics chip; on Linux
they give Chromium SwiftShader's, in software, for a machine with none.

After building the policy, copy the module to `chain/moniker_policy.wasm`
and put its CID (`policy/host-check/.build/debug/host-check <wasm> <dir>`
prints it) in `chain/spec.json` and `e2e/ui/spec.json`. To replay every
policy test context through Lattice's own host, run the policy tests with
`CONTEXT_DIR=<dir>`, then
`swift run --package-path policy/host-check host-check policy/target/wasm32-unknown-unknown/release/moniker_policy.wasm <dir>`.

`test/properties.test.mjs` judges random transactions, built from the
operations the app makes and then damaged at random, with the built module
and with `test/model.mjs`, the rules restated from the policy's
documentation; checks the safety properties directly on every transaction
the module accepts; and corrupts encoded bodies. `FUZZ_RUNS` sets how many
it tries (5000 by default); a failure prints the `FUZZ_SEED` that replays it.
With `CONTEXT_DIR` it records every context too, for host-check.

CI (`.github/workflows/test.yml`) runs all of the above and moniker-sdk's
tests on every pull request, against the Lattice node, SDK and Selfhold
commits pinned at the top of the workflow. It checks that
`chain/moniker_policy.wasm` is what the source builds and names no build
path, and replays every context the policy tests judged through host-check.

## Launch

The project's names are claimed in the genesis itself, so nobody can take
them first. From a `lattice key generate` key kept offline and a list of
handles, one per line:

```
LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js \
  node chain/genesis.mjs project-key.json names.txt Nexus/moniker > genesis.json
lattice child create Nexus/moniker --spec chain/spec.json \
  --policy-module chain/moniker_policy.wasm --premine-to <address> \
  --genesis-transactions genesis.json
```

Each name is claimed with its `names/` key and pointed at the project's
account, one claim per transaction. Every claim is checked against the policy
before it is written, and again by the node before the chain is created.
`--genesis-transactions` needs a node with 0xLattice/lattice-node#69.
