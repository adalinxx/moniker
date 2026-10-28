// Moniker: @names, read from the names chain by CID and written through
// Selfhold, which asks the owner to approve every change: in its window, over
// the page, whose key a passkey keeps, or in Selfhold for Chrome. An account
// (a key) owns names, and points each at an account, any account. An account
// shows `@h` only while it names h and h points at it. Reading needs no wallet.
import * as sdk from "../sdk/vendor/lattice-sdk.js";
import * as names from "../sdk/src/records/names.mjs";
import { writeRequest, writeRequestURI } from "../sdk/src/records/wallet.mjs";
import { accountIcon, createMoniker, isAddress, isHandle, shortAccount } from "../sdk/src/index.mjs";
import encodeQR from "./vendor/qr.mjs";
import { selfhold } from "./vendor/selfhold.mjs";

// ---------------------------------------------------------------- settings

const DEFAULTS = {
  // None named: reads go to the hosts Nexus lists for the chain.
  nodes: [],
  chain: "Nexus/moniker",
  // A fee sponsor: Selfhold's window pays it fees in this device's GPU work, before coins; "" for none.
  sponsor: "https://lattice-testnet-apps-iad.fly.dev:8650/sponsor",
  // "web" uses Selfhold's window; "extension", Selfhold for Chrome where it is installed.
  wallet: "web",
  // Selfhold's window; the tests serve their own.
  walletPage: "https://wallet.selfhold.app/",
};
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("moniker.settings") ?? "{}");
    // Settings saved on a trial chain name it; follow the move to Moniker.
    // Settings saved with the hosts once named by default find them through Nexus now.
    if (JSON.stringify(saved.nodes) === JSON.stringify(["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"])) delete saved.nodes;
    if (["Nexus/testnet/moniker-da6f57", "Nexus/testnet/moniker-8eb926", "Nexus/testnet/moniker-273339", "Nexus/testnet/moniker-01c01f", "Nexus/testnet/moniker-307b2c"].includes(saved.chain)) delete saved.chain;
    return {
      nodes: Array.isArray(saved.nodes) && saved.nodes.length ? saved.nodes : DEFAULTS.nodes,
      chain: typeof saved.chain === "string" && saved.chain ? saved.chain : DEFAULTS.chain,
      sponsor: typeof saved.sponsor === "string" ? saved.sponsor : DEFAULTS.sponsor,
      // Selfhold for Chrome only as chosen in Settings ("selfhold", once); once the default, an older one chose nothing.
      wallet: saved.walletChosen && ["extension", "selfhold"].includes(saved.wallet) ? "extension" : DEFAULTS.wallet,
      walletPage: typeof saved.walletPage === "string" && /^(https:\/\/|http:\/\/localhost[:/])/.test(saved.walletPage) ? saved.walletPage : DEFAULTS.walletPage,
      walletChosen: Boolean(saved.walletChosen),
    };
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
  moniker = null;
}
const chainPath = () => settings.chain.split("/").filter(Boolean);
// A write asks for no fee: Selfhold pays the fee the person sets there for
// the chain, and shows it for approval with the write; Selfhold's window
// pays the hosts' relay floor, or a sponsor in work.
// Where someone gets Selfhold, the wallet for Lattice (once named Lattice Wallet).
const WALLET_URL = "https://chromewebstore.google.com/detail/amcobhbipbblfjonmoiicihhfglkhpce";
// Selfhold is a desktop Chromium extension: phones and other browsers can't add it.
const phone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const chromium = Boolean(navigator.userAgentData?.brands?.some((b) => /Chromium/.test(b.brand)));

// ---------------------------------------------------------------- reading

let moniker = null;
const client = () => (moniker ??= createMoniker({ sdk, nodes: settings.nodes, chain: chainPath(), freshFor: 0 }));

/** The names chain's state at the tip of the first host that answers. */
const readState = () => client().state({ fresh: true });

/** The name as the chain holds it, or undefined when free. */
const held = (state, handle) => names.resolve(state, handle);

// ---------------------------------------------------------------- wallet

let connected = null;
// Selfhold's window: each call that needs the person opens it over the page, from a click.
const web = selfhold({ wallet: settings.walletPage, hosts: () => client().hosts(), sponsor: () => settings.sponsor });
/** Selfhold's window, or Selfhold for Chrome where Settings choose it and it is installed. */
const wallet = () => (settings.wallet === "extension" && window.lattice) || web;
const extension = () => wallet() !== web;

/**
 * Selfhold for Chrome, for whoever connected it to this site while it was
 * the default and hasn't chosen a wallet since: their names are its
 * account's. Decided once.
 */
async function adoptSelfhold() {
  if (settings.walletChosen || !window.lattice) return;
  const address = await window.lattice.address?.().catch(() => null);
  if (address) saveSettings({ ...settings, wallet: "extension", walletChosen: true });
}

/** From here on, Selfhold's window: the checkout's way to pay with it was picked. */
async function useWeb() {
  if (!extension()) return;
  saveSettings({ ...settings, wallet: "web", walletChosen: true });
  connected = await web.address();
}

/**
 * Asks the wallet for this site's account. Selfhold's window opens only in
 * answer to a click, and Selfhold for Chrome answers only within one, so
 * call it before any other wait.
 */
async function connect() {
  connected = await wallet().connect();
  return connected;
}

/**
 * Connects first if this site isn't connected; true if the write can go on
 * in this click, `purpose` ("claim @river") saying what for. Selfhold's
 * window takes the click to connect, so after it the person presses again:
 * false. False too, saying why, if it fails.
 */
async function connectFirst(purpose) {
  if (connected) return true;
  try {
    await connect();
    if (extension()) return true;
    render();
    toast(`Connected. Now ${purpose}.`);
  } catch (error) {
    toast(walletMessage(error), { bad: true });
  }
  return false;
}

function walletMessage(error) {
  const text = String(error?.message ?? error);
  if (/just declined|ask again in a moment/i.test(text)) return "The wallet waits a few seconds after a decline. Try again in a moment.";
  if (/declined|rejected|denied/i.test(text)) return "You declined it in the wallet. Nothing was sent.";
  if (/locked/i.test(text) && extension()) return "Unlock Selfhold, then try again.";
  return text;
}

// Selfhold for Chrome takes one request from a page at a time.
let walletTurn = Promise.resolve();
/**
 * Sends the write `written` resolves to, built for account `me`, through the
 * wallet; null, nothing to send, resolves to null. Selfhold's window opens at
 * once, in the click, waits for the write, and tells `progress` what it does.
 */
async function send(written, me, progress) {
  // A write is built for one account. If the wallet was since disconnected
  // from this site, or connected to another account, say so and send nothing.
  const changed = (now) => {
    written.catch(() => {});
    connected = now;
    render();
    return new Error(now ? "Selfhold now connects this site to a different account. Look again, then try again." : "Selfhold isn't connected to this site anymore. Connect again, then try again.");
  };
  if (!extension()) {
    const now = await web.address();
    if (now !== me) throw changed(now);
    return web.writeRecords(written.then((write) => write && writeRequest(chainPath(), write)), { progress });
  }
  const turn = walletTurn.then(async () => {
    const now = await wallet().address();
    if (now !== me) throw changed(now);
    const write = await written;
    return write && wallet().writeRecords(writeRequest(chainPath(), write));
  });
  walletTurn = turn.catch(() => {});
  return turn;
}

