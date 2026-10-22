# Moniker

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="app/brand/moniker-lockup-dark.svg">
  <img src="app/brand/moniker-lockup-light.svg" alt="Moniker" width="393" height="100">
</picture>

Own your name on the internet. Moniker sells you an `@handle` that
belongs to you, not to an app: no company can take it back, rename it or
hand it to someone else, and only your key can change what it says. Any
app can know you by it.

One chain, Moniker (`Nexus/moniker`), holds every profile and every name.
Any app reads and writes it; no app keeps its own profile.

## Accounts, profiles and names

- An **account** is a key, kept in the person's wallet. It is never shown,
  only checked ("owned by …id"). It owns profiles and names.
- A **profile** is the public identity: a card (name, bio, photo, links), a
  default name, and admins. It is sold or given whole, with its card and
  followers; giving it to a new key of your own is how you recover from a
  lost key.
- A **name** (`@handle`) is an asset its account owns, like a domain. Its
  owner points it at any profile, sells it or gives it, on its own. A
  profile shows its default name only while that name points at it.

A record an app writes says which profile it is from, and the app shows that
profile's card.

## Records

| Key | Value | Who may write |
| --- | --- | --- |
| `profile/<p>` | `<owner>`, `<owner>@<price>` or `<owner>><account>` (offered to one account) | its owner; anyone buys at the price; the account it is offered to takes it |
| `about/<p>/card` | The card, JSON: `name`, `description`, `avatar` (CID), `header` (CID), `url` (strings) and `links` (`[{ label, url }]`, in order); all optional | the profile's owner |
| `about/<p>/name` | The profile's default name, shown while it points at the profile | the profile's owner |
| `about/<p>/admin/<a>` | `1` while account `<a>` may act as the profile in apps | the profile's owner |
| `name/<handle>` | `<owner>`, `<owner>@<price>` or `<owner>><account>` (offered to one account) | its owner, who may also release it; anyone buys at the price; the account it is offered to takes it |
| `points/<handle>` | The profile the name points at: any profile | the name's owner |
| `owns/<a>/<p>`, `names/<a>/<handle>` | `1`: an account's profiles and names, each in one read | only together with the token they index |
| `user/<a>/key.x25519`, `user/<a>/app.<name>.<field>` | An account's own keys and app data | `<a>` |

`<p>` is 16 random characters of `a`–`z` and `2`–`7`. The policy sees only a
transaction, so a write acting for a profile or a name rewrites its token to
the value it has: consensus checks every old value, and the policy reads the
owner from it. Nothing is put on an account without its signature, which is
why a gift is an offer the receiver takes.

A name may point at anyone's profile, so a profile shows a name only when it
also chooses it as its default: both sides agree. Selling a name moves only
the name; it keeps pointing where it did until its new owner points it.
Selling a profile moves its card and followers and clears its admins; names
stay with their owner.

The policy reads a transaction's actions once, in order, so checking costs
what the bytes do. Signers are looked up in a crit-bit tree. The SDK writes
this order; anyone writing transactions by hand follows it:

- A token (`profile/<p>`, `name/<handle>`), then the index keys it moves, the
  one it leaves first.
- `about/<p>/...` while `profile/<p>` is the last profile written.
- `points/<handle>` directly after `name/<handle>` and its index keys.
- A seller's purchases one after another, and sellers credited in the order
  they are first paid.

The card holds what a feed shows. A card may carry fields this list does not
name; clients keep them when they save. Display names are not unique. `url`
and every link are http or https addresses; clients show nothing else. Media
is a CID of a one-block Volume `{ type, bytes }` that the author pins; never a
URL.

A handle is lowercase letters, digits and `_`. The first to claim a free name
owns it. A buyer names the value they read, so if the price changed, the
purchase is refused.

## Use Moniker in your app

Other apps read and write Moniker through
[moniker-sdk](https://github.com/adalinxx/moniker-sdk): one import, no key
handling, writes signed in the person's Selfhold wallet.

```js
import { createMoniker, defineMonikerName } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.2.0/src/browser.mjs";
```

moniker-sdk is also where the record code lives (cards, fields, handles,
reading state, the wallet request). This repo holds it as the submodule `sdk/`,
pinned to a release; clone with `--recurse-submodules`, or run
`git submodule update --init`.

## The app

Logo masters, transparent PNG exports, and favicons live in [`app/brand/`](app/brand/).
See the [asset guide](app/brand/README.txt) for colors, spacing, and usage.

`app/` is a static page laid out like a domain registrar: a name search
whose results page shows the exact name (available at 0, for sale by its
owner at their price, or taken) and names close to it with their prices; a
checkout that is only the order (price, network fee, total, which of your
profiles it goes on, one approval; your first name makes your first profile
in the same approval); a Marketplace of listed names; each profile's page
(photo, name, `@handle` and its other names, bio, links, followers, owner);
and My profiles, where you edit a profile, show one of its names, sell, give,
move or release a name, sell or give a whole profile, and make a new one.
Edit also manages a profile's admins. A gift is an offer: the giver gets a
link to send, and the receiver takes it from there. There is no log in:
the page asks the wallet only where a key is needed, and only from a click, as
Selfhold requires: Your page, My profiles and Edit offer Connect Selfhold, and
checkout's Buy connects first. Without a wallet, the checkout still shows the order, with how to
add Selfhold in place of Buy; back on the tab after adding it, the page reloads
at the same checkout (Selfhold reaches only pages loaded after it), and on a
phone it offers the link to finish on a computer. The network fee is 0 on the trial chain (its hosts admit 0-fee
transactions), so a new account needs no coins to buy a name no one owns. It reads every
record by CID from the nodes in Settings (by default the shared testnet hosts
`lattice-testnet-apps-iad` and `-ams`, chain `Nexus/testnet/moniker-01c01f`)
and asks the Selfhold wallet extension to approve each write: a save is one
transaction, a buy pays the owner in the same one. Reading needs no wallet.
A photo is kept by your own node: set its URL and cookie in Settings (the node
must list the page's origin in `rpcAllowedOrigins`). Fonts ship in
`app/fonts/` (SIL Open Font License); the app reads and writes through
`sdk/src/records/` and the Lattice SDK bundle in `sdk/vendor/`.

```sh
python3 -m http.server 8765   # from the repository root, then open http://127.0.0.1:8765/app/
```

`e2e/ui/` runs the page in headless Chromium with the real Selfhold extension
(its `dist/`, built with `npm ci` then `npm run build`; tested with 0.4.2)
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
