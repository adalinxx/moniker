// Moniker: @names, read from the names chain by CID and written through the
// Selfhold wallet, which asks the owner to approve every change, or, without
// Selfhold, through the wallet in the page, whose key a passkey keeps. An account
// (a key) owns names, and points each at an account, any account. An account
// shows `@h` only while it names h and h points at it. Reading needs no wallet.
import * as sdk from "../sdk/vendor/lattice-sdk.js";
import * as names from "../sdk/src/records/names.mjs";
import { writeRequest } from "../sdk/src/records/wallet.mjs";
import { accountIcon, createMoniker, isAddress, isHandle, shortAccount } from "../sdk/src/index.mjs";
import { embeddedWallet } from "./wallet.mjs";

// ---------------------------------------------------------------- settings

const DEFAULTS = {
  // None named: reads go to the hosts Nexus lists for the chain.
  nodes: [],
  chain: "Nexus/moniker",
  // A fee sponsor paid in work, for accounts in the page's wallet with too few coins for the fee; "" for none.
  sponsor: "https://lattice-testnet-apps-iad.fly.dev:8650/sponsor",
  // "selfhold" uses Selfhold where it is installed; "page" uses the page's own wallet even so.
  wallet: "selfhold",
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
      wallet: saved.wallet === "page" ? "page" : DEFAULTS.wallet,
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
// the chain, and shows it for approval with the write; the page's wallet
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
const inPage = embeddedWallet({ hosts: () => client().hosts(), sponsor: () => settings.sponsor });
/** Selfhold where it is installed (unless Settings choose the page's wallet), else the page's own. */
const wallet = () => (settings.wallet !== "page" && window.lattice) || inPage;
const selfhold = () => wallet() !== inPage;

/**
 * Asks the wallet for this site's account: Selfhold's address, or the page's
 * account unlocked by its passkey. Both answer only within a click or key
 * press, so call it before any other wait.
 */
async function connect() {
  connected = await wallet().connect();
  return connected;
}

/**
 * Connects first if this site isn't connected, or the page's wallet is
 * locked; with no account in the page's wallet, offers to make one or sign
 * in. False (and says why) if that fails.
 */
async function connectFirst() {
  if (connected && (selfhold() || !inPage.locked())) return true;
  try {
    if (!selfhold() && !(await inPage.address())) return await startAccount();
    await connect();
    return true;
  } catch (error) {
    toast(walletMessage(error), { bad: true });
    return false;
  }
}

/** With no account in the page's wallet: makes one with a passkey, or signs in with one made before. */
async function startAccount() {
  const choice = await sheet({
    title: "Your account",
    body: "Your names belong to a key. A passkey keeps it for you, on this device and the others it syncs to, unlocked with your face, fingerprint or screen lock. Moniker never sees it.",
    choices: [
      { value: "create", label: "Create a passkey" },
      { value: "signin", label: "I have a passkey" },
    ],
  });
  if (choice === null) return false;
  return choice === "create" ? createAccount() : signIn();
}

/** A new account, kept by a new passkey (or by this browser, where passkeys can't keep one). */
async function createAccount() {
  const made = await inPage.create();
  connected = made.address;
  if (made.kind === "browser") await keptHere();
  return true;
}

/**
 * Says, where it can't be missed, that the account's key is kept in this
 * browser only, offering it to copy: a toast would give way to the write's own.
 */
async function keptHere() {
  const choice = await sheet({
    title: "Your key is kept in this browser only",
    body: "This browser's passkeys can't keep a key, so your account's key is kept here. Clear this browser's data and the account and its names are gone. Copy the key and keep it somewhere safe; Settings has it too.",
    choices: [
      { value: "copy", label: "Copy the key" },
      { value: "go", label: "Continue" },
    ],
  });
  if (choice === "copy" && !(await copyKey())) {
    await sheet({ title: "Couldn't copy the key", body: "Copy it from Settings before you rely on this account.", confirm: "OK" });
  }
}

/** Copies the page's browser-kept key, saying so; whether it was copied. */
async function copyKey() {
  const key = inPage.exportKey();
  try {
    await navigator.clipboard.writeText(key);
  } catch {
    return false;
  }
  toast("Key copied. Keep it somewhere safe, and never share it.");
  return true;
}

/** The account a passkey made here before. */
async function signIn() {
  connected = await inPage.signIn();
  return true;
}

function walletMessage(error) {
  const text = String(error?.message ?? error);
  if (/just declined|ask again in a moment/i.test(text)) return "The wallet waits a few seconds after a decline. Try again in a moment.";
  if (/declined|rejected|denied/i.test(text)) return "You declined it in the wallet. Nothing was sent.";
  if (/locked/i.test(text)) return selfhold() ? "Unlock Selfhold, then try again." : "Use your passkey, then try again.";
  return text;
}

// The wallet takes one request from a page at a time.
let walletTurn = Promise.resolve();
/** Sends `write`, built for account `me`, through the wallet; the page's wallet tells `progress` what it is doing. */
function send(write, me, progress = () => {}) {
  const turn = walletTurn.then(async () => {
    // A write is built for one account. If Selfhold was since disconnected
    // from this site, or connected to another account, say so and send nothing.
    const now = await wallet().address();
    if (now !== me) {
      connected = now;
      render();
      if (!selfhold()) throw new Error("This page's account changed. Look again, then try again.");
      throw new Error(now ? "Selfhold now connects this site to a different account. Look again, then try again." : "Selfhold isn't connected to this site anymore. Connect again, then try again.");
    }
    return selfhold() ? wallet().writeRecords(writeRequest(chainPath(), write)) : inPage.writeRecords(writeRequest(chainPath(), write), { progress });
  });
  walletTurn = turn.catch(() => {});
  return turn;
}

/**
 * Builds a write on a fresh state (`build(state, me)`), sends it, then waits
 * until the chain shows it (`landed(state, me)`), so the page redraws from
 * what the chain holds, not from what was asked.
 */
async function act(label, build, landed, done = render) {
  const me = connected;
  const progress = toast(selfhold() ? `${label}: approve it in your wallet.` : `${label}…`);
  try {
    // The page's key, locked since the page loaded: its passkey unlocks it, now, while the click still counts.
    if (!selfhold() && inPage.locked()) {
      progress.update(`${label}: use your passkey.`);
      await connect();
    }
    const write = await build(await readState(), me);
    if (write.actions.length === 0) {
      progress.update(`${label}: it is so already.`);
      setTimeout(progress.close, 2500);
      return;
    }
    await send(write, me, (text) => progress.update(`${label}: ${text}`));
    progress.update(`${label}: waiting for the block…`);
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      try {
        if (await landed(await readState(), me)) break;
      } catch {}
      if (Date.now() > deadline) throw new Error("Sent, but no block has shown it yet. It may still land.");
    }
    progress.update(`${label}: done.`);
    setTimeout(progress.close, 2500);
    done();
  } catch (error) {
    if (error.name !== "NeedsCoins") return progress.update(walletMessage(error), { bad: true });
    progress.close();
    fundSheet(error);
  }
}

