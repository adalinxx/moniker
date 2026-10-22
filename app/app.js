// Moniker: profiles and @names, read from the profile chain by CID and
// written through the Selfhold wallet, which asks the owner to approve every
// change. An account (a key) owns profiles, each with a card and a page, and
// names, each pointing at a profile (anyone's) or at none. Reading needs no
// wallet.
import * as sdk from "../sdk/vendor/lattice-sdk.js";
import { mediaVolume, operator } from "../client/media.mjs";
import * as profile from "../sdk/src/records/profile.mjs";
import { anyHost, tip, view, volumeLoader } from "../sdk/src/records/state.mjs";
import { writeRequest } from "../sdk/src/records/wallet.mjs";
import { createMoniker } from "../sdk/src/index.mjs";
import { createFollows } from "../follows/src/index.mjs";
import { defineFollowButton } from "../follows/src/element.mjs";

// ---------------------------------------------------------------- settings

const DEFAULTS = {
  nodes: ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"],
  chain: "Nexus/testnet/moniker-01c01f",
  // Follows, the follow graph every app shares: who follows a name or an account.
  follows: "Nexus/testnet/follows-a8fa7f",
  // Your own node, for keeping photos: its URL and the cookie it writes at start.
  ownNode: "",
  ownCookie: "",
};
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("moniker.settings") ?? "{}");
    // Settings saved before the trials moved name old ones; follow the move.
    if (["Nexus/testnet/moniker-da6f57", "Nexus/testnet/moniker-8eb926", "Nexus/testnet/moniker-273339"].includes(saved.chain)) delete saved.chain;
    if (["Nexus/testnet/follows-6ed91a", "Nexus/testnet/follows-f53551"].includes(saved.follows)) delete saved.follows;
    return { ...DEFAULTS, ...saved };
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
  if (!graph) {
    const moniker = createMoniker({ sdk, nodes: settings.nodes, chain: chainPath(), freshFor: 5000 });
    graph = createFollows({ sdk, nodes: settings.nodes, chain: settings.follows.split("/").filter(Boolean), freshFor: 5000, moniker });
  }
  return graph;
}
// The Follow button reads and writes through whichever graph the settings name now.
defineFollowButton(
  new Proxy({}, {
    get: (_, name) => {
      const value = getGraph()[name];
      return typeof value === "function" ? (...args) => getGraph()[name](...args) : value;
    },
  }),
  { walletURL: WALLET_URL, monikerURL: "#/profiles" },
);

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
// An account ID by its end: every address begins alike (`bafyrei…`).
const shortID = (address) => `…${address.slice(-8)}`;
const initial = (p) => (p.name?.trim()?.[0] ?? p.handle?.[0] ?? "").toUpperCase();
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
  // A status is read when there's a pause; an error, at once, from its own region.
  const text = document.createElement("span");
  text.textContent = message;
  const close = Object.assign(document.createElement("button"), { type: "button", textContent: "×" });
  close.setAttribute("aria-label", "Dismiss");
  close.onclick = () => box.remove();
  box.append(text, close);
  $("#toasts").replaceChildren(...(bad ? [] : [box]));
  $("#alerts").replaceChildren(...(bad ? [box] : []));
  return {
    update(next, options = {}) {
      text.textContent = next;
      box.classList.toggle("bad", Boolean(options.bad));
      // An error moves to the region read at once.
      if (options.bad && box.parentElement?.id !== "alerts") $("#alerts").replaceChildren(box);
    },
    close: () => box.remove(),
  };
}

/**
 * A confirmation sheet. `rows` are `[label, value]` lines; `input` asks for
 * one value first. Resolves to the input's value (or true), or null when
 * cancelled.
 */
/**
 * A modal question. With `input`, resolves to what was typed; with `choices`
 * (`[{ value, label, bad? }]`), to the value chosen; else to true. Resolves
 * to null when cancelled.
 */
