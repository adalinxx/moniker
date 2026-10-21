// Moniker: one page per account, like a link page, read from the profile
// chain by CID and written through the Selfhold wallet, which asks the owner to
// approve every change. Reading needs no wallet.
import * as sdk from "../sdk/vendor/lattice-sdk.js";
import { mediaVolume, operator } from "../client/media.mjs";
import * as profile from "../sdk/src/records/profile.mjs";
import { anyHost, tip, view, volumeLoader } from "../sdk/src/records/state.mjs";
import { writeRequest } from "../sdk/src/records/wallet.mjs";
import { createFollows } from "../follows/src/index.mjs";
import { defineFollowButton } from "../follows/src/element.mjs";

// ---------------------------------------------------------------- settings

const DEFAULTS = {
  nodes: ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"],
  chain: "Nexus/testnet/moniker-da6f57",
  // Follows, the follow graph every app shares: who follows a name or an account.
  follows: "Nexus/testnet/follows-6ed91a",
  // Your own node, for keeping photos: its URL and the cookie it writes at start.
  ownNode: "",
  ownCookie: "",
};
function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("moniker.settings") ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}
let settings = loadSettings();
function saveSettings(next) {
  settings = { ...DEFAULTS, ...next };
  try {
    localStorage.setItem("moniker.settings", JSON.stringify(settings));
  } catch {}
  reader = null;
  graph = null;
}
const chainPath = () => settings.chain.split("/").filter(Boolean);
// Writes are free on the trial chain: its hosts admit 0-fee transactions.
const FEE = 0n;
// Where a newcomer gets Selfhold, the wallet for Lattice (once named Lattice Wallet).
const WALLET_URL = "https://chromewebstore.google.com/detail/amcobhbipbblfjonmoiicihhfglkhpce";
// Selfhold is a desktop Chromium extension: phones and other browsers can't add it.
const phone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const chromium = Boolean(navigator.userAgentData?.brands?.some((b) => /Chromium/.test(b.brand)));

// ---------------------------------------------------------------- reading

let reader = null;
function getReader() {
  if (!reader) {
    const transport = anyHost(settings.nodes.map((node) => new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: chainPath() })));
    const volumes = new sdk.VolumeClient(transport);
    reader = { volumes, load: volumeLoader(volumes, sdk.decodeDagCbor) };
  }
  return reader;
}

let graph = null;
function getGraph() {
  if (!graph) graph = createFollows({ sdk, nodes: settings.nodes, chain: settings.follows.split("/").filter(Boolean), freshFor: 5000 });
  return graph;
}
// The Follow button reads and writes through whichever graph the settings name now.
defineFollowButton(new Proxy({}, { get: (_, method) => (...args) => getGraph()[method](...args) }), { walletURL: WALLET_URL });

/** The chain's state at the tip of the first node that answers. */
async function readState() {
  const { volumes, load } = getReader();
  let failure;
  for (const node of settings.nodes) {
    try {
      const { generalStateCID } = await tip(sdk, node, chainPath(), volumes);
      return view(load, generalStateCID);
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(`No node is serving ${settings.chain} right now.`, { cause: failure });
}

/**
 * The account's balance on this chain, as a node says, or undefined if none
 * answers. Only to inform: the wallet decides how a buy is paid, and may
 * bring coins in a way this page can't see.
 */
async function balanceOf(address) {
  for (const node of settings.nodes) {
    try {
      const response = await fetch(`${node}/api/state/account/${address}?chainPath=${encodeURIComponent(settings.chain)}`, { cache: "no-store" });
      if (response.ok) return BigInt((await response.json()).balance ?? 0);
    } catch {}
  }
  return undefined;
}

// Photos, once per CID: content-addressed, so they never change.
const MEDIA_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;
const photos = new Map();
function photo(cid) {
  if (!photos.has(cid)) {
    photos.set(
      cid,
      (async () => {
        const volume = await getReader().volumes.get(cid);
        const file = sdk.decodeDagCbor(volume.bytes(cid));
        if (typeof file?.type !== "string" || !MEDIA_TYPES.test(file.type) || !(file.bytes instanceof Uint8Array)) return null;
        return URL.createObjectURL(new Blob([file.bytes], { type: file.type }));
      })().catch(() => {
        setTimeout(() => photos.delete(cid), 60_000);
        return null;
      }),
    );
  }
  return photos.get(cid);
}

// ---------------------------------------------------------------- wallet

let connected = null;
const wallet = () => window.lattice ?? null;

/** Asks Selfhold for this site's address. It answers only within a click or key press, so call it before any other wait. */
async function connect() {
  if (!wallet()) throw new Error("This needs the Selfhold wallet.");
  connected = await wallet().connect();
  return connected;
}

function walletMessage(error) {
  const text = String(error?.message ?? error);
  if (/just declined|ask again in a moment/i.test(text)) return "The wallet waits a few seconds after a decline. Try again in a moment.";
  if (/declined|rejected|denied/i.test(text)) return "You declined it in the wallet. Nothing was sent.";
  if (/locked/i.test(text)) return "Unlock Selfhold, then try again.";
  return text;
}

// The wallet takes one request from a page at a time.
let walletTurn = Promise.resolve();
function send(write) {
  const turn = walletTurn.then(async () => {
    // A write is built for the account this page shows. If Selfhold was since
    // disconnected from this site, or connected to another account, say so and send nothing.
    const now = await wallet().address();
    if (now !== connected) {
      connected = now;
      render();
      throw new Error(now ? "Selfhold now connects this site to a different account. Look again, then try again." : "Selfhold isn't connected to this site anymore. Connect again, then try again.");
    }
    return wallet().writeRecords(writeRequest(chainPath(), write, FEE));
  });
  walletTurn = turn.catch(() => {});
  return turn;
}

/**
 * Sends a write, then waits until the chain shows it (`landed(state)`), so
 * the page redraws from what the chain holds, not from what was asked.
 */
async function act(label, build, landed, done = render) {
  const progress = toast(`${label}: approve it in your wallet.`);
  try {
    await send(await build());
    progress.update(`${label}: waiting for the block…`);
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      try {
        if (await landed(await readState())) break;
      } catch {}
      if (Date.now() > deadline) throw new Error("Sent, but no block has shown it yet. It may still land.");
    }
    progress.update(`${label}: done.`);
    setTimeout(progress.close, 2500);
    done();
  } catch (error) {
    progress.update(walletMessage(error), { bad: true });
  }
}

// ---------------------------------------------------------------- helpers

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (address) => `${address.slice(0, 7)}…${address.slice(-5)}`;
const initial = (p) => (p.name?.trim()?.[0] ?? p.handle?.[0] ?? "?").toUpperCase();
const hostOf = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};
const coins = (amount) => `${amount.toLocaleString("en-US")}`;

