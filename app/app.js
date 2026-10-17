// Moniker: one page per account, like a link page, read from the profile
// chain by CID and written through the Lattice Wallet, which asks the owner to
// approve every change. Reading needs no wallet.
import * as sdk from "../sdk/vendor/lattice-sdk.js";
import { mediaVolume, operator } from "../client/media.mjs";
import * as profile from "../sdk/src/records/profile.mjs";
import { anyHost, tip, view, volumeLoader } from "../sdk/src/records/state.mjs";
import { writeRequest } from "../sdk/src/records/wallet.mjs";

// ---------------------------------------------------------------- settings

const DEFAULTS = {
  nodes: ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"],
  chain: "Nexus/testnet/moniker-da6f57",
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
}
const chainPath = () => settings.chain.split("/").filter(Boolean);
// Writes are free on the trial chain: its hosts admit 0-fee transactions.
const FEE = 0n;
// Where a newcomer gets the Lattice Wallet.
const WALLET_URL = "https://github.com/adalinxx/lattice-wallet/releases";

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

async function connect() {
  if (!wallet()) throw new Error("This needs the Lattice Wallet extension.");
  connected = await wallet().connect();
  return connected;
}

function walletMessage(error) {
  const text = String(error?.message ?? error);
  if (/just declined|ask again in a moment/i.test(text)) return "The wallet waits a few seconds after a decline. Try again in a moment.";
  if (/declined|rejected|denied/i.test(text)) return "You declined it in the wallet. Nothing was sent.";
  if (/locked/i.test(text)) return "Unlock the Lattice Wallet, then try again.";
  return text;
}

// The wallet takes one request from a page at a time.
let walletTurn = Promise.resolve();
function send(write) {
  const turn = walletTurn.then(() => wallet().writeRecords(writeRequest(chainPath(), write, FEE)));
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
  </header>`;

const footer = () => `
  <footer class="col">
    <nav aria-label="Moniker">
      <a href="#/">Moniker</a><a href="#/me">Your page</a><a href="#/handles">Handles</a><a href="#/settings">Settings</a>
    </nav>
  </footer>`;

// ---------------------------------------------------------------- views

async function viewProfile(address, state) {
  const p = await profile.getProfile(state, address);
  const mine = connected === address;
  const links = [...(p.url ? [{ label: hostOf(p.url), url: p.url }] : []), ...(p.links ?? [])];
  const empty = !p.name && !p.description && links.length === 0 && !p.avatar;
  const link = `${location.origin}${location.pathname}#/${p.handle ? `@${p.handle}` : address}`;
  return `
    <div class="col top">${mine ? `<a class="pill" href="#/edit">Edit</a>` : ""}</div>
    <main class="col card">
      ${p.avatar ? `<img class="avatar" data-photo="${esc(p.avatar)}" alt="">` : `<div class="avatar" aria-hidden="true">${esc(initial(p))}</div>`}
      <h1>${esc(p.name ?? short(address))}</h1>
      ${p.handle ? `<p class="handle">@${esc(p.handle)}</p>` : ""}
      ${p.description ? `<p class="bio">${esc(p.description)}</p>` : ""}
      ${links.length ? `<nav class="links" aria-label="Links">${links.map((l) => `<a href="${esc(l.url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(l.label)}</a>`).join("")}</nav>` : ""}
      ${empty ? `<p class="empty">${mine ? `Nothing here yet. <a href="#/edit">Make your page</a>.` : "This account hasn't made a page yet."}</p>` : ""}
      ${mine
        ? `<button class="copy" type="button" data-copy="${esc(link)}" style="margin-top: 24px">Copy your link ⧉</button>`
        : `<button class="copy" type="button" data-copy="${esc(address)}" aria-label="Copy this address" style="margin-top: 24px">${esc(short(address))} ⧉</button>`}
    </main>`;
}

// The handle someone is buying, kept if they leave to set up a wallet.
const JOINING = "moniker.joining";
function joining(handle) {
  try {
    if (handle === undefined) return localStorage.getItem(JOINING) ?? "";
    if (handle) localStorage.setItem(JOINING, handle);
    else localStorage.removeItem(JOINING);
  } catch {}
  return "";
}

/** The front door: find a name and buy it, which is how you sign up. */
function viewStart(message = "") {
  return `
    <main class="col start">
      <h1 class="hero">Own your name on the internet.</h1>
      <p class="lede">An @handle that belongs to you, not to an app. Any app can know you by it.</p>
      <form class="stack" id="join" style="margin-top: 20px">
        <label for="want" class="label">Find your name</label>
        <div class="box"><span class="mono" aria-hidden="true" style="color: var(--muted)">@</span><input id="want" value="${esc(joining())}" placeholder="yourname" autocomplete="off" spellcheck="false" autocapitalize="none"></div>
        <p class="note" id="want-status" aria-live="polite">${esc(message)}</p>
        <button class="pill accent big" id="claim-go" type="submit" hidden>Buy</button>
      </form>
      <ul class="promises">
        <li><b>Yours to keep.</b> No company can take it back, rename it or hand it to someone else.</li>
        <li><b>Proof it's you.</b> Only your key can change what your name says, so an app showing your @handle is showing you.</li>
        <li><b>One name everywhere.</b> Set it up once, and any app can show your name, photo and links.</li>
      </ul>
    </main>`;
}