function sheet({ title, body = "", rows = [], confirm, input, choices }) {
  const dialog = $("#sheet");
  dialog.setAttribute("aria-describedby", "sheet-body");
  dialog.innerHTML = `
    <form method="dialog">
      <h2 id="sheet-title">${esc(title)}</h2>
      <p id="sheet-body">${esc(body)}</p>
      ${input ? `<div class="field"><label for="sheet-input">${esc(input.label)}</label><input id="sheet-input" ${input.attrs ?? ""} required></div>` : ""}
      ${rows.length ? `<div class="sum">${rows.map(([k, v]) => `<span class="label">${esc(k)}</span><span>${esc(v)}</span>`).join("")}</div>` : ""}
      ${choices ? `<div class="choices">${choices.map((c) => `<button class="pill${c.bad ? " bad" : ""}" value="choice:${esc(c.value)}" type="submit" formnovalidate>${esc(c.label)}</button>`).join("")}</div>` : ""}
      <p id="sheet-error" role="alert" style="color: var(--bad); margin: 0 0 12px"></p>
      <div class="actions">
        <button class="pill" value="cancel" type="submit" formnovalidate>Cancel</button>
        ${choices ? "" : `<button class="pill dark" value="ok" type="submit">${esc(confirm)}</button>`}
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
          $("#sheet-input").setAttribute("aria-invalid", "true");
          $("#sheet-input").setAttribute("aria-describedby", "sheet-error");
          return;
        }
      }
    };
    dialog.onclose = () => {
      const answer = dialog.returnValue;
      if (answer.startsWith("choice:")) return resolve(answer.slice("choice:".length));
      resolve(answer === "ok" ? (input ? $("#sheet-input").value.trim() : true) : null);
    };
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
      <a class="pill" href="#/profiles">My profiles</a>
    </nav>
  </header>`;

const footer = () => `
  <footer class="col">
    <nav aria-label="More"><a href="#/settings">Settings</a></nav>
  </footer>`;

// ---------------------------------------------------------------- views

/** `who` from a route: a profile, by `@handle` or by id; undefined when there is none. */
async function profileFor(state, who) {
  return who.startsWith("@") ? profile.profileOf(state, who.slice(1)) : profile.getProfile(state, who);
}

/** What to call a profile: its card's name, else its @handle, else that it has none. */
const nameOf = (p) => p.name ?? (p.handle ? `@${p.handle}` : "Unnamed profile");

/** A profile's name, with its @handle when it has both: for choosing one of several. */
const withHandle = (p) => `${nameOf(p)}${p.name && p.handle ? ` · @${p.handle}` : ""}`;

/** A profile's page by its @handle, else by its id. */
const pageOf = (p) => `#/${p.handle ? `@${p.handle}` : p.id}`;

/** The connected account's profiles. */
const myProfiles = async (state) => (connected ? profile.profilesOf(state, connected) : []);

/** The connected account's names. */
const myNames = async (state) => (connected ? profile.namesOf(state, connected) : []);

/** Where each name points, as `{ handle: profile }`: undefined for none, or for a profile that doesn't exist. */
async function pointedBy(state, names) {
  const ids = [...new Set(names.map((n) => n.profile).filter(Boolean))];
  const found = new Map((await profile.getProfiles(state, ids)).filter((p) => p.owner).map((p) => [p.id, p]));
  return Object.fromEntries(names.map((n) => [n.handle, found.get(n.profile)]));
}

/** Where a name points, in a few words: the profile's name, or none. */
const pointsLabel = (p) => (p ? `points at ${withHandle(p)}` : "no profile");

/** A page that is only a message: what happened, and where to go. */
const viewMessage = (title, body, link = `<a class="pill big" href="#/" style="margin-top: 20px">Search names</a>`) => `
  <main class="col card" style="margin-top: 48px">
    <h1>${esc(title)}</h1>
    ${body ? `<p class="bio">${body}</p>` : ""}
    ${link}
  </main>`;

/**
 * Who follows profile `p` and whom it follows, each count opening its list,
 * and the Follow button (not on your own profile).
 */
async function followsBlock(p, mine) {
  // Follows is another chain: if it can't be reached, the page still shows, without counts.
  const counts = await countLinks(p.id).catch(() => "");
  return `
    <div class="follows">
      <p class="counts" data-target="${esc(p.id)}">${counts}</p>
      ${mine ? "" : `<follows-button target="${esc(p.id)}" label="${esc(nameOf(p))}"></follows-button>`}
    </div>`;
}

/** "N followers" and "N following", each opening its list. */
async function countLinks(id) {
  const [followers, following] = await Promise.all([getGraph().followers(id), getGraph().following(id)]);
  const many = (n, one, other) => `<strong>${n.toLocaleString("en-US")}</strong> ${n === 1 ? one : other}`;
  return `
    <a href="#/${esc(id)}/followers">${many(followers.length, "follower", "followers")}</a>
    <a href="#/${esc(id)}/following">${many(following.length, "following", "following")}</a>`;
}

/**
 * A profile's page: its card, the name it shows, who follows it, and which
 * account owns it. Reached by `via`, a name pointing here that the profile
 * doesn't show, it says so.
 */
async function viewProfile(p, state, via) {
  const mine = connected === p.owner;
  const follows = await followsBlock(p, mine);
  const links = [...(p.url ? [{ label: hostOf(p.url), url: p.url }] : []), ...(p.links ?? [])];
  const empty = !p.name && !p.description && links.length === 0 && !p.avatar;
  return `
    <div class="col top">${mine ? `<a class="pill" href="#/edit/${esc(p.id)}">Edit</a>` : ""}</div>
    <main class="col card">
      ${p.avatar ? `<img class="avatar" data-photo="${esc(p.avatar)}" alt="">` : `<div class="avatar" aria-hidden="true">${esc(initial(p))}</div>`}
      <h1>${esc(nameOf(p))}</h1>
      ${p.handle ? `<p class="handle">@${esc(p.handle)}</p>` : ""}
      ${via && via !== p.handle ? `<p class="via">@${esc(via)} points here; this profile ${p.handle ? `shows @${esc(p.handle)}` : "doesn't list it as its name"}</p>` : ""}
      ${p.description ? `<p class="bio">${esc(p.description)}</p>` : ""}
      ${follows}
      <a class="owner" href="#/${esc(p.owner)}">${mine ? "Owner: you" : `Owner: account <span class="mono">${esc(shortID(p.owner))}</span>`}</a>
      ${links.length ? `<nav class="links" aria-label="Links">${links.map((l) => `<a href="${esc(l.url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(l.label)}</a>`).join("")}</nav>` : ""}
      ${empty ? `<p class="empty">${mine ? `Nothing here yet. <a href="#/edit/${esc(p.id)}">Set it up</a>.` : "This profile is empty so far."}</p>` : ""}
      ${p.price !== undefined && !mine ? `<p class="note">Its owner is selling this profile for ${coins(p.price)}. <a href="#/take-profile/${esc(p.id)}">Buy it</a></p>` : ""}
    </main>`;
}

/** A name that points at no profile: who owns it, and Buy if it is for sale. */
function viewName(entry) {
  const { handle, owner, price } = entry;
  const mine = connected === owner;
  return `
    <main class="col card">
      <h1 class="mono">@${esc(handle)}</h1>
      <p class="bio">${mine ? `You own @${esc(handle)}. It points at no profile.` : `@${esc(handle)} is owned by account <a href="#/${esc(owner)}" class="mono">${esc(shortID(owner))}</a> and points at no profile.`}</p>
      ${mine
        ? `<a class="pill big" href="#/profiles" style="margin-top: 28px">Go to My profiles</a>`
        : price !== undefined ? `<p class="note" style="margin-top: 20px">Its owner is selling it for ${coins(price)}.</p><a class="pill accent big" href="#/buy/${esc(handle)}" style="margin-top: 12px">Buy @${esc(handle)}</a>` : ""}
    </main>`;
}

/** One name in a list: the handle, linked to its page, where it points, and its terms. */
function handleRow(n, to, end = "") {
  const label = [pointsLabel(to), n.price !== undefined && `for sale · ${coins(n.price)}`, n.offer && "offered"].filter(Boolean).join(" · ");
  return `
    <div class="row">
      <a class="mono" href="#/@${esc(n.handle)}">@${esc(n.handle)}</a>
      <span class="label">${esc(label)}</span>
      ${end ? `<div class="end">${end}</div>` : ""}
    </div>`;
}

/**
 * An account: only its ID, the profiles it owns and its names, so anyone can
 * check who owns what. Accounts have no card and aren't followed.
 */
async function viewAccount(address, state) {
  const mine = connected === address;
  const [owned, names] = await Promise.all([profile.profilesOf(state, address), profile.namesOf(state, address)]);
  const to = await pointedBy(state, names);
  return `
    <main class="col card account-page">
      <h1 class="account"><span class="label">${mine ? "Your account" : "Account"}</span> <span class="mono" title="${esc(address)}">${esc(shortID(address))}</span></h1>
      <button class="copy" type="button" data-copy="${esc(address)}">Copy account ID</button>
      <p class="bio">${mine ? "An account is a private key. It owns these profiles and names, and is never shown on them." : "This key owns these profiles and names."}</p>
      <section class="names">
        ${owned.length ? `<h2>${owned.length === 1 ? "Profile" : "Profiles"}</h2>` : ""}
        ${owned.length
          ? owned.map((p) => personRow(p, pageOf(p), p.name && p.handle ? `@${p.handle}` : "")).join("")
          : `<p class="empty">${mine ? `No profiles yet. <a href="#/profiles">Make one</a>.` : "This account owns no profiles."}</p>`}
      </section>
      <section class="names">
        ${names.length ? `<h2>${names.length === 1 ? "Name" : "Names"}</h2>` : ""}
        ${names.length
          ? names.map((n) => handleRow(n, to[n.handle])).join("")
          : `<p class="empty">${mine ? `No names yet. <a href="#/">Get one</a>.` : "This account owns no names."}</p>`}
      </section>
    </main>`;
}

/** Your page: your profile if you have one, else My profiles. */
async function viewMe(state) {
  const mine = await myProfiles(state);
  return mine.length === 1 ? viewProfile(mine[0], state) : viewProfiles(state);
}

/** One profile in a list: its photo, name and @handle, linked to its page. */
function personRow(p, href, sub) {
  return `
    <a class="row person" href="${esc(href)}">
      ${p.avatar ? `<img class="avatar sm" data-photo="${esc(p.avatar)}" alt="">` : `<span class="avatar sm" aria-hidden="true">${esc(initial(p))}</span>`}
      <span class="who"><strong>${esc(nameOf(p))}</strong>${sub ? `<span class="label">${esc(sub)}</span>` : ""}</span>
    </a>`;
}

// Rows a list shows before "Show all": each row is a card to read.
const LIST_PAGE = 50;
let listAll = null; // the list (its route) that shows all its rows

/** Who follows a profile, or whom it follows. */
async function viewFollowList(who, tab, state) {
  const p = await profileFor(state, who);
  if (!p) return viewMessage("No such profile", "Its link may be mistyped.");
  const everyone = listAll === `${who}/${tab}`;
  const all = tab === "followers" ? await getGraph().followers(p.id) : await getGraph().following(p.id);
  const shown = await profile.getProfiles(state, everyone ? all : all.slice(0, LIST_PAGE));
  const rows = shown.map((q) => personRow(q, pageOf(q), q.name && q.handle ? `@${q.handle}` : ""));
  const empty = tab === "followers" ? "No followers yet." : "Not following anyone yet.";
  const title = p.handle ? `@${p.handle}` : nameOf(p);
  return `
    ${backBar(pageOf(p), title)}
    <main class="col stack">
      <h1 style="margin: 0">${esc(tab === "followers" ? `${title}'s followers` : `${title} follows`)}</h1>
      ${rows.length ? rows.join("") : `<p class="empty">${empty}</p>`}
      ${all.length > rows.length ? `<button class="pill" type="button" data-list-all="${esc(`${who}/${tab}`)}">Show all ${all.length.toLocaleString("en-US")}</button>` : ""}
    </main>`;
}

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
  if (entry.owner === connected) return { handle, kind: "yours" };
  if (entry.price !== undefined) return { handle, kind: "sale", price: entry.price };
  return { handle, kind: "taken" };
}

const buyLink = (r, cls = "pill accent") => `<a class="${cls}" href="#/buy/${esc(r.handle)}" aria-label="Buy @${esc(r.handle)} for ${coins(r.price)}">Buy</a>`;

function resultRow(r) {
  const tail = {
    available: `<span class="price">${coins(r.price)}</span>${buyLink(r)}`,
    sale: `<span class="label">for sale by its owner</span><span class="price">${coins(r.price)}</span>${buyLink(r, "pill dark")}`,
    yours: `<span class="label">yours</span><a class="pill" href="#/profiles">My profiles</a>`,
    taken: `<span class="label">taken</span><a class="pill" href="#/@${esc(r.handle)}">See it</a>`,
  }[r.kind];
  return `<div class="row"><span class="mono">@${esc(r.handle)}</span><div class="end">${tail}</div></div>`;
}

/** Search results: the exact name first, then names close to it. */
async function viewSearch(q, state) {
  const [exact, ...near] = await Promise.all([q, ...variants(q)].map(async (h) => standing(h, await profile.resolve(state, h))));
  const listed = (await profile.forSale(state))
    .filter((h) => h.handle !== q && h.handle.includes(q) && h.owner !== connected)
    .map((h) => ({ handle: h.handle, kind: "sale", price: h.price }));
  const more = [...near.filter((r) => r.kind === "available"), ...listed].slice(0, 6);
  const headline = {
    available: ["Available", "No one owns it yet, so it costs 0."],
    sale: ["For sale", "Its owner is selling it. You pay them directly, in the same transaction."],
    yours: ["Yours", "Your account owns this name."],
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
              ? `<a class="pill" href="#/profiles">Go to My profiles</a>`
              : `<a class="pill" href="#/@${esc(q)}">See @${esc(q)}</a>`}
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
function walletPanel(why, alone = false) {
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
      <h${alone ? 1 : 2} id="get-wallet">${why}</h${alone ? 1 : 2}>
      <p class="lede" style="margin: 0">Selfhold is a wallet in your browser. It keeps the key that proves a name is yours, on your device, and asks you before anything is sent. Moniker never sees it.</p>
      ${steps}${elsewhere}
    </section>`;
}

/** Where a key is needed, Selfhold is here, and this site isn't connected yet: one click asks it. */
function connectPanel(why, alone = false) {
  return `
    <section class="panel stack" aria-labelledby="connect">
      <h${alone ? 1 : 2} id="connect">${why}</h${alone ? 1 : 2}>
      <p class="lede" style="margin: 0">Selfhold asks you first. Moniker sees only your address, never your key.</p>
      <button class="pill accent big" type="button" data-connect>Connect Selfhold</button>
    </section>`;
}

/** Where a name you get points: one of your profiles (the first, unless you choose), a new one, or none yet. */
function pointChoice(mine) {
  return `
    <div class="field">
      <label for="to">Point it at</label>
      <select id="to">
        ${mine.map((p) => `<option value="${esc(p.id)}">${esc(withHandle(p))}</option>`).join("")}
        <option value="new">A new profile</option>
        <option value="none">No profile for now</option>
      </select>
    </div>`;
}

/** Profile `p`, which `me` owns, shows `handle` as its default name: written while `handle` comes to point at it. */
async function showWrite(state, p, handle) {
  const token = await profile.profileToken(state, p);
  const old = await state.get(profile.shownKey(p));
  return {
    actions: [
      { key: profile.profileKey(p), oldValue: token.value, newValue: token.value },
      { key: profile.shownKey(p), ...(old !== undefined && { oldValue: old }), newValue: handle },
    ],
  };
}

/**
 * The write that puts `handle` on `me`'s account: free, bought at its price,
 * or taken as offered. It points as chosen: at a profile of yours (which
 * shows it, if it shows no name yet), at a new profile, or nowhere.
 */
async function getName(state, me, handle, choice) {
  const entry = await profile.resolve(state, handle);
  const get = (point) => (entry ? profile.buy(state, me, handle, { point }) : profile.claim(state, me, handle, { point }));
  if (choice === "none") return get(undefined);
  if (choice === "new") {
    if (!entry) return (await profile.createProfile(state, me, { handle })).write;
    const made = await profile.createProfile(state, me);
    return profile.combine(made.write, await get(made.id), { actions: [{ key: profile.shownKey(made.id), newValue: handle }] });
  }
  const to = await profile.getProfile(state, choice);
  if (to?.owner !== me) throw new Error("That profile isn't yours anymore. Look again.");
  const write = await get(choice);
  return to.handle ? write : profile.combine(write, await showWrite(state, choice, handle));
}

/**
 * Checkout: only the order. A handle no one owns costs 0, a listed one its
 * asking price, paid to its owner. It goes on your account, pointed at a
 * profile if you like.
 */
async function viewBuy(handle, state) {
  const entry = await profile.resolve(state, handle);
  if (entry && entry.owner === connected) return viewBought(handle, state);
  if (entry && entry.price === undefined) return entry.offer === connected ? viewTake(handle, state) : viewStart(`@${handle} was just taken and is not for sale.`);
  const mine = await myProfiles(state);
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
          <span class="label">Price · ${entry ? "paid to its owner" : "no one owns it yet"}</span><span>${price === 0n ? "Free" : coins(price)}</span>
          ${FEE > 0n ? `<span class="label">Network fee</span><span>${coins(FEE)}</span>
          <span style="font-weight: 600">Total</span><span style="font-weight: 600">${coins(price + FEE)}</span>` : ""}
        </div>
        ${connected ? pointChoice(mine) : ""}
        <p class="note" style="margin: 0">The name is yours: point it at a profile, or keep it for later. No renewals.${entry ? " Only the name moves. If the owner changes the price before it lands, nothing is taken." : ""}</p>
        ${short ? `<p class="note" id="short" style="margin: 0">This costs ${coins(price + FEE)}. Your account has ${coins(balance)} on this chain.</p>` : ""}
        ${ready ? `<button class="pill accent big" type="submit">${price + FEE === 0n ? `Get @${esc(handle)} free` : `Buy for ${coins(price + FEE)}`}</button>` : ""}
      </form>
      ${ready ? "" : walletPanel(`To buy @${esc(handle)}, add Selfhold`)}
    </main>`;
}

/** Just got a name: say so, then the next step. */
async function viewBought(handle, state) {
  const entry = await profile.resolve(state, handle);
  const p = entry?.profile && (await profile.getProfile(state, entry.profile));
  const yours = p?.owner === connected;
  const next = !yours
    ? `<a class="pill accent big" href="#/profiles">Go to My profiles</a>`
    : `${p.name
        ? `<a class="pill accent big" href="#/@${esc(handle)}">View the profile</a>`
        : `<a class="pill accent big" href="#/edit/${esc(p.id)}">Set up the profile</a>`}
       <a class="pill big" href="#/profiles">Go to My profiles</a>`;
  return `
    <main class="col card" style="margin-top: 48px">
      <span class="badge">Yours</span>
      <h1 class="mono">@${esc(handle)} is yours</h1>
      <p class="bio">It stays yours until you sell it or give it away. ${yours ? "Any app can now find your profile by it." : p ? `It points at ${esc(nameOf(p))} until you point it elsewhere.` : "It points at no profile yet."}</p>
      <div class="stack" style="width: 100%; margin-top: 28px">${next}</div>
    </main>`;
}

/** A name offered to your account: take it, for nothing, and point it. */
async function viewTake(handle, state) {
  const entry = await profile.resolve(state, handle);
  if (entry && entry.owner === connected) return viewMessage(`@${handle} is yours`, "", `<a class="pill big" href="#/@${esc(handle)}" style="margin-top: 20px">See it</a>`);
  if (!entry || entry.offer !== connected) {
    return viewMessage(`@${handle} isn't offered to you`, `Selfhold connects account <span class="mono">${esc(shortID(connected))}</span> here. If the gift is for another of your accounts, switch to it in Selfhold and open the link again.`);
  }
  const mine = await myProfiles(state);
  return `
    <main class="col card" style="margin-top: 48px">
      <span class="badge">A gift</span>
      <h1 class="mono">@${esc(handle)}</h1>
      <p class="bio">Its owner is giving it to your account. Take it, and it's yours.</p>
      <div class="stack" style="width: 100%; margin-top: 28px; text-align: left">
        ${pointChoice(mine)}
        <button class="pill accent big" type="button" data-take-name="${esc(handle)}">Take @${esc(handle)}</button>
      </div>
    </main>`;
}