function toast(message, { bad = false } = {}) {
  const box = document.createElement("div");
  box.className = `toast${bad ? " bad" : ""}`;
  box.setAttribute("role", bad ? "alert" : "status");
  const text = document.createElement("span");
  text.textContent = message;
  const close = Object.assign(document.createElement("button"), { type: "button", textContent: "×" });
  close.setAttribute("aria-label", "Dismiss");
  close.onclick = () => box.remove();
  box.append(text, close);
  $("#toasts").replaceChildren(box);
  return {
    update(next, options = {}) {
      text.textContent = next;
      box.classList.toggle("bad", Boolean(options.bad));
      box.setAttribute("role", options.bad ? "alert" : "status");
    },
    close: () => box.remove(),
  };
}

/**
 * A confirmation sheet. `rows` are `[label, value]` lines; `input` asks for
 * one value first. Resolves to the input's value (or true), or null when
 * cancelled.
 */
function sheet({ title, body, rows = [], confirm, input }) {
  const dialog = $("#sheet");
  dialog.innerHTML = `
    <form method="dialog">
      <h2 id="sheet-title">${esc(title)}</h2>
      <p>${esc(body)}</p>
      ${input ? `<div class="field"><label for="sheet-input">${esc(input.label)}</label><input id="sheet-input" ${input.attrs ?? ""} required></div>` : ""}
      ${rows.length ? `<div class="sum">${rows.map(([k, v]) => `<span class="label">${esc(k)}</span><span>${esc(v)}</span>`).join("")}</div>` : ""}
      <p id="sheet-error" role="alert" style="color: var(--bad); margin: 0 0 12px"></p>
      <div class="actions">
        <button class="pill" value="cancel" type="submit" formnovalidate>Cancel</button>
        <button class="pill dark" value="ok" type="submit">${esc(confirm)}</button>
      </div>
    </form>`;
  return new Promise((resolve) => {
    const form = $("form", dialog);
    form.onsubmit = (event) => {
      if (event.submitter?.value !== "ok") return;
      if (input?.check) {
        const problem = input.check($("#sheet-input").value.trim());
        if (problem) {
          event.preventDefault();
          $("#sheet-error").textContent = problem;
          return;
        }
      }
    };
    dialog.onclose = () => resolve(dialog.returnValue === "ok" ? (input ? $("#sheet-input").value.trim() : true) : null);
    dialog.returnValue = "";
    dialog.showModal();
  });
}

const brandAsset = (name) => new URL(`./brand/${name}`, import.meta.url).href;
const header = () => `
  <header class="col brand-header">
    <a class="brand-home" href="#/" aria-label="Moniker home">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="${brandAsset("moniker-lockup-dark.svg")}">
        <img src="${brandAsset("moniker-lockup-light.svg")}" alt="Moniker" width="393" height="100">
      </picture>
    </a>
    <nav class="top-nav" aria-label="Moniker">
      <a href="#/market">Marketplace</a>
      <a class="pill" href="#/names">My names</a>
    </nav>
  </header>`;

const footer = () => `
  <footer class="col">
    <nav aria-label="More"><a href="#/settings">Settings</a></nav>
  </footer>`;

// ---------------------------------------------------------------- views

/**
 * Who follows `target` (a @name or an address) and whom `holder` follows,
 * each count opening its list, and the Follow button: on a name's page it
 * follows the name, on an account's page the account. Not on your own page.
 */
async function followsBlock(target, holder, mine, label) {
  return `
    <div class="follows">
      <p class="counts" data-target="${esc(target)}" data-holder="${esc(holder)}">${await countLinks(target, holder)}</p>
      ${mine ? "" : `<follows-button target="${esc(target)}" label="${esc(label)}" owner="${esc(holder)}"></follows-button>`}
    </div>`;
}

/** "N followers" and "N following", each opening its list. */
async function countLinks(target, holder) {
  const [followers, following] = await Promise.all([getGraph().followers(target), holder ? getGraph().following(holder) : []]);
  const many = (n, one, other) => `<strong>${n.toLocaleString("en-US")}</strong> ${n === 1 ? one : other}`;
  return `
    <a href="#/${esc(target)}/followers">${many(followers.length, "follower", "followers")}</a>
    <a href="#/${esc(target)}/following">${many(following.length, "following", "following")}</a>`;
}

/**
 * An account's page, reached by its address (or Your page), or a name's
 * page, reached by `@handle`: the same card, but a name's page is about the
 * name (its followers, Follow the name) and an account's about the account
 * (every name it owns, its followers, Follow the account).
 */