/** The page's account can't pay for a write: what it needs, and where to send coins. */
async function fundSheet({ address, needed, balance, sponsorTooDear }) {
  const sponsorNote = sponsorTooDear
    ? " The fee sponsor asks more work for it than this device can do in reasonable time."
    : settings.sponsor ? "" : " Or name a fee sponsor in Settings: it pays fees for a little of this device's work.";
  const copy = await sheet({
    title: "Add coins to your account",
    body: `This needs ${coins(needed)} ${needed === 1n ? "coin" : "coins"}, and your account holds ${coins(balance)}. Send coins on ${settings.chain} to your account ID, ${address}, then try again.${sponsorNote}`,
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
function sheet({ title, body = "", confirm, input, choices, danger = false }) {
  const dialog = $("#sheet");
  dialog.setAttribute("aria-describedby", "sheet-body");
  dialog.innerHTML = `
    <form method="dialog">
      <h2 id="sheet-title">${esc(title)}</h2>
      <p id="sheet-body">${esc(body)}</p>
      ${input ? `<div class="field"><label for="sheet-input">${esc(input.label)}</label><input id="sheet-input" ${input.attrs ?? ""} value="${esc(input.value ?? "")}" required></div>` : ""}
      ${choices ? `<div class="choices">${choices.map((c) => `<button class="pill${c.bad ? " bad" : ""}" value="choice:${esc(c.value)}" type="submit" formnovalidate>${esc(c.label)}</button>`).join("")}</div>` : ""}
      <p id="sheet-error" role="alert" style="color: var(--bad); margin: 0 0 12px"></p>
      <div class="actions">
        <button class="pill" type="button" data-sheet-cancel>Cancel</button>
        ${choices ? "" : `<button class="pill ${danger ? "danger" : "dark"}" value="ok" type="submit">${esc(confirm)}</button>`}
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
    // Cancel is no submit button, so Enter in the input submits the confirm.
    $("[data-sheet-cancel]", dialog).onclick = () => dialog.close("cancel");
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

/** Claiming a free name: an optional price to list it at once, and Claim. */
function claimForm(handle) {
  return `
    <form id="claim" class="stack" data-handle="${esc(handle)}" style="width: 100%">
      <div class="field">
        <label for="claim-price">Sell it right away at (optional)</label>
        <input id="claim-price" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="Not for sale">
      </div>
      <label class="check"><input type="checkbox" id="claim-show"> Show it as my handle</label>
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
    end = `<span class="price big">${coins(exact.price)}</span><button class="pill accent" type="button" data-buy="${esc(q)}" data-price="${exact.price}">Buy @${esc(q)} for ${coins(exact.price)}</button>`;
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

/** Where a key is needed and there is no account yet: a passkey makes one, or brings back one made before; or Selfhold. */
function accountPanel(why, alone = false) {
  const selfholdLink = phone ? "" : `
    <p class="note" style="margin: 0">Rather keep your key in a browser extension? <a href="${WALLET_URL}" target="_blank" rel="noopener" data-get-wallet>Add Selfhold${chromium ? "" : " for Chrome"}</a>, then come back to this tab.</p>
    <p class="note" id="wallet-wait" aria-live="polite" style="margin: 0"${awaiting() ? "" : " hidden"}>Waiting for Selfhold… When it's set up, come back to this tab.</p>`;
  return `
    <section class="panel stack" aria-labelledby="get-wallet" style="width: 100%">
      <h${alone ? 1 : 2} id="get-wallet">${esc(why)}</h${alone ? 1 : 2}>
      <p class="lede" style="margin: 0">Your names belong to a key. A passkey keeps it for you, on this device and the others it syncs to, unlocked with your face, fingerprint or screen lock. Moniker never sees it.</p>
      <button class="pill accent big" type="button" data-create-account>Create a passkey</button>
      <button class="pill big" type="button" data-sign-in>I have a passkey</button>
      ${selfholdLink}
    </section>`;
}

/** Where a key is needed, Selfhold is here, and this site isn't connected yet: one click asks it. */
function connectPanel(why, alone = false) {
  return `
    <section class="panel stack" aria-labelledby="connect">
      <h${alone ? 1 : 2} id="connect">${esc(why)}</h${alone ? 1 : 2}>
      <p class="lede" style="margin: 0">Selfhold asks you first. Moniker sees only your address, never your key.</p>
      <button class="pill accent big" type="button" data-connect>Connect Selfhold</button>
    </section>`;
}

/** A name offered to your account: take it, for nothing. */
async function viewTake(handle, state) {
  const entry = await held(state, handle);
  if (entry && entry.owner === connected) return viewMessage(`@${handle} is yours`, "", `<a class="pill big" href="#/names" style="margin-top: 20px">Go to My names</a>`);
  if (!entry || entry.offer !== connected) {
    return viewMessage(`@${handle} isn't offered to you`, selfhold()
      ? `Selfhold connects account ${accountRef(connected)} here. If the gift is for another of your accounts, switch to it in Selfhold and open the link again.`
      : `Your account here is ${accountRef(connected)}. If the gift is for another of your accounts, open the link where that one is.`);
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
        <div class="field"><label for="new-price">Sell it right away at (optional)</label><input id="new-price" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="Not for sale"></div>
        <label class="check"><input type="checkbox" id="new-show"> Show it as my handle</label>
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
      <form id="settings" class="panel stack">
        <div class="field"><label for="s-nodes">Nodes to read from, one per line; leave it empty for the hosts Nexus lists</label><textarea id="s-nodes" rows="3" placeholder="The hosts Nexus lists for the chain">${esc(settings.nodes.join("\n"))}</textarea></div>
        <div class="field"><label for="s-chain">Names chain</label><input id="s-chain" class="mono" value="${esc(settings.chain)}"></div>
        <div class="field"><label for="s-sponsor">Fee sponsor, paid in this device's work when your account has too few coins for a fee; leave it empty for none</label><input id="s-sponsor" class="mono" value="${esc(settings.sponsor)}" placeholder="No sponsor" autocomplete="off" spellcheck="false" autocapitalize="none"></div>
        ${window.lattice ? `<label class="check"><input type="checkbox" id="s-page-wallet"${settings.wallet === "page" ? " checked" : ""}> Use this page's passkey wallet, not Selfhold</label>` : ""}
        <div style="display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap">
          <button class="pill" type="button" data-reset>Defaults</button>
          <button class="pill dark" type="submit">Save</button>
        </div>
      </form>
      ${accountSettings()}
    </main>`;
}

/** The page's wallet, in Settings: its account, how its key is kept, and forgetting it here. */
function accountSettings() {
  const address = selfhold() ? null : connected;
  if (!address) return "";
  const browserKey = inPage.kind() === "browser";
  return `
      <section class="panel stack section" aria-labelledby="account-settings">
        <h2 id="account-settings" style="margin: 0">This page's wallet</h2>
        <p style="margin: 0">Account ${accountLink(address)}, ${browserKey ? "its key kept in this browser only" : "its key kept by your passkey"}.</p>
        ${browserKey ? `<p class="note" style="margin: 0">Lose this browser's data and you lose the account, unless you keep a copy of its key.</p>` : ""}
        <div style="display: flex; gap: 8px; flex-wrap: wrap">
          ${browserKey && !inPage.locked() ? `<button class="pill" type="button" data-copy-key>Copy the key</button>` : ""}
          <button class="pill${browserKey ? " bad" : ""}" type="button" data-forget-account>Forget this account here</button>
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
    // Old links: profiles are each app's now, and buying is on the name's page.
    if (["me", "profiles", "edit"].includes(page)) return void location.replace("#/names");
    if (["buy", "bought"].includes(page) && isHandle(arg)) return void location.replace(`#/@${arg}`);
    if (isAddress(r)) return void location.replace(`#/account/${r}`);
    if (r === "settings") html = viewSettings();
    else {
      // Selfhold connects only within a click, so ask now, before the read, if this render came from one.
      const needs = page === "names" || page === "take";
      if (needs && !connected && selfhold() && navigator.userActivation?.isActive) await connect();
      const state = await readState();
      // Your key is asked for only where it is needed.
      const take = isHandle(arg) ? `To take @${arg}` : "To take a name";
      if (needs && !connected && !selfhold()) {
        html = `<main class="col stack" style="margin-top: 24px">${accountPanel(page === "take" ? `${take}, make your account` : "Your names belong to your account's key", true)}</main>`;
      } else if (needs && !connected) {
        const why = page === "take" ? `${take}, connect Selfhold` : "Your names belong to your wallet's key";
        html = `<main class="col stack" style="margin-top: 24px">${connectPanel(why, true)}</main>`;
      } else if (r === "names") html = await viewNames(state);
      else if (page === "take" && isHandle(arg)) html = await viewTake(arg, state);
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
  } else if ("connect" in d || "createAccount" in d || "signIn" in d) {
    try {
      if ("createAccount" in d) await createAccount();
      else if ("signIn" in d) await signIn();
      else await connect();
      render();
    } catch (error) {
      toast(walletMessage(error), { bad: true });
    }
  } else if ("copyKey" in d) {
    if (!(await copyKey())) toast("Couldn't copy the key.", { bad: true });
  } else if ("forgetAccount" in d) {
    const browserKey = inPage.kind() === "browser";
    const ok = await sheet({
      title: "Forget this account here?",
      body: browserKey
        ? "Its key is kept only in this browser: unless you copied it, the account and its names are gone for good."
        : "Your passkey keeps the account: use I have a passkey to bring it back.",
      confirm: "Forget it",
      danger: browserKey,
    });
    if (!ok) return;
    inPage.forget();
    connected = null;
    render();
  } else if ("getWallet" in d) {
    awaiting(true);
    $("#wallet-wait")?.removeAttribute("hidden");
  } else if (d.copy) {
    navigator.clipboard?.writeText(d.copy).then(() => toast("Copied."), () => toast(d.copy));
  } else if ("reset" in d) {
    saveSettings({});
    render();
  } else if (d.nameMenu) {
    // A menu reads the chain first: if no host answers, say so.
    await nameMenu(d.nameMenu).catch((error) => toast(walletMessage(error), { bad: true }));
  } else if (d.buy) {
    if (!(await connectFirst())) return;
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
    );
  } else if (d.take) {
    if (!(await connectFirst())) return;
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

/** Claims `handle` if it is still free, pointed at you, for sale at `price` if one was typed, and shown as your handle with `show`. */
function claim(handle, price, show) {
  act(
    `Claiming @${handle}`,
    async (state, me) => {
      if (await held(state, handle)) throw new Error(`@${handle} was just taken.`);
      return names.claim(state, me, handle, { price: price === "" ? undefined : BigInt(price), point: true, show });
    },
    async (s, me) => (await held(s, handle))?.owner === me && (!show || (await names.handleOf(s, me)) === handle),
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
    const price = (typed ? $("#new-price") : $("#claim-price")).value.trim();
    const show = (typed ? $("#new-show") : $("#claim-show")).checked;
    if (!isHandle(handle)) return toast("A name is lowercase letters, digits and _.", { bad: true });
    if (price && priceProblem(price)) return toast(`The price: ${priceProblem(price)}`, { bad: true });
    if (!(await connectFirst())) return;
    claim(handle, price, show);
  } else if (form.id === "settings") {
    event.preventDefault();
    const pageWallet = $("#s-page-wallet") ? $("#s-page-wallet").checked : settings.wallet === "page";
    const switched = pageWallet !== (settings.wallet === "page");
    saveSettings({
      nodes: $("#s-nodes").value.split(/\s+/).filter(Boolean).map((n) => n.replace(/\/$/, "")),
      chain: $("#s-chain").value.trim() || DEFAULTS.chain,
      sponsor: $("#s-sponsor").value.trim().replace(/\/$/, ""),
      wallet: pageWallet ? "page" : "selfhold",
    });
    // Another wallet, another account: the one it remembers, if any, without asking.
    if (switched) connected = (await wallet().address?.().catch(() => null)) ?? null;
    toast("Settings saved.");
    location.hash = "#/";
  }
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
// Selfhold announces itself when it reaches a page: it is the wallet now, unless Settings choose the page's.
window.addEventListener("lattice#initialized", async () => {
  awaiting(false);
  if (selfhold()) {
    try {
      connected = (await window.lattice.address?.()) ?? null;
    } catch {
      connected = null;
    }
  }
  render();
});
// A wallet already connected to this site, or the page's account, answers without asking.
(async () => {
  try {
    connected = (await wallet().address?.()) ?? null;
  } catch {}
  if (window.lattice) awaiting(false);
  render();
})();