/**
 * Builds a write on a fresh state (`build(state, me)`), sends it, then waits
 * until the chain shows it (`landed(state, me)`), so the page redraws from
 * what the chain holds, not from what was asked.
 */
const acting = new Set(); // the labels of writes under way, each sent once however often it's pressed

async function act(label, build, landed, done = render) {
  if (acting.has(label)) return;
  acting.add(label);
  try {
    await acted(label, build, landed, done);
  } finally {
    acting.delete(label);
  }
}

async function acted(label, build, landed, done) {
  const me = connected;
  const progress = toast(`${label}: approve it in ${extension() ? "your wallet" : "Selfhold's window"}.`);
  try {
    // Read and built while the wallet opens.
    const written = readState().then((state) => build(state, me)).then((write) => (write.actions.length ? write : null));
    const sent = await send(written, me, (text) => progress.update(`${label}: ${text.charAt(0).toLowerCase()}${text.slice(1)}`));
    if (sent === null) {
      progress.update(`${label}: it is so already.`);
      setTimeout(progress.close, 2500);
      return;
    }
    progress.update(`${label}: confirming…`);
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      try {
        if (await landed(await readState(), me)) break;
      } catch {}
      if (Date.now() > deadline) throw new Error("Sent, but not confirmed yet. It may still go through: look again in a minute.");
    }
    progress.update(`${label}: done.`);
    setTimeout(progress.close, 2500);
    done();
  } catch (error) {
    // Selfhold's window may have another account now: it forgets this site's, to connect again.
    const now = extension() ? me : await web.address();
    if (now !== me) {
      connected = now;
      render();
    }
    if (error.name !== "NeedsCoins") return progress.update(walletMessage(error), { bad: true });
    progress.close();
    fundSheet(error);
  }
}

/** The account can't pay for a write in Selfhold's window: what it needs, and where to send coins. */
async function fundSheet({ address, needed, balance, sponsor }) {
  // Fees are usually paid with this device's GPU: say so when, this time, they can't be.
  const why = {
    down: " Its fee is usually paid with this device's GPU, but that isn't working right now: try again in a few minutes, or",
    dear: " This device's GPU can't pay for it in reasonable time, so",
    most: " This device's GPU pays fees here, but not a price this high, so",
  }[sponsor] ?? "";
  const on = settings.chain === DEFAULTS.chain ? "" : ` on ${settings.chain}`;
  const copy = await sheet({
    title: "Add coins to your account",
    body: `This needs ${coins(needed)} ${needed === 1n ? "coin" : "coins"}, and your account holds ${coins(balance)}.${why ? `${why} send` : " Send"} coins${on} to your account ID, then try again.`,
    detail: address,
    confirm: "Copy account ID",
  });
  if (copy) navigator.clipboard?.writeText(address).then(() => toast("Account ID copied."), () => toast(address));
}

// ---------------------------------------------------------------- helpers

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// An account ID by its end: every address begins alike (`bafyrei…`).
const shortID = shortAccount;
/** An account in a line of text: its pattern and its short ID, so it reads as an account. */
const accountRef = (address) => `<span class="acct">${accountIcon(address, 16)}<span class="mono">${esc(shortID(address))}</span></span>`;
const coins = (amount) => `${amount.toLocaleString("en-US")}`;
const priceProblem = (v) => (/^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < 2n ** 63n ? "" : "A whole number of coins, below 9,223,372,036,854,775,808.");
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
 * A modal question in the page. With `input`, resolves to what was typed;
 * with `choices` (`[{ value, label, bad? }]`), to the value chosen; else to
 * true. Resolves to null when cancelled. `danger` marks a confirm that can't
 * be undone.
 */