async function viewProfile(address, state, handle) {
  const p = await profile.getProfile(state, address);
  const mine = connected === address;
  const target = handle ? `@${handle}` : address;
  const [held, follows] = await Promise.all([handle ? [] : profile.heldBy(state, address), followsBlock(target, address, mine, p.name ?? (handle ? `@${handle}` : "this account"))]);
  const links = [...(p.url ? [{ label: hostOf(p.url), url: p.url }] : []), ...(p.links ?? [])];
  const empty = !p.name && !p.description && links.length === 0 && !p.avatar;
  const link = `${location.origin}${location.pathname}#/${p.handle ? `@${p.handle}` : address}`;
  return `
    <div class="col top">${mine ? `<a class="pill" href="#/edit">Edit</a>` : ""}</div>
    <main class="col card">
      ${p.avatar ? `<img class="avatar" data-photo="${esc(p.avatar)}" alt="">` : `<div class="avatar" aria-hidden="true">${esc(initial(p))}</div>`}
      <h1>${esc(p.name ?? short(address))}</h1>
      ${handle
        ? `<p class="handle">@${esc(handle)}</p>`
        : held.length
          ? `<nav class="names" aria-label="Names this account owns">${held.map((h) => `<a class="handle" href="#/@${esc(h.handle)}">@${esc(h.handle)}</a>`).join("")}</nav>`
          : ""}
      ${p.description ? `<p class="bio">${esc(p.description)}</p>` : ""}
      ${follows}
      ${handle ? `<a class="owner" href="#/${esc(address)}">${mine ? "Your account" : "Owner's page"}</a>` : ""}
      ${links.length ? `<nav class="links" aria-label="Links">${links.map((l) => `<a href="${esc(l.url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(l.label)}</a>`).join("")}</nav>` : ""}
      ${empty ? `<p class="empty">${mine ? `Nothing here yet. <a href="#/edit">Make your page</a>.` : "This account hasn't made a page yet."}</p>` : ""}
      ${mine
        ? `<button class="copy" type="button" data-copy="${esc(link)}" style="margin-top: 24px">Copy your link ⧉</button>`
        : handle ? "" : `<button class="copy" type="button" data-copy="${esc(`${location.origin}${location.pathname}#/${address}`)}" style="margin-top: 24px">Copy account link ⧉</button>`}
    </main>`;
}

/** One person in a list: their photo, name and @handle, linked to their page. */
function personRow(p, href, sub) {
  return `
    <a class="row person" href="${esc(href)}">
      ${p.avatar ? `<img class="avatar sm" data-photo="${esc(p.avatar)}" alt="">` : `<span class="avatar sm" aria-hidden="true">${esc(initial(p))}</span>`}
      <span class="who"><strong>${esc(p.name ?? (p.handle ? `@${p.handle}` : "Unnamed account"))}</strong>${sub ? `<span class="label">${esc(sub)}</span>` : ""}</span>
    </a>`;
}