const stepBar = (handle, step) => `
  <div class="col top" style="justify-content: flex-start; align-items: center; gap: 12px">
    <a class="pill icon" href="#/" aria-label="Back">‹</a>
    <span class="label">Buying <span class="mono" style="color: var(--accent)">@${esc(handle)}</span> · step ${step} of 2</span>
  </div>`;

/** Buying, step 1, without a wallet: add one. */
function viewBuyWallet(handle) {
  return `
    ${stepBar(handle, 1)}
    <main class="col stack" style="margin-top: 48px">
      <h1 style="margin: 0">Your key proves it's you</h1>
      <p class="lede">The Lattice Wallet holds the key that makes <span class="mono">@${esc(handle)}</span> yours. It stays on your device and asks you before anything is sent. Moniker never sees it.</p>
      <div class="stack" style="margin-top: 24px">
        <a class="pill accent big" href="${WALLET_URL}" target="_blank" rel="noopener">Add the Lattice Wallet</a>
        <p class="note" style="text-align: center">A browser extension. Once it's set up, reload this page.</p>
      </div>
    </main>`;
}

/**
 * Checkout, step 2: a handle no one owns costs 0, a listed one its asking
 * price, paid to its owner; one approval buys it and puts it on your page.
 */
async function viewBuy(handle, state) {
  const entry = await profile.resolve(state, handle);
  if (entry?.holder === connected) return viewProfile(connected, state);
  if (entry && entry.price === undefined) return viewStart(`@${handle} was just taken and is not for sale.`);
  const price = entry?.price ?? 0n;
  const p = await profile.getProfile(state, connected);
  return `
    ${stepBar(handle, 2)}
    <main class="col stack" style="margin-top: 24px">
      <h1 style="margin: 0">Buy <span class="mono" style="color: var(--accent)">@${esc(handle)}</span></h1>
      <p class="lede">Add the name people will see. One approval buys the handle and sets up your page with it.</p>
      <form id="buy" class="stack" data-handle="${esc(handle)}" data-price="${price}" style="margin-top: 8px">
        <div class="field"><label for="name">Name</label><input id="name" value="${esc(p.name ?? "")}" autocomplete="name" required></div>
        <div class="field"><label for="bio">Bio · optional</label><textarea id="bio" rows="2">${esc(p.description ?? "")}</textarea></div>
        <div class="sum">
          <span class="label">Price · ${entry ? "paid to its owner" : "no one owns it yet"}</span><span>${coins(price)}</span>
          <span class="label">Network fee</span><span>${coins(FEE)}</span>
          <span style="font-weight: 600">Total</span><span style="font-weight: 600">${coins(price + FEE)}</span>
        </div>
        ${entry ? `<p class="note">If the owner changes the price before it lands, nothing is taken.</p>` : ""}
        <button class="pill accent big" type="submit" style="margin-top: 4px">Buy for ${coins(price + FEE)}</button>
        <p class="note" style="text-align: center">It stays yours until you sell it or give it away. No renewals.</p>
      </form>
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
      <a class="pill" href="#/handles">Handles</a>
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

async function viewHandles(state) {
  const sale = await profile.forSale(state);
  const mine = connected ? await profile.heldBy(state, connected) : [];
  const shown = connected ? (await profile.getProfile(state, connected)).handle : undefined;
  return `
    <div class="col top" style="justify-content: space-between; align-items: center">
      <a class="pill icon" href="#/" aria-label="Back">‹</a>
    </div>
    <main class="col" style="margin-top: 12px">
      <h1 style="margin: 0">Handles</h1>
      ${connected ? `
      <section class="section stack" aria-labelledby="yours">
        <h2 id="yours">Yours</h2>
        ${mine.length ? mine.map((h) => `
          <div class="row">
            <span class="mono">@${esc(h.handle)}</span>
            <span class="label">${h.handle === shown ? "on your page" : ""}${h.price !== undefined ? `${h.handle === shown ? " · " : ""}for sale · ${coins(h.price)}` : ""}</span>
            <div class="end">
              ${h.price !== undefined
                ? `<button class="pill" type="button" data-unlist="${esc(h.handle)}">Stop selling</button>`
                : `<button class="pill" type="button" data-list="${esc(h.handle)}">Sell</button>`}
              <button class="pill" type="button" data-give="${esc(h.handle)}">Give</button>
              <button class="pill" type="button" data-release="${esc(h.handle)}">Release</button>
            </div>
          </div>`).join("") : `<p class="note">None yet. <a href="#/">Buy one</a>.</p>`}
      </section>` : ""}
      <section class="section stack" aria-labelledby="sale">
        <h2 id="sale">For sale</h2>
        ${sale.filter((h) => h.holder !== connected).map((h) => `
          <div class="row">
            <span class="mono">@${esc(h.handle)}</span>
            <div class="end"><a class="pill dark" href="#/buy/${esc(h.handle)}">Buy · ${coins(h.price)}</a></div>
          </div>`).join("") || `<p class="note">Nothing for sale right now.</p>`}
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
      const state = await readState();
      // Your key is asked for only where it is needed.
      if (r === "edit" || r === "me") {
        if (!connected) await connect();
        html = r === "edit" ? await viewEdit(state) : await viewProfile(connected, state);
      } else if (r === "handles") html = await viewHandles(state);
      else if (r.startsWith("buy/") && profile.isHandle(r.slice(4))) {
        if (!connected && wallet()) await connect();
        html = connected ? await viewBuy(r.slice(4), state) : viewBuyWallet(r.slice(4));
      } else if (r.startsWith("@")) {
        const entry = await profile.resolve(state, r.slice(1));
        html = entry ? await viewProfile(entry.holder, state) : viewStart(`No one holds ${r}.`);
      } else if (profile.isAddress(r)) html = await viewProfile(r, state);
      else if (r === "") html = viewStart();
      else html = viewStart(`“${r}” is not a handle or an address.`);
    }
    if (ticket !== drawing) return;
    app.innerHTML = header() + html + footer();
    // A handle remembered from an unfinished sign-up: check it again.
    if ($("#join #want")?.value) $("#want").dispatchEvent(new Event("input", { bubbles: true }));
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