function sheet({ title, body = "", detail, confirm, input, choices, danger = false, cancel = true }) {
  const dialog = $("#sheet");
  dialog.setAttribute("aria-describedby", "sheet-body");
  dialog.innerHTML = `
    <form method="dialog">
      <h2 id="sheet-title">${esc(title)}</h2>
      <p id="sheet-body">${esc(body)}</p>
      ${detail ? `<p class="sheet-detail mono">${esc(detail)}</p>` : ""}
      ${input ? `<div class="field"><label for="sheet-input">${esc(input.label)}</label><input id="sheet-input" ${input.attrs ?? ""} value="${esc(input.value ?? "")}" required></div>` : ""}
      ${choices ? `<div class="choices${choices.some((c) => c.primary) ? " decide" : ""}">${choices.map((c) => `<button class="pill${c.primary ? " accent" : ""}${c.bad ? " bad" : ""}" value="choice:${esc(c.value)}" type="submit" formnovalidate>${esc(c.label)}</button>`).join("")}</div>` : ""}
      <p id="sheet-error" role="alert" style="color: var(--bad); margin: 0 0 12px"></p>
      ${!cancel && choices ? "" : `<div class="actions">
        ${cancel ? `<button class="pill" type="button" data-sheet-cancel>Cancel</button>` : ""}
        ${choices ? "" : `<button class="pill ${danger ? "danger" : "dark"}" value="ok" type="submit">${esc(confirm)}</button>`}
      </div>`}
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
    // Cancel is no submit button, so Enter in the input submits the confirm.
    const cancelButton = $("[data-sheet-cancel]", dialog);
    if (cancelButton) cancelButton.onclick = () => dialog.close("cancel");
    // Without Cancel, Escape picks nothing either: the sheet waits for a choice.
    dialog.oncancel = cancel ? null : (event) => event.preventDefault();
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
      <a href="#/market">For sale</a>
      <a class="pill" href="#/names">My names</a>
    </nav>
  </header>`;

const footer = () => `
  <footer class="col">
    <nav aria-label="More"><a href="#/settings">Settings</a></nav>
  </footer>`;

// ---------------------------------------------------------------- views

/** A page that is only a message: what happened, and where to go. */
const viewMessage = (title, body, link = `<a class="pill big" href="#/" style="margin-top: 20px">Search names</a>`) => `
  <main class="col card" style="margin-top: 48px">
    <h1>${esc(title)}</h1>
    ${body ? `<p class="bio">${body}</p>` : ""}
    ${link}
  </main>`;

const accountLink = (address) => `<a class="acct-link" href="#/account/${esc(address)}">${accountRef(address)}</a>`;
const ownedBy = (owner) => (owner === connected ? `Owned by <a href="#/account/${esc(owner)}">you</a>` : `Owned by ${accountLink(owner)}`);

/** A name's terms in a few words: for sale, offered, or neither. As HTML with `html`, accounts shown as accounts. */
function termsOf(n, html = false) {
  if (n.price !== undefined) return `for sale · ${coins(n.price)}`;
  if (n.offer) return n.offer === connected ? "offered to you" : `offered to ${html ? accountRef(n.offer) : shortID(n.offer)}`;
  return "";
}

/** Where a name points, in a few words. As HTML with `html`, the account shown as an account. */
function pointsLabel(n, html = false) {
  if (!n.pointer) return "points nowhere";
  return n.pointer === connected ? "points at you" : `points at ${html ? accountRef(n.pointer) : shortID(n.pointer)}`;
}

/** One name in a list: the handle, linked to its page, and `label` as HTML (by default where it points, and its terms). */
function handleRow(n, end = "", label = [pointsLabel(n, true), termsOf(n, true)].filter(Boolean).join(" · ")) {
  return `
    <div class="row">
      <a class="mono" href="#/@${esc(n.handle)}">@${esc(n.handle)}</a>
      <span class="label">${label}</span>
      ${end ? `<div class="end">${end}</div>` : ""}
    </div>`;
}

/** Where a name points: the account, linked to its page, and whether that account shows it. */
async function pointsAt(state, n) {
  if (!n.pointer) return `<p class="note" id="points" style="margin: 0">@${esc(n.handle)} points at no account.</p>`;
  const shown = (await names.handleOf(state, n.pointer)) === n.handle;
  return `<p class="note" id="points" style="margin: 0">Points at ${n.pointer === connected ? `<a href="#/account/${esc(n.pointer)}">you</a>` : accountLink(n.pointer)} · ${shown ? `shown as @${esc(n.handle)}` : "not shown there"}</p>`;
}

/** Show this handle: for the connected account, on a name pointing at it that it doesn't show yet. */
const showButton = (handle) => `<button class="pill" type="button" data-show="${esc(handle)}">Show this handle<span class="sr"> @${esc(handle)}</span></button>`;

/** An account: its ID, the handle it shows, and its names, so anyone can check who owns what. */
async function viewAccount(address, state) {
  const mine = connected === address;
  const [owned, shows] = await Promise.all([names.namesOf(state, address), names.handleOf(state, address)]);
  return `
    <main class="col card account-page">
      <h1 class="account">${accountIcon(address, 48)}<span class="label">${mine ? "Your account" : "Account"}</span> <span class="mono">${esc(address)}</span></h1>
      <p class="shows">${shows ? `Shown as <a class="mono" href="#/@${esc(shows)}">@${esc(shows)}</a>` : "Shows no handle"}</p>
      <button class="copy" type="button" data-copy="${esc(address)}">Copy account ID</button>
      <p class="bio">${mine ? "An account is a private key. It owns these names, and is never shown on them." : "This key owns these names."}</p>
      <section class="names">
        ${owned.length ? `<h2>${owned.length === 1 ? "Name" : "Names"}</h2>` : ""}
        ${owned.length
          ? owned.map((n) => handleRow(n)).join("")
          : `<p class="empty">${mine ? `No names yet. <a href="#/">Get one</a>.` : "This account owns no names."}</p>`}
      </section>
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
      <p class="lede">An @handle that belongs to you, not to an app. Point it at your account, and every app shows it.</p>
      <div class="stack" style="margin-top: 24px">
        ${searchBox()}
        <p class="note" id="search-note" aria-live="polite">${esc(message) || "Lowercase letters, digits and _."}</p>
      </div>
      <ul class="promises">
        <li><b>Yours to keep.</b> No company can take it back, rename it or hand it to someone else. No renewals.</li>
        <li><b>Proof it's you.</b> Only your key can change where your name points, so an app showing your @handle is showing you.</li>
        <li><b>One name everywhere.</b> Your account shows it in every app, from one record.</li>
      </ul>
    </main>`;
}

/** Names close to `q` to offer next to it, as a registrar does. */
function variants(q) {
  const year = new Date().getFullYear();
  return [`${q}_`, `the${q}`, `${q}hq`, `its${q}`, `real${q}`, `${q}${year}`, `hey${q}`, `${q}_1`, `${q}online`]
    .filter((h) => h !== q && isHandle(h));
}

/** One handle's standing: available (0), for sale (its price), offered to you, yours, or taken. */
function standing(handle, entry) {
  if (!entry) return { handle, kind: "available", price: 0n };
  if (entry.owner === connected) return { handle, kind: "yours" };
  if (entry.price !== undefined) return { handle, kind: "sale", price: entry.price };
  if (connected && entry.offer === connected) return { handle, kind: "offered" };
  return { handle, kind: "taken" };
}

function resultRow(r) {
  const tail = r.kind === "available"
    ? `<span class="price">${coins(r.price)}</span><a class="pill accent" href="#/@${esc(r.handle)}" aria-label="Claim @${esc(r.handle)} for 0">Claim</a>`
    : `<span class="label">for sale by its owner</span><span class="price">${coins(r.price)}</span><a class="pill dark" href="#/@${esc(r.handle)}" aria-label="See @${esc(r.handle)} for ${coins(r.price)}">See</a>`;
  return `<div class="row"><span class="mono">@${esc(r.handle)}</span><div class="end">${tail}</div></div>`;
}

/** Claiming a free name: Claim, to the checkout. */
function claimForm(handle) {
  return `
    <form id="claim" class="stack" data-handle="${esc(handle)}" style="width: 100%">
      <p class="note" style="margin: 0">It points at your account; you can point it elsewhere any time.</p>
      <button class="pill accent big" type="submit">Claim @${esc(handle)}</button>
    </form>`;
}

/** A name's page: whether it is free, who owns it, its terms, and where it points; names close to it after a search. */
async function viewSearch(q, state, { near = true } = {}) {
  const entry = await held(state, q);
  const exact = standing(q, entry);
  let more = [];
  if (near) {
    const nearby = await Promise.all(variants(q).map(async (h) => standing(h, await held(state, h))));
    const listed = (await names.forSale(state))
      .filter((h) => h.handle !== q && h.handle.includes(q) && h.owner !== connected)
      .map((h) => ({ handle: h.handle, kind: "sale", price: h.price }));
    more = [...nearby.filter((r) => r.kind === "available"), ...listed].slice(0, 6);
  }
  const headline = {
    available: ["Available", "No one owns it yet, so it costs 0."],
    sale: ["For sale", "Its owner is selling it. You pay them directly, in the same transaction. It comes pointing at your account."],
    offered: ["Offered to you", "Its owner is giving it to your account. Take it, and it's yours."],
    yours: ["Yours", "Your account owns this name."],
    taken: ["Taken", "Someone owns it and isn't selling it."],
  }[exact.kind];
  let end = "";
  if (exact.kind === "available") end = claimForm(q);
  else if (exact.kind === "sale") {
    end = `<span class="price big">${coins(exact.price)}</span><a class="pill accent" href="#/buy/${esc(q)}">Buy @${esc(q)} for ${coins(exact.price)}</a>`;
  } else if (exact.kind === "offered") end = `<button class="pill accent" type="button" data-take="${esc(q)}">Take @${esc(q)}</button>`;
  else if (exact.kind === "yours") end = `<a class="pill" href="#/names">Go to My names</a>`;
  return `
    <div class="col">${searchBox(q)}</div>
    <main class="col">
      <section class="result ${exact.kind}" aria-labelledby="exact">
        <span class="badge">${headline[0]}</span>
        <h1 id="exact" class="mono">@${esc(q)}</h1>
        <p class="lede">${headline[1]}</p>
        ${entry ? `<p class="owned">${ownedBy(entry.owner)}${termsOf(entry) ? ` · ${termsOf(entry, true)}` : ""}</p>` : ""}
        ${end ? `<div class="result-end">${end}</div>` : ""}
      </section>
      ${entry ? `
      <section class="section stack" aria-labelledby="points-title">
        <h2 id="points-title">Where it points</h2>
        ${await pointsAt(state, entry)}
        ${connected && entry.pointer === connected && (await names.handleOf(state, connected)) !== q ? `<div>${showButton(q)}</div>` : ""}
      </section>` : ""}
      ${more.length ? `
      <section class="section stack" aria-labelledby="more">
        <h2 id="more">More names</h2>
        ${more.map(resultRow).join("")}
      </section>` : ""}
    </main>`;
}

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

/** Where a key is needed and this site has no account yet: Selfhold's window makes one with a passkey, or finds one made before; or Selfhold for Chrome. */
function accountPanel(why, alone = false) {
  const extensionLink = phone ? "" : `
    <p class="note" style="margin: 0">Rather keep your key in a browser extension? <a href="${WALLET_URL}" target="_blank" rel="noopener" data-get-wallet>Add Selfhold${chromium ? "" : " for Chrome"}</a>, then come back to this tab.</p>
    <p class="note" id="wallet-wait" aria-live="polite" style="margin: 0"${awaiting() ? "" : " hidden"}>Waiting for Selfhold… When it's set up, come back to this tab.</p>`;
  return `
    <section class="panel stack" aria-labelledby="get-wallet" style="width: 100%">
      <h${alone ? 1 : 2} id="get-wallet">${esc(why)}</h${alone ? 1 : 2}>
      <p class="lede" style="margin: 0">${SELFHOLD_KEEPS}</p>
      <button class="pill accent big" type="button" data-connect>Continue with Selfhold</button>
      ${extensionLink}
    </section>`;
}

const SELFHOLD_KEEPS = "Selfhold opens in a window over this page. A passkey keeps your account's key on this device and the ones it syncs to, unlocked with your face, fingerprint or screen lock. Moniker never sees it.";

/** Where a key is needed, Selfhold is here, and this site isn't connected yet: one click asks it. */
function connectPanel(why, alone = false) {
  return `
    <section class="panel stack" aria-labelledby="connect">
      <h${alone ? 1 : 2} id="connect">${esc(why)}</h${alone ? 1 : 2}>
      <p class="lede" style="margin: 0">Selfhold asks you first. Moniker sees only your address, never your key.</p>
      <button class="pill accent big" type="button" data-connect>Connect Selfhold</button>
    </section>`;
}

// ---------------------------------------------------------------- checkout

// The checkout's choice of how to pay, kept across its redraws.
const checkout = { handle: null, method: null };

/** The ways to pay here, the first the one to offer first. */
function payMethods() {
  // Selfhold's window, its fee paid with this device's GPU, always; Selfhold for Chrome first where it is the wallet.
  if (extension()) return ["extension", "web", "request"];
  // Selfhold for Chrome, while the window is in use: through a request if it's here, else where to add it.
  return window.lattice || !phone ? ["web", "extension", "request"] : ["web", "request"];
}

/**
 * Before a purchase, a page of its own, as a checkout: what it costs and whom
 * it pays, then a choice of how to pay, each with its fee and total. Its Pay
 * is the last step, and the only one that asks a wallet anything.
 *
 *   web        Selfhold's window, its account a passkey's; its fee paid with this device's GPU, through the sponsor
 *   extension  Selfhold for Chrome: the connected account, or with the window in use, a request it opens
 *   request    a lattice://write request, as a QR code, text or a card to drag, for any wallet anywhere
 */
async function viewBuy(handle, state) {
  const entry = await held(state, handle);
  const see = `<a class="pill big" href="#/@${esc(handle)}" style="margin-top: 20px">See @${esc(handle)}</a>`;
  if (connected && entry?.owner === connected) return viewMessage(`@${handle} is yours`, "Your account owns it already.", see);
  if (entry && entry.price === undefined) return viewMessage(`@${handle} isn't for sale`, "Its owner isn't selling it now, or someone just bought it.", see);
  // No owner: a claim, for 0.
  const free = !entry;
  const price = free ? 0n : entry.price;
  if (checkout.handle !== handle) Object.assign(checkout, { handle, method: null });
  const methods = payMethods();
  const method = methods.includes(checkout.method) ? checkout.method : methods[0];
  checkout.method = method;

  const label = { web: "Selfhold", extension: "Selfhold for Chrome", request: "Another wallet or device" };
  const hint = { web: "In a window, with your passkey", extension: "The browser extension", request: "Scan a code, or copy a request" };
  const choice = (m) => `
        <label class="method">
          <input type="radio" name="pay" value="${m}"${m === method ? " checked" : ""}>
          <span><strong>${label[m]}</strong><span class="note">${hint[m]}</span></span>
        </label>`;
  // The first way leads; the others wait, folded, for whoever wants them.
  const [first, ...others] = methods;
  const choices = `${choice(first)}
        <details class="others"${method !== first ? " open" : ""}>
          <summary>Other ways to pay</summary>
          ${others.map(choice).join("")}
        </details>`;

  let detail;
  if (method === "web") detail = await webPay(handle, entry);
  else if (method === "extension") detail = extensionPay(handle, entry, await requestFor(handle, entry, state));
  else detail = requestPay(handle, entry, await requestFor(handle, entry, state));

  return `
    <div class="col top" style="justify-content: flex-start"><a class="pill icon" href="#/@${esc(handle)}" aria-label="Back to @${esc(handle)}">‹</a></div>
    <main class="col stack" style="margin-top: 12px">
      <section class="panel stack" aria-labelledby="buy-title">
        <h1 id="buy-title" style="margin: 0">${free ? "Claim" : "Buy"} <span class="mono">@${esc(handle)}</span></h1>
        <dl class="summary">
          <div><dt>Price</dt><dd>${free ? "0: no one owns it yet" : `${coins(price)}, paid to its owner, ${accountLink(entry.owner)}`}</dd></div>
        </dl>
        <p style="margin: 0">It becomes the paying account's, pointing at it; it can point elsewhere any time.</p>
      </section>
      <fieldset class="methods">
        <legend>Pay with</legend>
        ${choices}
      </fieldset>
      <section class="panel stack" aria-label="${label[method]}">
        ${detail}
        <a class="pill big" href="#/@${esc(handle)}">Not now</a>
      </section>
    </main>`;
}

/** The purchase as a lattice://write request, for whichever account the person picks in their wallet; good for 15 minutes. */
async function requestFor(handle, entry, state) {
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  const what = `${entry ? "Buy" : "Claim"} @${handle}`;
  const label = what.length <= 64 ? what : undefined;
  const uri = writeRequestURI(chainPath(), names.acquire(handle, entry, await state.get(names.pointsKey(handle))), { label, expiresAt });
  return { uri, expiresAt };
}

/**
 * What `address` holds on the names chain, and the fee the first host that
 * takes transactions asks: `{ balance, fee }`, read fresh, or null if none answers.
 */
async function funds(address) {
  const chain = encodeURIComponent(settings.chain);
  for (const host of await client().hosts()) {
    try {
      const get = async (path) => {
        const response = await fetch(`${host}${path}?chainPath=${chain}`, { cache: "no-store" });
        if (response.status === 404) return {};
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      };
      const [info, account] = await Promise.all([get("/api/chain/info"), get(`/api/state/account/${address}`)]);
      if (info.acceptsSubmit !== false) return { balance: BigInt(account.balance ?? 0), fee: BigInt(info.minRelayFee ?? 0) };
    } catch {}
  }
  return null;
}

/** What does a sponsor's work here: "GPU" where the browser has one for the page, else "processor". */
let device;
const workDevice = () => (device ??= Promise.resolve(navigator.gpu?.requestAdapter()).then((adapter) => (adapter ? "GPU" : "processor"), () => "processor"));

/** Paying in Selfhold's window: what its account holds, and its fee, paid with this device's GPU where it can be. */
async function webPay(handle, entry) {
  const price = entry?.price ?? 0n;
  // A claim, or a purchase: its button, which turns to Selfhold's window where Selfhold for Chrome was in use.
  const go = `${entry ? `data-buy="${esc(handle)}" data-price="${price}"` : `data-claim="${esc(handle)}"`} data-via="web"`;
  const me = await web.address();
  if (!me) {
    return `<p style="margin: 0">${SELFHOLD_KEEPS}${entry ? ` Buying takes coins: once your account is there, add at least ${coins(price)} to it, or pay with this device's GPU.` : ""}</p>
        <button class="pill accent big" type="button" data-connect data-via="web">Continue with Selfhold</button>`;
  }
  const funded = await funds(me);
  if (!funded) return `<p role="alert" style="margin: 0">No host answered for your account's balance.</p><button class="pill big" type="button" data-retry>Try again</button>`;
  const { balance, fee } = funded;
  // With a sponsor, this device's GPU pays the fee in work: free, wherever the account holds the price.
  const byWork = fee > 0n && Boolean(settings.sponsor);
  const total = byWork ? price : price + fee;
  const feeText = fee === 0n ? "None" : byWork ? `Free, paid with this device's ${await workDevice()}` : coins(fee);
  const rows = `<dl class="summary">
        <div><dt>Fee</dt><dd>${feeText}</dd></div>
        ${total > price ? `<div><dt>Total</dt><dd>${coins(total)}</dd></div>` : ""}
        <div><dt>Your account holds</dt><dd>${coins(balance)}</dd></div>
      </dl>`;
  // The GPU pays what the account is short, too, where the fee service pays prices.
  if (byWork && balance < total) {
    return `${rows}
        <p class="note" style="margin: 0">This device's GPU can pay the ${coins(total - balance)} your account is short, as it pays the fee. It takes a little while.</p>
        <button class="pill accent big" type="button" ${go}>Pay with this device's GPU</button>
        <button class="pill big" type="button" data-fund="${esc(String(total))}">Add coins instead</button>`;
  }
  if (balance < total) {
    const more = total - balance;
    return `${rows}
        <p class="note" role="status" style="margin: 0">This needs ${coins(more)} more ${more === 1n ? "coin" : "coins"} than your account holds.</p>
        <button class="pill accent big" type="button" data-fund="${esc(String(total))}">Add coins</button>`;
  }
  return `${rows}
        <button class="pill accent big" type="button" ${go}>${entry ? `Pay ${coins(price)} and buy` : "Claim"} @${esc(handle)}</button>`;
}

/** Paying with Selfhold for Chrome: the account it connects here, or a request it opens for one you pick; or where to add it. */
function extensionPay(handle, entry, { uri }) {
  const price = entry?.price ?? 0n;
  if (extension()) {
    return `<p style="margin: 0">Selfhold shows the ${entry ? "payment" : "claim"} and its fee, set there, for you to approve.</p>
        <button class="pill accent big" type="button" ${entry ? `data-buy="${esc(handle)}" data-price="${price}">Pay ${coins(price)} with Selfhold` : `data-claim="${esc(handle)}">Claim @${esc(handle)} with Selfhold`}</button>`;
  }
  if (window.lattice) {
    return `<p style="margin: 0">Selfhold opens the ${entry ? "purchase" : "claim"} for an account you pick there, with its fee, for you to approve.</p>
        <button class="pill accent big" type="button" data-open-request="${esc(uri)}" data-owner="${esc(entry?.owner ?? "")}">Open in Selfhold</button>`;
  }
  return `<p style="margin: 0">Selfhold is a browser extension that keeps your key and shows each payment before you approve it.</p>
        <a class="pill accent big" href="${WALLET_URL}" target="_blank" rel="noopener" data-get-wallet>Add Selfhold${chromium ? "" : " for Chrome"}</a>
        <p class="note" style="margin: 0">Then come back to this tab, and pay with it here.</p>`;
}

/** Paying from any wallet, anywhere: the request as a QR code, text to copy, and a card to drag into a wallet's tab. */
function requestPay(handle, entry, { uri, expiresAt }) {
  // Medium error correction while the code stays small enough to scan from a screen; past that, low.
  let svg = encodeQR(uri, "svg", { ecc: "medium", border: 2 });
  if (Number(/viewBox="0 0 (\d+)/.exec(svg)?.[1] ?? 0) > 110) svg = encodeQR(uri, "svg", { ecc: "low", border: 2 });
  const until = expiresAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  afterDraw.push({ ticket: drawing, run: () => watchSale({ handle, owner: entry?.owner, price: entry?.price, expiresAt }) });
  return `<p style="margin: 0">Scan this with a Lattice wallet on another device, drag it into a wallet open in another tab, or copy it into one. The wallet picks the account, and shows the ${entry ? "payment" : "claim"} and its fee for you to approve.</p>
        <div class="request-card" draggable="true" data-request="${esc(uri)}" title="Drag into a wallet's tab">
          <div class="qr" role="img" aria-label="QR code of the request to ${entry ? "buy" : "claim"} @${esc(handle)}">${svg}</div>
        </div>
        <button class="pill big" type="button" data-copy="${esc(uri)}">Copy the request</button>
        <p class="note" id="request-status" role="status" style="margin: 0">Waiting for the payment. The request is good until ${esc(until)}.</p>
        <button class="pill big" type="button" data-retry id="request-again" hidden>Make a new request</button>`;
}

// Run once the view they belong to is drawn, and only if it is.
const afterDraw = [];
let watching = 0;

/** Until the request is paid, or the listing changes, or the request expires: then says so. */
async function watchSale({ handle, owner, price, expiresAt }) {
  const mine = ++watching;
  const here = () => mine === watching && route() === `buy/${handle}` && checkout.method === "request";
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (!here()) return;
    if (Date.now() > expiresAt.getTime()) {
      $("#request-status").textContent = "The request has expired: make a new one to pay with it.";
      $("#request-again").hidden = false;
      return;
    }
    let entry;
    try {
      entry = await held(await readState(), handle);
    } catch {
      continue;
    }
    if (!here()) return;
    if (entry ? entry.owner === owner && entry.price === price : !owner) continue;
    if (entry && entry.owner !== owner) {
      toast(entry.owner === connected ? `@${handle} is yours.` : `@${handle} is bought, by ${shortID(entry.owner)}.`);
      location.hash = `#/@${handle}`;
    } else render(); // relisted at another price, or no longer for sale
    return;
  }
}

/** Hands Selfhold the request, from the click; then waits for the chain to show the name bought. */
async function payByRequest(handle, uri, owner) {
  const label = `Buying @${handle}`;
  if (acting.has(label)) return;
  acting.add(label);
  const progress = toast(`${label}: approve it in Selfhold.`);
  try {
    await window.lattice.openRequest(uri);
    progress.update(`${label}: confirming…`);
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const entry = await held(await readState(), handle).catch(() => undefined);
      if (entry && entry.owner !== owner) break;
      if (Date.now() > deadline) throw new Error("Sent, but not confirmed yet. It may still go through: look again in a minute.");
    }
    progress.update(`${label}: done.`);
    setTimeout(progress.close, 2500);
    location.hash = `#/@${handle}`;
  } catch (error) {
    progress.update(walletMessage(error), { bad: true });
  } finally {
    acting.delete(label);
  }
}

/** A name offered to your account: take it, for nothing. */
async function viewTake(handle, state) {
  const entry = await held(state, handle);
  if (entry && entry.owner === connected) return viewMessage(`@${handle} is yours`, "", `<a class="pill big" href="#/names" style="margin-top: 20px">Go to My names</a>`);
  if (!entry || entry.offer !== connected) {
    return viewMessage(`@${handle} isn't offered to you`, extension()
      ? `Selfhold connects account ${accountRef(connected)} here. If the gift is for another of your accounts, switch to it in Selfhold and open the link again.`
      : `Your account here is ${accountRef(connected)}. If the gift is for another of your accounts, open the link where that one is, or use its passkey in Selfhold's window.`);
  }
  return `
    <main class="col card" style="margin-top: 48px">
      <span class="badge">A gift</span>
      <h1 class="mono">@${esc(handle)}</h1>
      <p class="bio">Its owner is giving it to your account. Take it, and it's yours, pointing at your account.</p>
      <div class="stack" style="width: 100%; margin-top: 28px">
        <button class="pill accent big" type="button" data-take="${esc(handle)}">Take @${esc(handle)}</button>
      </div>
    </main>`;
}

/** The link a receiver opens to take an offered name. */
const takeLink = (hash) => `${location.origin}${location.pathname}${hash}`;

/** The names other accounts own that point at `account`. Reads all of `points/`. */
async function pointingAt(state, account) {
  const found = [];
  for await (const [key, value] of state.list("points/")) {
    if (value !== account) continue;
    const entry = await held(state, key.slice("points/".length));
    if (entry && entry.owner !== account && entry.pointer === account) found.push(entry);
  }
  return found;
}

/** My names: the handle your account shows, each name you own with a menu, names others point at you, and a form to claim another. */
async function viewNames(state) {
  const [mine, shows, named, lent] = await Promise.all([
    names.namesOf(state, connected),
    names.handleOf(state, connected),
    names.getField(state, connected, "name"),
    pointingAt(state, connected),
  ]);
  const said = shows
    ? `Your account is shown as <a class="mono" href="#/@${esc(shows)}">@${esc(shows)}</a>.`
    : named
      ? `Your account names @${esc(named)}, but it doesn't point at you, so no handle is shown.`
      : "Your account shows no handle. Point a name at it, then show it.";
  return `
    <main class="col" style="margin-top: 12px">
      <h1 style="margin: 0">My names</h1>
      <section class="panel stack section" aria-labelledby="account-title">
        <h2 id="account-title" style="margin: 0">Your account ${accountLink(connected)}</h2>
        <p id="shows" style="margin: 0">${said}</p>
        ${named ? `<button class="pill" type="button" data-stop-showing style="align-self: flex-start">Stop showing</button>` : ""}
      </section>
      <section class="section stack" aria-label="Your names">
        ${mine.map((n) => handleRow(n, `
          ${n.offer ? `<button class="pill" type="button" data-copy="${esc(takeLink(`#/take/${n.handle}`))}">Copy link<span class="sr"> to take @${esc(n.handle)}</span></button>` : ""}
          ${n.pointer === connected && n.handle !== shows ? showButton(n.handle) : ""}
          <button class="pill icon" type="button" data-name-menu="${esc(n.handle)}" aria-label="Options for @${esc(n.handle)}">⋯</button>`)).join("")
          || `<p class="note">No names yet.</p>`}
      </section>
      ${lent.length ? `
      <section class="section stack" aria-labelledby="lent-title">
        <h2 id="lent-title">Others' names pointing at you</h2>
        ${lent.map((n) => handleRow(n, n.handle === shows ? `<span class="label">shown</span>` : showButton(n.handle), `owned by ${accountRef(n.owner)}`)).join("")}
      </section>` : ""}
      <form id="claim-new" class="panel stack section" aria-labelledby="claim-title">
        <h2 id="claim-title" style="margin: 0">Claim a name</h2>
        <div class="field"><label for="new-handle">Name</label><input id="new-handle" class="mono" autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="yourname"></div>
        <button class="pill accent" type="submit" style="align-self: flex-start">Claim</button>
      </form>
    </main>`;
}

/** Names their owners are selling. */
async function viewMarket(state) {
  const sale = await names.forSale(state);
  return `
    <main class="col" style="margin-top: 12px">
      <h1 style="margin: 0">Names for sale</h1>
      <p class="lede" style="margin-top: 8px">Names their owners are selling. You pay the owner directly, in the same transaction.</p>
      <section class="section stack" aria-label="For sale">
        ${sale.map((h) => `
          <div class="row">
            <a class="mono" href="#/@${esc(h.handle)}">@${esc(h.handle)}</a>
            <div class="end">${h.owner === connected
              ? `<span class="label">yours · ${coins(h.price)}</span>`
              : `<span class="price">${coins(h.price)}</span><a class="pill dark" href="#/@${esc(h.handle)}" aria-label="See @${esc(h.handle)} for ${coins(h.price)}">See</a>`}</div>
          </div>`).join("") || `<p class="note">Nothing for sale right now. <a href="#/">Search for a name</a>: one no one owns costs 0.</p>`}
      </section>
    </main>`;
}

function viewSettings() {
  return `
    <div class="col top" style="justify-content: flex-start"><a class="pill icon" href="#/" aria-label="Back">‹</a></div>
    <main class="col" style="margin-top: 12px">
      <h1 style="margin: 0 0 20px">Settings</h1>
      ${accountSettings()}
      <form id="settings" class="panel stack">
        <div class="field"><label for="s-nodes">Nodes to read from, one per line; leave it empty for the hosts Nexus lists</label><textarea id="s-nodes" rows="3" placeholder="The hosts Nexus lists for the chain">${esc(settings.nodes.join("\n"))}</textarea></div>
        <div class="field"><label for="s-chain">Names chain</label><input id="s-chain" class="mono" value="${esc(settings.chain)}"></div>
        <div class="field"><label for="s-sponsor">Pay fees with this device's GPU, through this service; leave it empty to pay fees in coins</label><input id="s-sponsor" class="mono" value="${esc(settings.sponsor)}" placeholder="Fees paid in coins" autocomplete="off" spellcheck="false" autocapitalize="none"></div>
        ${window.lattice ? `<label class="check"><input type="checkbox" id="s-extension"${extension() ? " checked" : ""}> Use Selfhold for Chrome, not Selfhold's window</label>` : ""}
        <div style="display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap">
          <button class="pill" type="button" data-reset>Defaults</button>
          <button class="pill dark" type="submit">Save</button>
        </div>
      </form>
    </main>`;
}

/** Selfhold's window, in Settings: the account it gave this site, and disconnecting it here. */
function accountSettings() {
  const address = extension() ? null : connected;
  if (!address) return "";
  return `
      <section class="panel stack" aria-labelledby="account-settings" style="margin-bottom: 20px">
        <h2 id="account-settings" style="margin: 0">Selfhold</h2>
        <p style="margin: 0">Account ${accountLink(address)}, its key kept by your passkey.</p>
        <div style="display: flex; gap: 8px; flex-wrap: wrap">
          <button class="pill" type="button" data-copy="${esc(address)}">Copy account ID</button>
          <button class="pill" type="button" data-disconnect>Disconnect</button>
        </div>
      </section>`;
}

// ---------------------------------------------------------------- routing

function route() {
  try {
    return decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  } catch {
    return location.hash.replace(/^#\/?/, ""); // a malformed link: shown as typed, which nothing matches
  }
}
let drawing = 0;
let drawn = 0; // views shown so far
let used = null; // the control last pressed, as a selector, to focus again after a redraw

async function render() {
  const ticket = ++drawing;
  const r = route();
  const app = $("#app");
  try {
    let html;
    const [page, arg = ""] = r.split(/\/(.*)/s);
    // Old links: profiles are each app's now.
    if (["me", "profiles", "edit"].includes(page)) return void location.replace("#/names");
    if (page === "bought" && isHandle(arg)) return void location.replace(`#/@${arg}`);
    if (isAddress(r)) return void location.replace(`#/account/${r}`);
    if (r === "settings") html = viewSettings();
    else {
      // Selfhold connects only within a click, so ask now, before the read, if this render came from one.
      const needs = page === "names" || page === "take";
      if (needs && !connected && extension() && navigator.userActivation?.isActive) await connect();
      const state = await readState();
      // Your key is asked for only where it is needed.
      const take = isHandle(arg) ? `To take @${arg}` : "To take a name";
      if (needs && !connected && !extension()) {
        html = `<main class="col stack" style="margin-top: 24px">${accountPanel(page === "take" ? `${take}, make your account` : "Your names belong to your account's key", true)}</main>`;
      } else if (needs && !connected) {
        const why = page === "take" ? `${take}, connect Selfhold` : "Your names belong to your wallet's key";
        html = `<main class="col stack" style="margin-top: 24px">${connectPanel(why, true)}</main>`;
      } else if (r === "names") html = await viewNames(state);
      else if (page === "take" && isHandle(arg)) html = await viewTake(arg, state);
      else if (page === "buy" && isHandle(arg)) html = await viewBuy(arg, state);
      else if (r === "market") html = await viewMarket(state);
      else if (page === "search") {
        const q = asHandle(arg);
        html = isHandle(q) ? await viewSearch(q, state) : viewStart(q ? `“${arg}”: a name is lowercase letters, digits and _.` : "");
      } else if (page === "account" && isAddress(arg)) html = await viewAccount(arg, state);
      else if (r.startsWith("@") && isHandle(r.slice(1))) html = await viewSearch(r.slice(1), state, { near: false });
      else if (r === "") html = viewStart();
      else html = viewStart(`“${r}” is not a name or an account.`);
    }
    if (ticket !== drawing) return;
    app.innerHTML = header() + html + footer();
    for (const hook of afterDraw.splice(0)) if (hook.ticket === ticket) hook.run();
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
  } catch (error) {
    if (ticket !== drawing) return;
    app.innerHTML = `<main class="col"><h1 class="empty" role="alert">${esc(walletMessage(error))}</h1><p style="text-align: center"><button class="pill" type="button" data-retry>Try again</button> <a class="pill" href="#/settings">Settings</a></p></main>${footer()}`;
  }
}

// ---------------------------------------------------------------- events

document.addEventListener("click", async (event) => {
  const el = event.target.closest("button, a");
  if (!el) return;
  const d = el.dataset;
  // A choice in a sheet belongs to the control that opened it: keep that one.
  if (!el.closest("#sheet")) {
    const key = Object.keys(d).find((k) => k !== "price");
    used = key ? `[data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${CSS.escape(d[key])}"]` : null;
  }
  if ("retry" in d) {
    render();
  } else if ("connect" in d) {
    try {
      if (d.via === "web") await useWeb();
      await connect();
      render();
    } catch (error) {
      toast(walletMessage(error), { bad: true });
    }
  } else if ("disconnect" in d) {
    await web.disconnect();
    connected = null;
    render();
  } else if ("getWallet" in d) {
    awaiting(true);
    $("#wallet-wait")?.removeAttribute("hidden");
  } else if (d.openRequest) {
    payByRequest(checkout.handle, d.openRequest, d.owner);
  } else if (d.fund) {
    // Coins for the account in Selfhold's window, whichever wallet is in use.
    const address = await web.address();
    const funded = address && (await funds(address));
    if (funded) fundSheet({ address, needed: BigInt(d.fund), balance: funded.balance });
    else toast("No host answered for your account's balance.", { bad: true });
  } else if (d.copy) {
    navigator.clipboard?.writeText(d.copy).then(() => toast("Copied."), () => toast(d.copy));
  } else if ("reset" in d) {
    saveSettings({ walletPage: settings.walletPage });
    render();
  } else if (d.nameMenu) {
    // A menu reads the chain first: if no host answers, say so.
    await nameMenu(d.nameMenu).catch((error) => toast(walletMessage(error), { bad: true }));
  } else if (d.claim) {
    if (d.via === "web") await useWeb();
    if (!(await connectFirst(`claim @${d.claim}`))) return;
    const handle = d.claim;
    claim(handle);
  } else if (d.buy) {
    if (d.via === "web") await useWeb();
    if (!(await connectFirst(`buy @${d.buy}`))) return;
    const handle = d.buy;
    const shown = BigInt(d.price);
    act(
      `Buying @${handle}`,
      async (state, me) => {
        const entry = await held(state, handle);
        // Bought at the price shown, or not at all.
        if (entry?.price === undefined) throw new Error(`@${handle} was just taken, and it isn't for sale.`);
        if (entry.price !== shown) throw new Error(`The price of @${handle} just changed. Look again.`);
        return names.buy(state, me, handle, { point: true });
      },
      async (s, me) => (await held(s, handle))?.owner === me,
      () => (location.hash = `#/@${handle}`),
    );
  } else if (d.take) {
    if (!(await connectFirst(`take @${d.take}`))) return;
    const handle = d.take;
    act(`Taking @${handle}`, async (state, me) => {
      const entry = await held(state, handle);
      // Taken as a gift, for nothing, or not at all: never a purchase under "Take".
      if (entry?.offer !== me || entry.price !== undefined) throw new Error(`@${handle} isn't offered to you anymore. Look again.`);
      return names.buy(state, me, handle, { point: true });
    }, async (s, me) => (await held(s, handle))?.owner === me, () => {
      location.hash = `#/@${handle}`;
      render();
    });
  } else if (d.show) {
    const handle = d.show;
    act(`Showing @${handle}`, (s, me) => names.showName(s, me, handle), async (s, me) => (await names.handleOf(s, me)) === handle);
  } else if ("stopShowing" in d) {
    act("Showing no handle", (s, me) => names.stopShowing(s, me), async (s, me) => (await names.getField(s, me, "name")) === undefined);
  }
});

/** What can be done with a name of yours, chosen from a sheet. */
async function nameMenu(handle) {
  const state = await readState();
  const entry = await held(state, handle);
  if (entry?.owner !== connected) return render();
  const shown = (await names.handleOf(state, connected)) === handle;
  const terms = entry.price !== undefined || entry.offer;
  const said = [pointsLabel(entry), termsOf(entry)].filter(Boolean).join(" · ");
  const choice = await sheet({
    title: `@${handle}`,
    body: `${said[0].toUpperCase()}${said.slice(1)}.`,
    choices: [
      ...(shown ? [] : [{ value: "show", label: "Show this handle" }]),
      ...(entry.pointer === connected ? [] : [{ value: "me", label: "Point at me" }]),
      { value: "account", label: "Point at an account…" },
      ...(entry.pointer ? [{ value: "nowhere", label: "Stop pointing" }] : []),
      ...(terms
        ? [{ value: "keep", label: entry.offer ? "Take back the offer" : "Stop selling" }]
        : [{ value: "sell", label: "Sell" }, { value: "give", label: "Give to an account" }]),
      { value: "release", label: "Release", bad: true },
    ],
  });
  if (choice === "show") act(`Showing @${handle}`, (s, me) => names.showName(s, me, handle), async (s, me) => (await names.handleOf(s, me)) === handle);
  else if (choice === "me") pointAt(handle, connected);
  else if (choice === "account") await pointAtAccount(handle, entry);
  else if (choice === "nowhere") pointAt(handle, null);
  else if (choice === "keep") {
    act(entry.offer ? `Taking back the offer of @${handle}` : `Taking @${handle} off sale`, (s, me) => names.unlist(s, me, handle), async (s) => {
      const now = await held(s, handle);
      return now?.price === undefined && now?.offer === undefined;
    });
  } else if (choice === "sell") await sellHandle(handle);
  else if (choice === "give") await giveHandle(handle);
  else if (choice === "release") await releaseHandle(handle, entry);
}

/** Points a name of yours at account `to`, or nowhere when null. */
function pointAt(handle, to) {
  const where = to === null ? "nowhere" : to === connected ? "at you" : `at ${shortID(to)}`;
  act(`Pointing @${handle} ${where}`, (s, me) => names.pointName(s, me, handle, to), async (s) => (await names.pointer(s, handle)) === (to ?? undefined));
}

/** Points a name of yours at any account, by its ID. */
async function pointAtAccount(handle, entry) {
  const to = await sheet({
    title: `Point @${handle} at an account`,
    body: `That account shows @${handle} once it chooses to show it. You can point it elsewhere any time.`,
    input: { label: "Account ID", value: entry.pointer, attrs: 'autocomplete="off" spellcheck="false" autocapitalize="none" class="mono"', check: (v) => (isAddress(v) ? "" : "That is not an account ID.") },
    confirm: "Point it",
  });
  if (to === null) return;
  pointAt(handle, to);
}

async function sellHandle(handle) {
  const price = await sheet({
    title: `Sell @${handle}`,
    body: "Anyone can buy it at this price at once, without asking you. When it is bought it points at its buyer, so your account stops showing it.",
    input: { label: "Asking price", attrs: 'inputmode="numeric" pattern="[0-9]*" autocomplete="off"', check: priceProblem },
    confirm: "List it",
  });
  if (price === null) return;
  act(`Listing @${handle}`, (s, me) => names.list(s, me, handle, BigInt(price)), async (s) => (await held(s, handle))?.price === BigInt(price));
}

/** Gives a name to another account: it takes the name from a link you send. */
async function giveHandle(handle) {
  const to = await sheet({
    title: `Give @${handle}`,
    body: "Only the name moves, to the account you name. It takes it from a link you send; until then you can take it back.",
    input: { label: "Their account ID", attrs: 'autocomplete="off" spellcheck="false" class="mono"', check: (v) => (isAddress(v) ? (v === connected ? "That is your own account." : "") : "That is not an account ID.") },
    confirm: "Offer it",
  });
  if (to === null) return;
  act(`Offering @${handle}`, (s, me) => names.offerName(s, me, handle, to), async (s) => (await held(s, handle))?.offer === to, () => {
    navigator.clipboard?.writeText(takeLink(`#/take/${handle}`)).catch(() => {});
    toast("Offered. Link copied: send it to them.");
    render();
  });
}

async function releaseHandle(handle, entry) {
  const ok = await sheet({
    title: `Release @${handle}?`,
    body: `It stops being yours${entry.pointer ? ", and stops pointing at its account" : ""}. Anyone may claim it next, free. This can't be undone.`,
    confirm: `Release @${handle}`,
    danger: true,
  });
  if (!ok) return;
  act(`Releasing @${handle}`, (s, me) => names.release(s, me, handle), async (s) => (await held(s, handle)) === undefined);
}

/** Claims `handle` if it is still free, pointed at you. */
function claim(handle) {
  act(
    `Claiming @${handle}`,
    async (state, me) => {
      if (await held(state, handle)) throw new Error(`@${handle} was just taken.`);
      return names.claim(state, me, handle, { point: true });
    },
    async (s, me) => (await held(s, handle))?.owner === me,
    () => {
      location.hash = `#/@${handle}`;
      render();
    },
  );
}

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.id === "search") {
    event.preventDefault();
    const q = $("#q").value.trim();
    if (!q) return $("#q").focus();
    location.hash = `#/search/${encodeURIComponent(asHandle(q) || q)}`;
  } else if (form.id === "claim" || form.id === "claim-new") {
    event.preventDefault();
    const typed = form.id === "claim-new";
    const handle = typed ? asHandle($("#new-handle").value) : form.dataset.handle;
    if (!isHandle(handle)) return toast("A name is lowercase letters, digits and _.", { bad: true });
    Object.assign(checkout, { handle, method: null });
    location.hash = `#/buy/${handle}`;
  } else if (form.id === "settings") {
    event.preventDefault();
    const useExtension = $("#s-extension") ? $("#s-extension").checked : extension();
    const switched = useExtension !== extension();
    saveSettings({
      nodes: $("#s-nodes").value.split(/\s+/).filter(Boolean).map((n) => n.replace(/\/$/, "")),
      chain: $("#s-chain").value.trim() || DEFAULTS.chain,
      sponsor: $("#s-sponsor").value.trim().replace(/\/$/, ""),
      wallet: useExtension ? "extension" : "web",
      walletPage: settings.walletPage,
      walletChosen: settings.walletChosen || switched,
    });
    // Another wallet, another account: the one it remembers, if any, without asking.
    if (switched) connected = (await wallet().address?.().catch(() => null)) ?? null;
    toast("Settings saved.");
    location.hash = "#/";
  }
});