/** Who follows `who` (a @name or an address), or what its account follows. */
async function viewFollowList(who, tab, state) {
  const handle = who.startsWith("@") ? who.slice(1) : null;
  const holder = handle ? (await profile.resolve(state, handle))?.holder : who;
  let rows;
  if (tab === "followers") {
    const cards = await profile.getProfiles(state, await getGraph().followers(who));
    rows = cards.map((p) => personRow(p, `#/${p.handle ? `@${p.handle}` : p.address}`, p.handle ? `@${p.handle}` : ""));
  } else {
    // Names, as whoever owns them now; accounts, marked as such.
    const followed = holder ? await getGraph().following(holder) : [];
    rows = await Promise.all(
      followed.map(async (t) => {
        if (!t.startsWith("@")) {
          const p = await profile.getProfile(state, t);
          return personRow(p, `#/${t}`, p.handle ? `@${p.handle} · account` : "Account");
        }
        const owner = (await profile.resolve(state, t.slice(1)))?.holder;
        const p = owner ? await profile.getProfile(state, owner) : {};
        return personRow({ ...p, handle: t.slice(1) }, `#/${t}`, owner ? t : "No one owns it yet");
      }),
    );
  }
  const whose = handle ? who : (await profile.getProfile(state, who)).name ?? "This account";
  const empty = tab === "followers" ? "No followers yet." : holder ? "Not following anyone yet." : `No one owns ${who} yet.`;
  return `
    ${backBar(`#/${esc(who)}`, "Back")}
    <main class="col stack">
      <h1 style="margin: 0">${esc(tab === "followers" ? `${whose}'s followers` : `${whose} follows`)}</h1>
      ${rows.length ? rows.join("") : `<p class="empty">${empty}</p>`}
    </main>`;
}

/** What someone typed, as a handle: lowercase, without `@` or spaces. */
const asHandle = (typed) => typed.trim().replace(/^@/, "").replace(/\s+/g, "").toLowerCase();

const searchBox = (value = "") => `
  <form class="box" id="search" role="search">
    <label for="q" class="sr">Search for a name</label>
    <span class="mono" aria-hidden="true" style="color: var(--muted)">@</span>
    <input id="q" value="${esc(value)}" placeholder="yourname" autocomplete="off" spellcheck="false" autocapitalize="none" enterkeyhint="search">
    <button class="pill accent" type="submit">Search</button>
  </form>`;

/** The front door: search for a name, as on a domain registrar. */
function viewStart(message = "") {
  return `
    <main class="col start">
      <h1 class="hero">Own your name on the internet.</h1>
      <p class="lede">An @handle that belongs to you, not to an app. Any app can know you by it.</p>
      <div class="stack" style="margin-top: 24px">
        ${searchBox()}
        <p class="note" id="search-note" aria-live="polite">${esc(message) || "Lowercase letters, digits and _."}</p>
      </div>
      <ul class="promises">
        <li><b>Yours to keep.</b> No company can take it back, rename it or hand it to someone else. No renewals.</li>
        <li><b>Proof it's you.</b> Only your key can change what your name says, so an app showing your @handle is showing you.</li>
        <li><b>One name everywhere.</b> Set it up once, and any app can show your name, photo and links.</li>
      </ul>
    </main>`;
}

/** Names close to `q` to offer next to it, as a registrar does. */
function variants(q) {
  const year = new Date().getFullYear();
  return [`${q}_`, `the${q}`, `${q}hq`, `its${q}`, `real${q}`, `${q}${year}`, `hey${q}`, `${q}_1`, `${q}online`]
    .filter((h) => h !== q && profile.isHandle(h));
}

/** One handle's standing: available (0), for sale (its price), yours, or taken. */
function standing(handle, entry) {
  if (!entry) return { handle, kind: "available", price: 0n };
  if (entry.holder === connected) return { handle, kind: "yours" };
  if (entry.price !== undefined) return { handle, kind: "sale", price: entry.price };
  return { handle, kind: "taken" };
}

const buyLink = (r, cls = "pill accent") => `<a class="${cls}" href="#/buy/${esc(r.handle)}" aria-label="Buy @${esc(r.handle)} for ${coins(r.price)}">Buy</a>`;

function resultRow(r) {
  const tail = {
    available: `<span class="price">${coins(r.price)}</span>${buyLink(r)}`,
    sale: `<span class="label">for sale by its owner</span><span class="price">${coins(r.price)}</span>${buyLink(r, "pill dark")}`,
    yours: `<span class="label">yours</span><a class="pill" href="#/names">My names</a>`,
    taken: `<span class="label">taken</span><a class="pill" href="#/@${esc(r.handle)}">See page</a>`,
  }[r.kind];
  return `<div class="row"><span class="mono">@${esc(r.handle)}</span><div class="end">${tail}</div></div>`;
}

/** Search results: the exact name first, then names close to it. */
async function viewSearch(q, state) {
  const [exact, ...near] = await Promise.all([q, ...variants(q)].map(async (h) => standing(h, await profile.resolve(state, h))));
  const listed = (await profile.forSale(state))
    .filter((h) => h.handle !== q && h.handle.includes(q) && h.holder !== connected)
    .map((h) => ({ handle: h.handle, kind: "sale", price: h.price }));
  const more = [...near.filter((r) => r.kind === "available"), ...listed].slice(0, 6);
  const headline = {
    available: ["Available", "No one owns it yet, so it costs 0."],
    sale: ["For sale", "Its owner is selling it. You pay them directly, in the same transaction."],
    yours: ["Yours", "You own this name."],
    taken: ["Taken", "Someone owns it and isn't selling it. Try one of the names below."],
  }[exact.kind];
  return `
    <div class="col">${searchBox(q)}</div>
    <main class="col">
      <section class="result ${exact.kind}" aria-labelledby="exact">
        <span class="badge">${headline[0]}</span>
        <h1 id="exact" class="mono">@${esc(q)}</h1>
        <p class="lede">${headline[1]}</p>
        <div class="result-end">
          ${exact.kind === "available" || exact.kind === "sale"
            ? `<span class="price big">${coins(exact.price)}</span><a class="pill accent" href="#/buy/${esc(q)}">Buy @${esc(q)}</a>`
            : exact.kind === "yours"
              ? `<a class="pill" href="#/names">Go to My names</a>`
              : `<a class="pill" href="#/@${esc(q)}">See @${esc(q)}'s page</a>`}
        </div>
      </section>
      ${more.length ? `
      <section class="section stack" aria-labelledby="more">
        <h2 id="more">More names</h2>
        ${more.map(resultRow).join("")}
      </section>` : ""}
    </main>`;
}

const backBar = (href, label) => `
  <div class="col top" style="justify-content: flex-start; align-items: center; gap: 12px">
    <a class="pill icon" href="${href}" aria-label="Back">‹</a>
    <span class="label">${label}</span>
  </div>`;

// Set once someone leaves for the wallet's store page; on their return the
// page reloads (Selfhold reaches only pages loaded after it was added), on the
// same address, so they carry on where they were.
const AWAITING = "moniker.awaitingWallet";
const awaiting = (on) => {
  try {
    if (on === undefined) return sessionStorage.getItem(AWAITING) === "1";
    if (on) sessionStorage.setItem(AWAITING, "1");
    else sessionStorage.removeItem(AWAITING);
  } catch {}
  return false;
};

/** Where a key is needed and there is no wallet: what it is, and how to get one. */
function walletPanel(why) {
  const steps = phone ? "" : `
    <ol class="steps">
      <li>Add Selfhold to your browser. It's free.</li>
      <li>Create your key in it: about a minute.</li>
      <li>Come back to this tab. Moniker picks up right here.</li>
    </ol>
    <a class="pill accent big" href="${WALLET_URL}" target="_blank" rel="noopener" data-get-wallet>Add Selfhold${chromium ? " to your browser" : " for Chrome"}</a>
    ${chromium ? "" : `<p class="note" style="margin: 0">Selfhold runs in Chrome, Brave, Edge and Arc.</p>`}
    <p class="note" id="wallet-wait" aria-live="polite" style="margin: 0"${awaiting() ? "" : " hidden"}>Waiting for Selfhold… When it's set up, come back to this tab.</p>`;
  const elsewhere = phone ? `
    <p style="margin: 0">Selfhold runs in a computer's browser, so finish this on a computer: open this page there.</p>
    <button class="pill accent big" type="button" data-share="${esc(location.href)}">Copy this page's link</button>` : "";
  return `
    <section class="panel stack" aria-labelledby="get-wallet">
      <h2 id="get-wallet">${why}</h2>
      <p class="lede" style="margin: 0">Selfhold is a wallet in your browser. It keeps the key that proves a name is yours, on your device, and asks you before anything is sent. Moniker never sees it.</p>
      ${steps}${elsewhere}
    </section>`;
}