/** A profile for sale, or offered to you: take it, with its card and followers. */
async function viewTakeProfile(id, state) {
  const p = await profile.getProfile(state, id);
  if (!p) return viewMessage("No such profile", "Its link may be mistyped.");
  if (p.owner === connected) return viewProfile(p, state);
  const offered = p.offer !== undefined && p.offer === connected;
  if (!offered && p.price === undefined) {
    return viewMessage(`${nameOf(p)} isn't for sale`, `Selfhold connects account <span class="mono">${esc(shortID(connected))}</span> here. If it was offered to another of your accounts, switch to it in Selfhold and open the link again.`);
  }
  return `
    ${backBar(pageOf(p), nameOf(p))}
    <main class="col stack" style="margin-top: 12px">
      <h1 style="margin: 0">${offered ? "A profile for you" : "Buy this profile"}</h1>
      <section class="panel stack">
        ${personRow(p, pageOf(p), p.handle && p.name ? `@${p.handle}` : "")}
        <p class="note" style="margin: 0">It comes with its card and followers. Names don't come with it: they stay with their owners, who may point them elsewhere.</p>
        ${offered ? "" : `<div class="sum" style="margin: 0"><span class="label">Price · paid to its owner</span><span>${coins(p.price)}</span><span class="label">Network fee</span><span>${coins(FEE)}</span></div>`}
        ${wallet() ? `<button class="pill accent big" type="button" data-take-profile="${esc(id)}">${offered ? "Take it" : `Buy for ${coins(p.price + FEE)}`}</button>` : walletPanel("To take a profile, add Selfhold")}
      </section>
    </main>`;
}