document.addEventListener("change", (event) => {
  const input = event.target;
  if (input.name !== "pay") return;
  checkout.method = input.value;
  used = `input[name="${input.name}"][value="${CSS.escape(input.value)}"]`;
  render();
});

// The request card carries the request into a wallet's tab, as Selfhold reads a drop.
document.addEventListener("dragstart", (event) => {
  const card = event.target.closest?.("[data-request]");
  if (!card || !event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("text/plain", card.dataset.request);
  event.dataTransfer.setData("text/uri-list", card.dataset.request);
});

window.addEventListener("hashchange", () => {
  used = null;
  scrollTo(0, 0);
  render();
});
// Back from adding Selfhold: reload, on the same address, so it reaches the page.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && awaiting() && !window.lattice) location.reload();
});
// Selfhold for Chrome announces itself when it reaches a page: it is the wallet now, if Settings or an old connection choose it.
window.addEventListener("lattice#initialized", async () => {
  awaiting(false);
  await adoptSelfhold();
  if (extension()) {
    try {
      connected = (await window.lattice.address?.()) ?? null;
    } catch {
      connected = null;
    }
  }
  render();
});
// A wallet already connected to this site answers without asking.
(async () => {
  try {
    await adoptSelfhold();
    connected = (await wallet().address?.()) ?? null;
  } catch {}
  if (window.lattice) awaiting(false);
  render();
})();