/** Where a key is needed, Selfhold is here, and this site isn't connected yet: one click asks it. */
function connectPanel(why) {
  return `
    <section class="panel stack" aria-labelledby="connect">
      <h2 id="connect">${why}</h2>
      <p class="lede" style="margin: 0">Selfhold asks you first. Moniker sees only your address, never your key.</p>
      <button class="pill accent big" type="button" data-connect>Connect Selfhold</button>
    </section>`;
}

/**
 * Checkout: only the order. A handle no one owns costs 0, a listed one its
 * asking price, paid to its owner.
 */
async function viewBuy(handle, state) {
  const entry = await profile.resolve(state, handle);
  if (connected && entry?.holder === connected) return viewBought(handle, state);
  if (entry && entry.price === undefined) return viewStart(`@${handle} was just taken and is not for sale.`);
  const price = entry?.price ?? 0n;
  const ready = Boolean(wallet()); // Buy connects first if this site isn't connected yet
  // Short on this chain: said here; whether and how to pay is the wallet's to decide.
  const balance = connected && price + FEE > 0n ? await balanceOf(connected) : undefined;
  const short = balance !== undefined && balance < price + FEE;
  return `
    ${backBar(`#/search/${esc(handle)}`, "Back to results")}
    <main class="col stack" style="margin-top: 12px">
      <h1 style="margin: 0">Checkout</h1>
      <form id="buy" class="panel stack" data-handle="${esc(handle)}" data-price="${price}">
        <p class="mono order">@${esc(handle)}</p>
        <div class="sum" style="margin: 0">
          <span class="label">Price · ${entry ? "paid to its owner" : "no one owns it yet"}</span><span>${coins(price)}</span>
          <span class="label">Network fee</span><span>${coins(FEE)}</span>
          <span style="font-weight: 600">Total</span><span style="font-weight: 600">${coins(price + FEE)}</span>
        </div>
        <p class="note" style="margin: 0">Yours until you sell it or give it away. No renewals.${entry ? " If the owner changes the price before it lands, nothing is taken." : ""}</p>
        ${short ? `<p class="note" id="short" style="margin: 0">This costs ${coins(price + FEE)}. Your account has ${coins(balance)} on this chain.</p>` : ""}
        ${ready ? `<button class="pill accent big" type="submit">Buy for ${coins(price + FEE)}</button>` : ""}
      </form>
      ${ready ? "" : walletPanel(`To buy @${esc(handle)}, add Selfhold`)}
    </main>`;
}

/** Just bought: say so, then the next step. */
async function viewBought(handle, state) {
  const p = await profile.getProfile(state, connected);
  return `
    <main class="col card" style="margin-top: 48px">
      <span class="badge">Bought</span>
      <h1 class="mono">@${esc(handle)} is yours</h1>
      <p class="bio">It stays yours until you sell it or give it away. Any app can now know you by it.</p>
      <div class="stack" style="width: 100%; margin-top: 28px">
        ${p.name
          ? `<a class="pill accent big" href="#/me">View your page</a>`
          : `<a class="pill accent big" href="#/edit">Set up your page</a>`}
        <a class="pill big" href="#/names">Go to My names</a>
      </div>
    </main>`;
}

async function viewEdit(state) {
  const p = await profile.getProfile(state, connected);
  const held = await profile.heldBy(state, connected);
  // Links and photo being edited survive a redraw until saved.
  draft = draft?.address === connected ? draft : { address: connected, links: [...(p.links ?? [])], avatar: p.avatar };
  return `
    <div class="col top" style="justify-content: space-between; align-items: center">
      <a class="pill icon" href="#/me" aria-label="Back to your page">‹</a>
      <a class="pill" href="#/names">My names</a>
    </div>
    <main class="col stack" style="margin-top: 12px">
      <h1 style="margin: 0">Edit your page</h1>
      <form id="edit" class="stack">
        <section class="panel stack" aria-label="About you">
          <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap">
            ${draft.avatar ? `<img class="avatar small" data-photo="${esc(draft.avatar)}" alt="Your photo">` : `<div class="avatar small" aria-hidden="true">${esc(initial(p))}</div>`}
            <div class="stack" style="gap: 6px">
              <label class="pill" for="photo" style="width: fit-content">Change photo</label>
              <input id="photo" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" class="sr">
              ${draft.avatar ? `<button class="quiet" type="button" data-remove-photo style="border: 0; background: none; text-align: left; padding: 0">Remove photo</button>` : ""}
            </div>
          </div>
          <div class="field"><label for="name">Name</label><input id="name" value="${esc(p.name ?? "")}" autocomplete="name"></div>
          <div class="field"><label for="bio">Bio</label><textarea id="bio" rows="3">${esc(p.description ?? "")}</textarea></div>
          <div class="field">
            <label for="handle">Handle on your page</label>
            <select id="handle">
              <option value="">None</option>
              ${held.map((h) => `<option value="${esc(h.handle)}"${h.handle === p.handle ? " selected" : ""}>@${esc(h.handle)}</option>`).join("")}
            </select>
            <span class="label">Only handles you hold. <a href="#/">Buy one</a></span>
          </div>
          <div class="field"><label for="url">Website</label><input id="url" type="url" inputmode="url" value="${esc(p.url ?? "")}" placeholder="https://"></div>
        </section>
        <button class="pill accent" type="button" data-add-link style="min-height: 52px">+ Add link</button>
        <div id="links" class="stack">${draft.links.map((l, i) => linkRow(l, i)).join("")}</div>
        <div class="bar">
          <span class="label">One change, approved in your wallet.</span>
          <div class="end"><button class="pill dark" type="submit">Save</button></div>
        </div>
      </form>
    </main>`;
}
let draft = null;

const linkRow = (link, i) => `
  <div class="panel link-row" data-link="${i}" style="padding: 12px 12px 12px 16px">
    <div class="inputs">
      <label class="sr" for="label-${i}">Link ${i + 1} title</label>
      <input id="label-${i}" data-field="label" value="${esc(link.label)}" placeholder="Title">
      <label class="sr" for="addr-${i}">Link ${i + 1} address</label>
      <input id="addr-${i}" data-field="url" type="url" inputmode="url" value="${esc(link.url)}" placeholder="https://">
    </div>
    <div class="tools">
      <button class="pill icon" type="button" data-move="-1" aria-label="Move link ${i + 1} up">↑</button>
      <button class="pill icon" type="button" data-move="1" aria-label="Move link ${i + 1} down">↓</button>
      <button class="pill icon" type="button" data-delete aria-label="Delete link ${i + 1}">×</button>
    </div>
  </div>`;

/** My names: every handle you own, and what you can do with each. */
async function viewNames(state) {
  const mine = await profile.heldBy(state, connected);
  const shown = (await profile.getProfile(state, connected)).handle;
  return `
    <main class="col" style="margin-top: 12px">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap">
        <h1 style="margin: 0">My names</h1>
        <div style="display: flex; gap: 8px"><a class="pill" href="#/me">Your page</a><a class="pill" href="#/edit">Edit page</a></div>
      </div>
      <section class="section stack" aria-label="Names you own">
        ${mine.length ? mine.map((h) => `
          <div class="row">
            <span class="mono">@${esc(h.handle)}</span>
            <span class="label">${h.handle === shown ? "on your page" : ""}${h.price !== undefined ? `${h.handle === shown ? " · " : ""}for sale · ${coins(h.price)}` : ""}</span>
            <div class="end">
              ${h.handle === shown ? "" : `<button class="pill" type="button" data-use="${esc(h.handle)}">Use on page</button>`}
              ${h.price !== undefined
                ? `<button class="pill" type="button" data-unlist="${esc(h.handle)}">Stop selling</button>`
                : `<button class="pill" type="button" data-list="${esc(h.handle)}">Sell</button>`}
              <button class="pill" type="button" data-give="${esc(h.handle)}">Give</button>
              <button class="pill" type="button" data-release="${esc(h.handle)}">Release</button>
            </div>
          </div>`).join("") : `<p class="note">You don't own a name yet. <a href="#/">Search for one</a>.</p>`}
      </section>
    </main>`;
}

/** The marketplace: names their owners are selling. */
async function viewMarket(state) {
  const sale = await profile.forSale(state);
  return `
    <main class="col" style="margin-top: 12px">
      <h1 style="margin: 0">Marketplace</h1>
      <p class="lede" style="margin-top: 8px">Names their owners are selling. You pay the owner directly, in the same transaction.</p>
      <section class="section stack" aria-label="For sale">
        ${sale.map((h) => `
          <div class="row">
            <span class="mono">@${esc(h.handle)}</span>
            <div class="end">${h.holder === connected
              ? `<span class="label">yours · ${coins(h.price)}</span>`
              : `<span class="price">${coins(h.price)}</span><a class="pill dark" href="#/buy/${esc(h.handle)}" aria-label="Buy @${esc(h.handle)} for ${coins(h.price)}">Buy</a>`}</div>
          </div>`).join("") || `<p class="note">Nothing for sale right now. <a href="#/">Search for a name</a>: one no one owns costs 0.</p>`}
      </section>
    </main>`;
}

function viewSettings() {
  return `
    <div class="col top" style="justify-content: flex-start"><a class="pill icon" href="#/" aria-label="Back">‹</a></div>
    <main class="col" style="margin-top: 12px">
      <h1 style="margin: 0 0 20px">Settings</h1>
      <form id="settings" class="panel stack">
        <div class="field"><label for="s-nodes">Nodes to read from, one per line</label><textarea id="s-nodes" rows="3">${esc(settings.nodes.join("\n"))}</textarea></div>
        <div class="field"><label for="s-chain">Profile chain</label><input id="s-chain" class="mono" value="${esc(settings.chain)}"></div>
        <div class="field"><label for="s-follows">Follows chain</label><input id="s-follows" class="mono" value="${esc(settings.follows)}"></div>
        <div class="field"><label for="s-own">Your own node, for keeping your photo</label><input id="s-own" type="url" value="${esc(settings.ownNode)}" placeholder="http://127.0.0.1:8080"></div>
        <div class="field"><label for="s-cookie">Its cookie (the .cookie file it writes at start)</label><input id="s-cookie" type="password" value="${esc(settings.ownCookie)}" autocomplete="off"></div>
        <p class="label" style="margin: 0">A photo is kept by whoever pins it. Your node must allow this page's origin (rpcAllowedOrigins).</p>
        <div style="display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap">
          <button class="pill" type="button" data-reset>Defaults</button>
          <button class="pill dark" type="submit">Save</button>
        </div>
      </form>
    </main>`;
}

// ---------------------------------------------------------------- routing

const route = () => decodeURIComponent(location.hash.replace(/^#\/?/, ""));
let drawing = 0;

async function render() {
  const ticket = ++drawing;
  const r = route();
  const app = $("#app");
  try {
    let html;
    if (r === "settings") html = viewSettings();
    else {
      // Selfhold connects only within a click, so ask now, before the read, if this render came from one.
      const needs = r === "edit" || r === "me" || r === "names";
      if (needs && !connected && wallet() && navigator.userActivation?.isActive) await connect();
      const state = await readState();
      // Your key is asked for only where it is needed.
      const [page, arg = ""] = r.split(/\/(.*)/s);
      if ((r === "edit" || r === "me" || r === "names") && !wallet()) {
        html = `<main class="col stack" style="margin-top: 24px">${walletPanel(r === "names" ? "Your names live in your wallet" : "Your page belongs to your wallet's key")}</main>`;
      } else if (needs && !connected) {
        html = `<main class="col stack" style="margin-top: 24px">${connectPanel(r === "names" ? "Your names live in your wallet" : "Your page belongs to your wallet's key")}</main>`;
      } else if (needs) {
        html = r === "edit" ? await viewEdit(state) : r === "me" ? await viewProfile(connected, state, (await profile.getProfile(state, connected)).handle) : await viewNames(state);
      } else if (r === "market") html = await viewMarket(state);
      else if (page === "search") {
        const q = asHandle(arg);
        html = profile.isHandle(q) ? await viewSearch(q, state) : viewStart(q ? `“${arg}”: a name is lowercase letters, digits and _.` : "");
      } else if (page === "buy" && profile.isHandle(arg)) {
        html = await viewBuy(arg, state);
      } else if (page === "bought" && connected && profile.isHandle(arg)) html = await viewBought(arg, state);
      else if (/^@[a-z0-9_]+\/(followers|following)$/.test(r) || /^[a-z2-7]{59}\/(followers|following)$/.test(r) && profile.isAddress(page)) {
        html = await viewFollowList(page, arg, state);
      } else if (r.startsWith("@")) {
        const entry = await profile.resolve(state, r.slice(1));
        html = entry ? await viewProfile(entry.holder, state, r.slice(1)) : profile.isHandle(r.slice(1)) ? await viewSearch(r.slice(1), state) : viewStart(`No one holds ${r}.`);
      } else if (profile.isAddress(r)) html = await viewProfile(r, state);
      else if (r === "") html = viewStart();
      else html = viewStart(`“${r}” is not a handle or an address.`);
    }
    if (ticket !== drawing) return;
    app.innerHTML = header() + html + footer();
    for (const img of app.querySelectorAll("[data-photo]")) {
      photo(img.dataset.photo).then((url) => {
        if (url) img.src = url;
      });
    }
  } catch (error) {
    if (ticket !== drawing) return;
    app.innerHTML = `<main class="col"><p class="empty">${esc(walletMessage(error))}</p><p style="text-align: center"><button class="pill" type="button" data-retry>Try again</button> <a class="pill" href="#/settings">Settings</a></p></main>${footer()}`;
  }
}

// ---------------------------------------------------------------- events

function readDraftLinks() {
  return [...document.querySelectorAll("[data-link]")].map((row) => ({
    label: $('[data-field="label"]', row).value.trim(),
    url: $('[data-field="url"]', row).value.trim(),
  }));
}
function redrawLinks() {
  $("#links").innerHTML = draft.links.map((l, i) => linkRow(l, i)).join("");
}

document.addEventListener("click", async (event) => {
  const el = event.target.closest("button, a");
  if (!el) return;
  const d = el.dataset;
  if ("retry" in d) {
    render();
  } else if ("connect" in d) {
    try {
      await connect();
      render();
    } catch (error) {
      toast(walletMessage(error), { bad: true });
    }
  } else if ("getWallet" in d) {
    awaiting(true);
    $("#wallet-wait")?.removeAttribute("hidden");
  } else if (d.share) {
    if (navigator.share) navigator.share({ title: "Moniker", url: d.share }).catch(() => {});
    else navigator.clipboard?.writeText(d.share).then(() => toast("Link copied. Open it on a computer."), () => toast(d.share));
  } else if (d.copy) {
    navigator.clipboard?.writeText(d.copy).then(() => toast("Copied."), () => toast(d.copy));
  } else if ("addLink" in d) {
    draft.links = [...readDraftLinks(), { label: "", url: "" }];
    redrawLinks();
    $(`#label-${draft.links.length - 1}`)?.focus();
  } else if (d.move || "delete" in d) {
    const links = readDraftLinks();
    const i = Number(el.closest("[data-link]").dataset.link);
    if ("delete" in d) links.splice(i, 1);
    else {
      const j = i + Number(d.move);
      if (j < 0 || j >= links.length) return;
      [links[i], links[j]] = [links[j], links[i]];
    }
    draft.links = links;
    redrawLinks();
  } else if ("removePhoto" in d) {
    draft.avatar = undefined;
    draft.links = readDraftLinks();
    render();
  } else if ("reset" in d) {
    saveSettings({});
    render();
  } else if (d.use) {
    const me = connected;
    act(`Putting @${d.use} on your page`, async () => profile.editCard(await readState(), me, { handle: d.use }), async (s) => (await profile.getProfile(s, me)).handle === d.use);
  } else if (d.list) {
    await listHandle(d.list);
  } else if (d.unlist) {
    const entry = await profile.resolve(await readState(), d.unlist);
    if (!entry) return;
    act(`Stop selling @${d.unlist}`, () => profile.unlist(entry), async (s) => (await profile.resolve(s, d.unlist))?.price === undefined);
  } else if (d.give) {
    await giveHandle(d.give);
  } else if (d.release) {
    await releaseHandle(d.release);
  }
});