async function viewEdit(id, state) {
  const p = await profile.getProfile(state, id);
  if (p?.owner !== connected) {
    return `<main class="col card" style="margin-top: 48px"><h1>This profile isn't yours</h1><p class="bio">Only its owner edits it.</p><a class="pill big" href="#/profiles" style="margin-top: 20px">Go to My profiles</a></main>`;
  }
  const [admins, pointing] = await Promise.all([profile.adminsOf(state, id), namesPointingAt(state, id)]);
  // Links and photo being edited survive a redraw until saved.
  draft = draft?.id === id ? draft : { id, links: [...(p.links ?? [])], avatar: p.avatar };
  return `
    <div class="col top" style="justify-content: flex-start; align-items: center">
      <a class="pill" href="${esc(pageOf(p))}">‹ ${esc(nameOf(p))}</a>
    </div>
    <main class="col stack" style="margin-top: 12px">
      <h1 style="margin: 0">Edit profile</h1>
      ${p.handle ? `<p class="mono note" style="margin: 0">@${esc(p.handle)}</p>` : ""}
      <form id="edit" class="stack" data-profile="${esc(id)}">
        <section class="panel stack" aria-label="About this profile">
          <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap">
            ${draft.avatar ? `<img class="avatar small" data-photo="${esc(draft.avatar)}" alt="The photo">` : `<div class="avatar small" aria-hidden="true">${esc(initial(p))}</div>`}
            <div class="stack" style="gap: 6px">
              <label class="pill" for="photo" style="width: fit-content">Change photo</label>
              <input id="photo" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" class="sr">
              ${draft.avatar ? `<button class="quiet" type="button" data-remove-photo style="border: 0; background: none; text-align: left; padding: 0">Remove photo</button>` : ""}
            </div>
          </div>
          <div class="field"><label for="name">Name</label><input id="name" value="${esc(p.name ?? "")}" autocomplete="name"></div>
          <div class="field"><label for="bio">Bio</label><textarea id="bio" rows="3">${esc(p.description ?? "")}</textarea></div>
          <div class="field"><label for="url">Website</label><input id="url" type="url" inputmode="url" value="${esc(p.url ?? "")}" placeholder="https://"></div>
        </section>
        <div id="links" class="stack">${draft.links.map((l, i) => linkRow(l, i)).join("")}</div>
        <button class="pill" type="button" data-add-link style="align-self: flex-start">+ Add link</button>
        <div class="bar">
          <span class="label">One change, approved in your wallet.</span>
          <div class="end"><button class="pill dark" type="submit">Save</button></div>
        </div>
      </form>
      <form id="default-name" class="panel stack" data-profile="${esc(id)}" aria-labelledby="default-title">
        <h2 id="default-title" style="margin: 0">Default name</h2>
        ${pointing.length
          ? `<p class="note" style="margin: 0">The @name this profile shows, of the names that point at it.</p>
        <div class="field">
          <label for="default" class="sr">Default name</label>
          <select id="default">
            ${p.handle ? "" : `<option value="" selected disabled>Choose a name</option>`}
            ${pointing.map((h) => `<option value="${esc(h)}"${h === p.handle ? " selected" : ""}>@${esc(h)}</option>`).join("")}
          </select>
        </div>
        <button class="pill" type="submit" style="align-self: flex-start">Use this name</button>`
          : `<p class="note" style="margin: 0">No name points at this profile. Point one of yours at it from <a href="#/profiles">My profiles</a>.</p>`}
      </form>
      <section class="panel stack" aria-labelledby="admins-title">
        <h2 id="admins-title" style="margin: 0">Admins</h2>
        <p class="note" style="margin: 0">Admins post as this profile in apps, with their own key. Only you edit it, sell it or change admins.</p>
        ${admins.map((a) => `<div class="row" role="group" aria-label="Admin ${esc(shortID(a))}"><span class="mono">${esc(shortID(a))}</span><div class="end"><button class="pill" type="button" data-remove-admin="${esc(a)}" data-profile="${esc(id)}">Remove</button></div></div>`).join("")}
        <button class="pill" type="button" data-add-admin="${esc(id)}" style="align-self: flex-start">+ Add admin</button>
      </section>
    </main>`;
}
let draft = null;