let wantTimer;
document.addEventListener("input", (event) => {
  if (event.target.id !== "want") return;
  const want = event.target.value.trim().replace(/^@/, "");
  const status = $("#want-status");
  const go = $("#claim-go");
  go.hidden = true;
  clearTimeout(wantTimer);
  if (!want) return (status.textContent = "Lowercase letters, digits and _.");
  if (!profile.isHandle(want)) return (status.textContent = "Only lowercase letters, digits and _.");
  status.textContent = "Checking…";
  wantTimer = setTimeout(async () => {
    const entry = await profile.resolve(await readState(), want).catch(() => null);
    if ($("#want")?.value.trim().replace(/^@/, "") !== want) return;
    if (!entry) {
      status.textContent = `No one owns @${want} yet, so it costs 0.`;
      go.hidden = false;
      go.textContent = `Buy @${want} · 0`;
      go.dataset.mode = "buy";
    } else if (entry.holder === connected) {
      status.textContent = `@${want} is yours.`;
    } else if (entry.price !== undefined) {
      status.textContent = `@${want} is for sale by its owner.`;
      go.hidden = false;
      go.textContent = `Buy @${want} · ${coins(entry.price)}`;
      go.dataset.mode = "buy";
    } else {
      status.textContent = `@${want} is taken and not for sale.`;
      go.hidden = false;
      go.textContent = `See @${want}'s page`;
      go.dataset.mode = "see";
    }
  }, 300);
});

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
  if (form.id === "join") {
    event.preventDefault();
    const want = $("#want").value.trim().replace(/^@/, "");
    const mode = $("#claim-go").dataset.mode;
    if (mode === "see") location.hash = `#/@${want}`;
    else if (mode === "buy") {
      joining(want);
      location.hash = `#/buy/${want}`;
    }
  } else if (form.id === "buy") {
    event.preventDefault();
    const want = form.dataset.handle;
    const me = connected;
    const card = { handle: want, name: $("#name").value.trim(), description: $("#bio").value.trim() };
    act(
      `Buying @${want}`,
      async () => {
        const state = await readState();
        const entry = await profile.resolve(state, want);
        // Bought at the price shown, or not at all.
        if (entry && entry.price !== BigInt(form.dataset.price)) throw new Error(`The price of @${want} just changed. Look again.`);
        const take = entry ? profile.buy(entry, me) : await profile.claim(state, me, want);
        return profile.combine(take, await profile.editCard(state, me, card));
      },
      async (s) => (await profile.resolve(s, want))?.holder === me && (await profile.getProfile(s, me)).handle === want,
      () => {
        joining(null);
        location.hash = "#/me";
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
      ownNode: $("#s-own").value.trim().replace(/\/$/, ""),
      ownCookie: $("#s-cookie").value.trim(),
    });
    toast("Settings saved.");
    location.hash = "#/";
  }
});

window.addEventListener("hashchange", render);
// A wallet already connected to this site answers without asking.
(async () => {
  try {
    connected = (await wallet()?.address?.()) ?? null;
  } catch {}
  render();
})();