async function listHandle(handle) {
  const entry = await profile.resolve(await readState(), handle);
  if (!entry) return;
  const price = await sheet({
    title: `Sell @${handle}`,
    body: "Anyone can buy it at this price at once, without asking you. Check the number.",
    input: {
      label: "Asking price",
      attrs: 'inputmode="numeric" pattern="[0-9]*" autocomplete="off"',
      check: (v) => (/^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < 2n ** 64n ? "" : "A whole number of coins."),
    },
    confirm: "List it",
  });
  if (price === null) return;
  act(`Listing @${handle}`, () => profile.list(entry, BigInt(price)), async (s) => (await profile.resolve(s, handle))?.price === BigInt(price));
}

async function giveHandle(handle) {
  const entry = await profile.resolve(await readState(), handle);
  if (!entry) return;
  const to = await sheet({
    title: `Give @${handle}`,
    body: "It becomes theirs at once, and you can't take it back.",
    input: { label: "Their address", attrs: 'autocomplete="off" spellcheck="false" class="mono"', check: (v) => (profile.isAddress(v) ? "" : "That is not an account address.") },
    confirm: "Give it",
  });
  if (to === null) return;
  act(`Giving @${handle}`, () => profile.transfer(entry, to), async (s) => (await profile.resolve(s, handle))?.holder === to);
}