/** The names pointing at profile `p`, whoever owns them: one prefix read of `points/`. */
async function namesPointingAt(state, p) {
  const found = [];
  for await (const [key, value] of state.list("points/")) if (value === p) found.push(key.slice("points/".length));
  return found;
}


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

/** The link a receiver opens to take an offered name or profile. */
const takeLink = (hash) => `${location.origin}${location.pathname}${hash}`;

/** My profiles: each profile you own, then each name, each with a menu. */
async function viewProfiles(state) {
  const [mine, names] = await Promise.all([myProfiles(state), myNames(state)]);
  const to = await pointedBy(state, names);
  return `
    <main class="col" style="margin-top: 12px">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap">
        <h1 style="margin: 0">My profiles</h1>
        <button class="pill" type="button" data-new-profile>New profile</button>
      </div>
      <section class="section stack" aria-labelledby="profiles-title">
        <h2 id="profiles-title">Profiles</h2>
        ${mine.map((p) => `
          <div class="profile-head">
            ${personRow(p, pageOf(p), [p.name && p.handle && `@${p.handle}`, p.price !== undefined && `for sale · ${coins(p.price)}`, p.offer && "offered"].filter(Boolean).join(" · "))}
            <div class="end">
              ${p.offer ? `<button class="pill" type="button" data-copy="${esc(takeLink(`#/take-profile/${p.id}`))}">Copy link<span class="sr"> to take ${esc(nameOf(p))}</span></button>` : ""}
              <a class="pill" href="#/edit/${esc(p.id)}">Edit<span class="sr"> ${esc(nameOf(p))}</span></a>
              <button class="pill icon" type="button" data-profile-menu="${esc(p.id)}" aria-label="Options for profile ${esc(nameOf(p))}">⋯</button>
            </div>
          </div>`).join("") || `<p class="note">No profiles yet. A profile is the public card people follow.</p>`}
      </section>
      <section class="section stack" aria-labelledby="names-title">
        <h2 id="names-title">Names</h2>
        ${names.map((n) => handleRow(n, to[n.handle], `
          ${n.offer ? `<button class="pill" type="button" data-copy="${esc(takeLink(`#/take/${n.handle}`))}">Copy link<span class="sr"> to take @${esc(n.handle)}</span></button>` : ""}
          <button class="pill icon" type="button" data-name-menu="${esc(n.handle)}" aria-label="Options for @${esc(n.handle)}">⋯</button>`)).join("")
          || `<p class="note">No names yet. <a href="#/">Get one</a>.</p>`}
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
            <div class="end">${h.owner === connected
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
let drawn = 0; // views shown so far
let used = null; // the control last pressed, as a selector, to focus again after a redraw

async function render() {
  const ticket = ++drawing;
  const r = route();
  const app = $("#app");
  try {
    let html;
    if (r === "settings") html = viewSettings();
    else {
      // Selfhold connects only within a click, so ask now, before the read, if this render came from one.
      const [page, arg = ""] = r.split(/\/(.*)/s);
      // Old links: names and a page edited without saying which profile.
      if (r === "names" || r === "edit") return void location.replace("#/profiles");
      const needs = ["me", "profiles", "edit", "take", "take-profile"].includes(page);
      if (needs && !connected && wallet() && navigator.userActivation?.isActive) await connect();
      const state = await readState();
      // Your key is asked for only where it is needed.
      const why = page === "take" ? `To take @${arg}, connect Selfhold` : page === "take-profile" ? "To take this profile, connect Selfhold" : "Your profiles belong to your wallet's key";
      if (needs && !wallet()) {
        html = `<main class="col stack" style="margin-top: 24px">${walletPanel(why, true)}</main>`;
      } else if (needs && !connected) {
        html = `<main class="col stack" style="margin-top: 24px">${connectPanel(why, true)}</main>`;
      } else if (r === "me") html = await viewMe(state);
      else if (r === "profiles") html = await viewProfiles(state);
      else if (page === "edit" && profile.isProfileId(arg)) html = await viewEdit(arg, state);
      else if (page === "take" && profile.isHandle(arg)) html = await viewTake(arg, state);
      else if (page === "take-profile" && profile.isProfileId(arg)) html = await viewTakeProfile(arg, state);
      else if (r === "market") html = await viewMarket(state);
      else if (page === "search") {
        const q = asHandle(arg);
        html = profile.isHandle(q) ? await viewSearch(q, state) : viewStart(q ? `“${arg}”: a name is lowercase letters, digits and _.` : "");
      } else if (page === "buy" && profile.isHandle(arg)) {
        html = await viewBuy(arg, state);
      } else if (page === "bought" && connected && profile.isHandle(arg)) html = await viewBought(arg, state);
      else if (/^(@[a-z0-9_]+|[a-z2-7]{16})\/(followers|following)$/.test(r)) {
        html = await viewFollowList(page, arg, state);
      } else if (r.startsWith("@") && profile.isHandle(r.slice(1))) {
        // A name: the profile it points at, else who owns it, else a search for it.
        const entry = await profile.resolve(state, r.slice(1));
        const p = entry?.profile && (await profile.getProfile(state, entry.profile));
        html = p ? await viewProfile(p, state, entry.handle) : entry ? viewName(entry) : await viewSearch(r.slice(1), state);
      } else if (profile.isProfileId(r)) {
        const p = await profile.getProfile(state, r);
        html = p ? await viewProfile(p, state) : viewMessage("No such profile", "Its link may be mistyped.");
      } else if (profile.isAddress(r)) html = await viewAccount(r, state);
      else if (r === "") html = viewStart();
      else html = viewStart(`“${r}” is not a name, a profile or an account.`);
    }
    if (ticket !== drawing) return;
    app.innerHTML = header() + html + footer();
    // Back to the control that was used, if it is still here; else a new
    // view: its heading, so keyboard and screen reader users start there.
    const again = used && $(used, app);
    if (again) again.focus({ preventScroll: true });
    else if (drawn > 0 && !app.contains(document.activeElement)) {
      const heading = $("h1", app);
      heading?.setAttribute("tabindex", "-1");
      heading?.focus({ preventScroll: true });
    }
    drawn++;
    for (const img of app.querySelectorAll("[data-photo]")) {
      photo(img.dataset.photo).then((url) => {
        if (url) img.src = url;
      });
    }
  } catch (error) {
    if (ticket !== drawing) return;
    app.innerHTML = `<main class="col"><h1 class="empty" role="alert">${esc(walletMessage(error))}</h1><p style="text-align: center"><button class="pill" type="button" data-retry>Try again</button> <a class="pill" href="#/settings">Settings</a></p></main>${footer()}`;
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
  // A choice in a sheet belongs to the control that opened it: keep that one.
  if (!el.closest("#sheet")) {
    const key = Object.keys(d).find((k) => k !== "profile");
    used = key ? `[data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${CSS.escape(d[key])}"]` : null;
  }
  if ("retry" in d) {
    render();
  } else if (d.listAll) {
    listAll = d.listAll;
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
  } else if ("newProfile" in d) {
    const me = connected;
    let made;
    act(
      "Making a profile",
      async () => (made = await profile.createProfile(await readState(), me)).write,
      async (s) => (await profile.getProfile(s, made.id))?.owner === me,
      () => {
        location.hash = `#/edit/${made.id}`;
      },
    );
  } else if (d.nameMenu) {
    await nameMenu(d.nameMenu);
  } else if (d.profileMenu) {
    await profileMenu(d.profileMenu);
  } else if (d.takeName) {
    const me = connected;
    const choice = $("#to").value;
    act(`Taking @${d.takeName}`, async () => getName(await readState(), me, d.takeName, choice), async (s) => (await profile.resolve(s, d.takeName))?.owner === me, () => {
      location.hash = `#/@${d.takeName}`;
    });
  } else if (d.takeProfile) {
    if (!connected) {
      try {
        await connect();
      } catch (error) {
        return toast(walletMessage(error), { bad: true });
      }
    }
    const me = connected;
    act("Taking the profile", async () => profile.takeProfile(await readState(), me, d.takeProfile), async (s) => (await profile.getProfile(s, d.takeProfile))?.owner === me, () => {
      location.hash = `#/${d.takeProfile}`;
    });
  } else if (d.addAdmin) {
    const admin = await sheet({
      title: "Add an admin",
      body: "They post as this profile in apps, with their own key. They can't edit it, sell it or change admins.",
      input: { label: "Their account ID", attrs: 'autocomplete="off" spellcheck="false" class="mono"', check: (v) => (profile.isAddress(v) ? "" : "That is not an account ID.") },
      confirm: "Add admin",
    });
    if (admin === null) return;
    const me = connected;
    act("Adding the admin", async () => profile.setAdmin(await readState(), me, d.addAdmin, admin), async (s) => (await profile.adminsOf(s, d.addAdmin)).includes(admin));
  } else if (d.removeAdmin) {
    const me = connected;
    act("Removing the admin", async () => profile.setAdmin(await readState(), me, d.profile, d.removeAdmin, false), async (s) => !(await profile.adminsOf(s, d.profile)).includes(d.removeAdmin));
  }
});

/** What can be done with a name of yours, chosen from a sheet. */
async function nameMenu(handle) {
  const state = await readState();
  const entry = await profile.resolve(state, handle);
  if (!entry) return;
  const to = entry.profile && (await profile.getProfile(state, entry.profile));
  const terms = entry.price !== undefined || entry.offer;
  const choice = await sheet({
    title: `@${handle}`,
    body: to ? `Points at ${withHandle(to)}.` : "Points at no profile.",
    choices: [
      { value: "point", label: "Point at…" },
      ...(to?.owner === connected && to.handle !== handle ? [{ value: "default", label: "Make default name" }] : []),
      terms ? { value: "keep", label: entry.offer ? "Take back the offer" : "Stop selling" } : { value: "sell", label: "Sell" },
      ...(terms ? [] : [{ value: "give", label: "Give" }]),
      { value: "release", label: "Release", bad: true },
    ],
  });
  const me = connected;
  if (choice === "point") await pointHandle(handle);
  else if (choice === "default") {
    act(`Making @${handle} the default name`, async () => profile.showName(await readState(), me, to.id, handle), async (s) => (await profile.getProfile(s, to.id))?.handle === handle);
  } else if (choice === "keep") {
    act(`@${handle}`, async () => profile.unlist(await readState(), me, handle), async (s) => {
      const now = await profile.resolve(s, handle);
      return now?.price === undefined && now?.offer === undefined;
    });
  } else if (choice === "sell") await listHandle(handle);
  else if (choice === "give") await giveHandle(handle);
  else if (choice === "release") await releaseHandle(handle);
}

/**
 * Points a name of yours: at one of your profiles (which shows it, if it
 * shows no name yet), at someone else's, or at none.
 */
async function pointHandle(handle) {
  const state = await readState();
  const [entry, mine] = await Promise.all([profile.resolve(state, handle), myProfiles(state)]);
  if (!entry) return;
  const choice = await sheet({
    title: `Point @${handle} at`,
    body: "The profile people find by this name. You can point it elsewhere any time.",
    choices: [
      ...mine.filter((p) => p.id !== entry.profile).map((p) => ({ value: p.id, label: withHandle(p) })),
      { value: "other", label: "Someone else's profile…" },
      ...(entry.pointer !== undefined ? [{ value: "none", label: "No profile" }] : []),
    ],
  });
  if (!choice) return;
  let target = choice === "none" ? undefined : choice;
  if (choice === "other") {
    const typed = await sheet({
      title: `Point @${handle} at someone else's profile`,
      body: "It stays your name: you can point it back, sell it or give it away.",
      input: { label: "Their profile: its @name or its link", attrs: 'autocomplete="off" spellcheck="false"', check: (v) => (/^@?[a-z0-9_]+$/.test(v) || profileIdIn(v) ? "" : "An @name or a profile link.") },
      confirm: "Point it",
    });
    if (typed === null) return;
    const now = await readState();
    target = profileIdIn(typed) ?? (await profile.resolve(now, typed.replace(/^@/, "")))?.profile;
    if (!target || !(await profile.getProfile(now, target))) return toast(`No profile is ${typed}.`, { bad: true });
  }
  const me = connected;
  act(
    `Pointing @${handle}`,
    async () => {
      const now = await readState();
      const write = await profile.pointName(now, me, handle, target);
      const p = target && (await profile.getProfile(now, target));
      // A profile of yours with no name to show shows this one.
      return p?.owner === me && !p.handle ? profile.combine(write, await showWrite(now, target, handle)) : write;
    },
    async (s) => (await profile.resolve(s, handle))?.pointer === target,
  );
}

/** Copies a link the receiver opens, and says so; the link stays on the row to copy again. */
function shareLink(hash) {
  navigator.clipboard?.writeText(takeLink(hash)).catch(() => {});
  toast("Offered. Link copied: send it to them.");
}

async function listHandle(handle) {
  const price = await sheet({
    title: `Sell @${handle}`,
    body: "Anyone can buy it at this price at once, without asking you. Only the name moves.",
    input: {
      label: "Asking price",
      attrs: 'inputmode="numeric" pattern="[0-9]*" autocomplete="off"',
      check: (v) => (/^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < 2n ** 64n ? "" : "A whole number of coins."),
    },
    confirm: "List it",
  });
  if (price === null) return;
  const me = connected;
  act(`Listing @${handle}`, async () => profile.list(await readState(), me, handle, BigInt(price)), async (s) => (await profile.resolve(s, handle))?.price === BigInt(price));
}

/** Gives a name to another account: it takes the name from a link you send. */
async function giveHandle(handle) {
  const to = await sheet({
    title: `Give @${handle}`,
    body: "Only the name moves, to the account you name. It takes it from a link you send; until then you can take it back.",
    input: { label: "Their account ID", attrs: 'autocomplete="off" spellcheck="false" class="mono"', check: (v) => (profile.isAddress(v) ? (v === connected ? "That is your own account." : "") : "That is not an account ID.") },
    confirm: "Offer it",
  });
  if (to === null) return;
  const me = connected;
  act(`Offering @${handle}`, async () => profile.offerName(await readState(), me, handle, to), async (s) => (await profile.resolve(s, handle))?.offer === to, () => {
    shareLink(`#/take/${handle}`);
    render();
  });
}

/** A profile id in what someone typed: the id itself, or a link ending in it. */
function profileIdIn(text) {
  const id = text.trim().split(/[#/]/).pop();
  return profile.isProfileId(id) ? id : undefined;
}

async function releaseHandle(handle) {
  const ok = await sheet({
    title: `Release @${handle}`,
    body: "It stops being yours and points nowhere. Anyone may get it next, free.",
    confirm: "Release it",
  });
  if (!ok) return;
  const me = connected;
  act(`Releasing @${handle}`, async () => profile.release(await readState(), me, handle), async (s) => (await profile.resolve(s, handle)) === undefined);
}

/** What can be done with a whole profile of yours, chosen from a sheet. */
async function profileMenu(id) {
  const p = await profile.getProfile(await readState(), id);
  if (!p) return;
  const terms = p.price !== undefined || p.offer;
  const choice = await sheet({
    title: nameOf(p),
    body: "The profile: its card and followers. Your names stay yours.",
    choices: terms
      ? [{ value: "keep", label: p.offer ? "Take back the offer" : "Stop selling" }]
      : [{ value: "sell", label: "Sell profile" }, { value: "give", label: "Give profile" }],
  });
  const me = connected;
  if (choice === "keep") {
    act(`Keeping ${nameOf(p)}`, async () => profile.setProfileTerms(await readState(), me, id), async (s) => {
      const now = await profile.getProfile(s, id);
      return now?.price === undefined && now?.offer === undefined;
    });
  } else if (choice === "sell") await sellProfile(p);
  else if (choice === "give") await giveProfile(p);
}

async function sellProfile(p) {
  const id = p.id;
  const price = await sheet({
    title: `Sell ${nameOf(p)}`,
    body: "Anyone can buy it at this price at once. Its card and followers go to the buyer. Your names stay yours; point them elsewhere if you like.",
    input: {
      label: "Asking price",
      attrs: 'inputmode="numeric" pattern="[0-9]*" autocomplete="off"',
      check: (v) => (/^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < 2n ** 64n ? "" : "A whole number of coins."),
    },
    confirm: "List it",
  });
  if (price === null) return;
  const me = connected;
  act(`Listing ${nameOf(p)}`, async () => profile.setProfileTerms(await readState(), me, id, { price: BigInt(price) }), async (s) => (await profile.getProfile(s, id))?.price === BigInt(price));
}

/** Gives a whole profile to an account, which takes it from a link: also how a profile moves to a new key. */
async function giveProfile(p) {
  const id = p.id;
  const to = await sheet({
    title: `Give ${nameOf(p)}`,
    body: "Its card and followers go to the account you name, which takes it from a link you send. Your names stay yours. To move it to a new key of your own, name that key's account.",
    input: { label: "Their account ID", attrs: 'autocomplete="off" spellcheck="false" class="mono"', check: (v) => (profile.isAddress(v) ? "" : "That is not an account ID.") },
    confirm: "Offer it",
  });
  if (to === null) return;
  const me = connected;
  act(`Offering ${nameOf(p)}`, async () => profile.setProfileTerms(await readState(), me, id, { offer: to }), async (s) => (await profile.getProfile(s, id))?.offer === to, () => {
    shareLink(`#/take-profile/${id}`);
    render();
  });
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
    progress.update("Photo kept. Save to put it on the page.");
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
    const chosen = $("#to")?.value;
    act(
      `Buying @${want}`,
      async () => {
        const state = await readState();
        const entry = await profile.resolve(state, want);
        // Bought at the price shown, or not at all.
        if (entry && entry.price === undefined) throw new Error(`@${want} was just taken, and it isn't for sale.`);
        if (entry && entry.price !== BigInt(form.dataset.price)) throw new Error(`The price of @${want} just changed. Look again.`);
        // Connected only now, with no choice shown: your first profile, else a new one.
        const choice = chosen ?? (await profile.profilesOf(state, me))[0]?.id ?? "new";
        return getName(state, me, want, choice);
      },
      async (s) => (await profile.resolve(s, want))?.owner === me,
      () => {
        location.hash = `#/bought/${want}`;
      },
    );
  } else if (form.id === "default-name") {
    event.preventDefault();
    const id = form.dataset.profile;
    const handle = $("#default").value;
    if (!handle) return toast("Choose a name first.", { bad: true });
    const me = connected;
    act(`Showing @${handle}`, async () => profile.showName(await readState(), me, id, handle), async (s) => (await profile.getProfile(s, id))?.handle === handle);
  } else if (form.id === "edit") {
    event.preventDefault();
    const links = readDraftLinks().filter((l) => l.label || l.url);
    const bad = links.find((l) => !l.label || !profile.isWebURL(l.url));
    if (bad) return toast(bad.label ? `“${bad.label}” needs an http or https address.` : "Every link needs a title.", { bad: true });
    const url = $("#url").value.trim();
    if (url && !profile.isWebURL(url)) return toast("The website needs an http or https address.", { bad: true });
    const id = form.dataset.profile;
    const changes = {
      name: $("#name").value.trim(),
      description: $("#bio").value.trim(),
      url,
      avatar: draft.avatar ?? "",
      links,
    };
    const me = connected;
    const progress = toast("Saving: approve it in your wallet.");
    try {
      const sent = await profile.saveCard(readState, me, id, changes, send);
      if (sent === undefined) {
        progress.update("Nothing changed.");
        setTimeout(progress.close, 2000);
        return;
      }
      progress.update("Saved. Waiting for the block…");
      const want = JSON.stringify({ ...changes, links });
      for (let i = 0; i < 120; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const p = await profile.getProfile(await readState(), id).catch(() => null);
        if (p && JSON.stringify({ name: p.name ?? "", description: p.description ?? "", url: p.url ?? "", avatar: p.avatar ?? "", links: p.links ?? [] }) === want) break;
      }
      draft = null;
      progress.update("The profile is updated.");
      setTimeout(progress.close, 2500);
      const saved = await profile.getProfile(await readState(), id).catch(() => null);
      location.hash = saved ? pageOf(saved) : `#/${id}`;
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

window.addEventListener("hashchange", () => {
  used = null;
  scrollTo(0, 0);
  render();
});
// A follow or unfollow saved: update the counts in place, keeping the button (and its "Saved.").
window.addEventListener("follows:change", async () => {
  const counts = $(".counts[data-target]");
  if (!counts) return;
  try {
    counts.innerHTML = await countLinks(counts.dataset.target);
  } catch {} // the counts stay as they were; the next visit reads them again
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