async function releaseHandle(handle) {
  const entry = await profile.resolve(await readState(), handle);
  if (!entry) return;
  const ok = await sheet({
    title: `Release @${handle}`,
    body: "It stops being yours, and anyone may buy it next, for 0.",
    confirm: "Release it",
  });
  if (!ok) return;
  act(`Releasing @${handle}`, () => profile.release(entry), async (s) => (await profile.resolve(s, handle)) === undefined);
}

document.addEventListener("change", async (event) => {
  if (event.target.id !== "photo") return;
  const file = event.target.files?.[0];
  if (!file) return;
  if (!MEDIA_TYPES.test(file.type)) return toast("Choose a PNG, JPEG, GIF, WebP or AVIF image.", { bad: true });
  if (!settings.ownNode || !settings.ownCookie) {
    return toast("Photos are kept by your own node. Set it in Settings first.", { bad: true });
  }
  const progress = toast("Keeping your photo on your node…");
  try {
    const volume = mediaVolume(sdk, file.type, new Uint8Array(await file.arrayBuffer()));
    await operator(settings.ownNode, settings.ownCookie).pin(volume);
    draft.links = readDraftLinks();
    draft.avatar = volume.cid;
    progress.update("Photo kept. Save to put it on your page.");
    render();
  } catch (error) {
    progress.update(`Your node did not keep the photo: ${error.message}`, { bad: true });
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.id === "search") {
    event.preventDefault();
    const q = $("#q").value.trim();
    if (!q) return $("#q").focus();
    location.hash = `#/search/${encodeURIComponent(asHandle(q) || q)}`;
  } else if (form.id === "buy") {
    event.preventDefault();
    const want = form.dataset.handle;
    if (!connected) {
      try {
        await connect();
      } catch (error) {
        return toast(walletMessage(error), { bad: true });
      }
    }
    const me = connected;
    act(
      `Buying @${want}`,
      async () => {
        const state = await readState();
        const entry = await profile.resolve(state, want);
        // Bought at the price shown, or not at all.
        if (entry && entry.price === undefined) throw new Error(`@${want} was just taken, and it isn't for sale.`);
        if (entry && entry.price !== BigInt(form.dataset.price)) throw new Error(`The price of @${want} just changed. Look again.`);
        const take = entry ? profile.buy(entry, me) : await profile.claim(state, me, want);
        // Your first name goes on your page too, in the same approval.
        if ((await profile.getProfile(state, me)).handle) return take;
        return profile.combine(take, await profile.editCard(state, me, { handle: want }));
      },
      async (s) => (await profile.resolve(s, want))?.holder === me,
      () => {
        location.hash = `#/bought/${want}`;
      },
    );
  } else if (form.id === "edit") {
    event.preventDefault();
    const links = readDraftLinks().filter((l) => l.label || l.url);
    const bad = links.find((l) => !l.label || !profile.isWebURL(l.url));
    if (bad) return toast(bad.label ? `“${bad.label}” needs an http or https address.` : "Every link needs a title.", { bad: true });
    const url = $("#url").value.trim();
    if (url && !profile.isWebURL(url)) return toast("The website needs an http or https address.", { bad: true });
    const changes = {
      name: $("#name").value.trim(),
      description: $("#bio").value.trim(),
      handle: $("#handle").value,
      url,
      avatar: draft.avatar ?? "",
      links,
    };
    const me = connected;
    const progress = toast("Saving: approve it in your wallet.");
    try {
      const sent = await profile.saveCard(readState, me, changes, send);
      if (sent === undefined) {
        progress.update("Nothing changed.");
        setTimeout(progress.close, 2000);
        return;
      }
      progress.update("Saved. Waiting for the block…");
      const want = JSON.stringify({ ...changes, links });
      for (let i = 0; i < 120; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const p = await profile.getProfile(await readState(), me).catch(() => null);
        if (p && JSON.stringify({ name: p.name ?? "", description: p.description ?? "", handle: p.handle ?? "", url: p.url ?? "", avatar: p.avatar ?? "", links: p.links ?? [] }) === want) break;
      }
      draft = null;
      progress.update("Your page is updated.");
      setTimeout(progress.close, 2500);
      location.hash = "#/me";
      render();
    } catch (error) {
      progress.update(walletMessage(error), { bad: true });
    }
  } else if (form.id === "settings") {
    event.preventDefault();
    saveSettings({
      nodes: $("#s-nodes").value.split(/\s+/).filter(Boolean).map((n) => n.replace(/\/$/, "")),
      chain: $("#s-chain").value.trim() || DEFAULTS.chain,
      follows: $("#s-follows").value.trim() || DEFAULTS.follows,
      ownNode: $("#s-own").value.trim().replace(/\/$/, ""),
      ownCookie: $("#s-cookie").value.trim(),
    });
    toast("Settings saved.");
    location.hash = "#/";
  }
});

window.addEventListener("hashchange", render);
// A follow or unfollow saved: update the counts in place, keeping the button (and its "Saved.").
window.addEventListener("follows:change", async () => {
  const counts = $(".counts[data-target]");
  if (counts) counts.innerHTML = await countLinks(counts.dataset.target, counts.dataset.holder);
});
// Back from adding Selfhold: reload, on the same address, so it reaches the page.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && awaiting() && !wallet()) location.reload();
});
// Selfhold announces itself when it reaches a page.
window.addEventListener("lattice#initialized", () => {
  awaiting(false);
  render();
});
// A wallet already connected to this site answers without asking.
(async () => {
  try {
    connected = (await wallet()?.address?.()) ?? null;
  } catch {}
  if (wallet()) awaiting(false);
  render();
})();
