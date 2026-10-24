// Moniker, the names manager, through the real page in headless Chromium with
// the Lattice Wallet installed, against a private stack (stack.mjs). The
// person here approves whatever the wallet asks.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js \
//   LATTICE_WALLET=<lattice-wallet>/dist npm test
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, test as nodeTest } from "node:test";
import { chromium, expect as baseExpect } from "@playwright/test";
import * as names from "../../sdk/src/records/names.mjs";
import { tip, view, volumeLoader } from "../../sdk/src/records/state.mjs";
import { transaction } from "../../sdk/src/records/wallet.mjs";
import { CHAIN, start } from "./stack.mjs";

const wallet = process.env.LATTICE_WALLET && fileURLToPath(new URL(process.env.LATTICE_WALLET, `file://${process.cwd()}/`));
if (!wallet) throw new Error("LATTICE_WALLET: the built Lattice Wallet extension (its dist/ directory)");
// The wallet as installed by someone who runs the stack's node.
const walletInstalled = mkdtempSync(`${tmpdir()}/moniker-ui-wallet-`);
cpSync(wallet, walletInstalled, { recursive: true });
const manifest = JSON.parse(readFileSync(`${walletInstalled}/manifest.json`, "utf8"));
// A build that skipped the SDK step has no scripts; say so, not "no service worker" 30s later.
const scripts = [manifest.background?.service_worker, ...(manifest.content_scripts ?? []).flatMap((c) => c.js ?? [])].filter(Boolean);
const absent = scripts.filter((file) => !existsSync(`${walletInstalled}/${file}`));
if (absent.length) throw new Error(`LATTICE_WALLET is an incomplete build, missing ${absent.join(", ")}: build it with npm ci, then npm run build`);
manifest.host_permissions = [...manifest.host_permissions, "http://127.0.0.1/*"];
writeFileSync(`${walletInstalled}/manifest.json`, JSON.stringify(manifest));

const sdk = await import(process.env.LATTICE_SDK);
const running = await start();
const stack = running.info;
writeFileSync(new URL("./.stack.json", import.meta.url), JSON.stringify(stack));

let browser;
before(async () => (browser = await chromium.launch()));
after(async () => {
  await browser?.close();
  await running.stop();
});

const expect = baseExpect.configure({ timeout: 120_000 });

// ---------------------------------------------------------------- accounts

function newAccount() {
  const key = sdk.generatePrivateKey();
  return { address: sdk.accountFromPrivateKey(key).address, keyHex: Buffer.from(key).toString("hex"), key };
}
const minerAccount = { address: stack.miner, key: Uint8Array.from(Buffer.from(stack.minerKey, "hex")) };

async function account(address) {
  const r = await fetch(`${stack.node}/api/state/account/${address}?chainPath=${stack.chain}`);
  return r.ok ? r.json() : {};
}
const balance = async (address) => BigInt((await account(address)).balance ?? 0);
async function until(label, condition, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await condition().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
async function submit(from, body) {
  const { publicKey, signature } = sdk.signTransactionBody(body, from.key);
  // The node may be busy (429), or its tip may move under the check (503
  // contextChanged), which goes on: try again, and once it was answered so,
  // a later refusal may be the first attempt having landed; the caller waits
  // for the write either way.
  let moved = false;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${stack.node}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
    });
    if (r.ok) return;
    const text = await r.text();
    moved ||= /contextChanged/.test(text);
    if ((r.status === 429 || r.status === 503) && attempt < 30) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    if (moved) return;
    throw new Error(`submit: ${r.status} ${text}`);
  }
}
async function fund(to, amount = 2000n) {
  const nonce = BigInt((await account(stack.miner)).nonce ?? 0);
  await submit(minerAccount, sdk.buildTransfer({ from: stack.miner, to, amount, fee: 1n, nonce, chainPath: CHAIN }));
  await until("funds", async () => (await balance(to)) >= amount);
}
async function state() {
  const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${stack.node}/volumes`, { chainPath: CHAIN }));
  const { generalStateCID } = await tip(sdk, stack.node, CHAIN, volumes);
  return view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID);
}
const held = async (handle) => names.resolve(await state(), handle);

/** Writes as another client would, signing with the key directly. */
async function writeAs(who, write) {
  const nonce = BigInt((await account(who.address)).nonce ?? 0);
  await submit(who, transaction({ owner: who.address, ...write, fee: 1n, nonce, chainPath: CHAIN }));
}

/** `who` claims `handle` as another client would, pointed at `point` (an account, or true for itself) if given, for sale at `price` if given. */
async function claimAs(who, handle, { point, price } = {}) {
  if ((await balance(who.address)) < 10n) await fund(who.address, 100n);
  await writeAs(who, await names.claim(await state(), who.address, handle, { price, point }));
  await until(`@${handle}`, async () => (await held(handle))?.owner === who.address);
}

// ---------------------------------------------------------------- browser

/**
 * A browser with the wallet installed; each approval window is answered, and
 * counted: Connect or Sign, or Decline while `context.answer` is "decline".
 */
async function walletBrowser() {
  const context = await chromium.launchPersistentContext(mkdtempSync(`${tmpdir()}/moniker-ui-browser-`), {
    headless: false,
    args: ["--headless=new", `--disable-extensions-except=${walletInstalled}`, `--load-extension=${walletInstalled}`],
  });
  const [worker] = context.serviceWorkers().length ? context.serviceWorkers()
    : [await context.waitForEvent("serviceworker").catch(async (error) => { await context.close(); throw error; })];
  context.walletOrigin = worker.url().split("/").slice(0, 3).join("/");
  context.approvals = 0;
  context.declines = 0;
  context.answer = "approve";
  context.walletNotes = []; // what a wallet window said when its button never woke
  context.on("page", (opened) => respond(opened).catch(() => {}));
  async function respond(opened) {
    await opened.waitForLoadState().catch(() => {});
    if (!opened.url().includes("/approve/index.html")) return;
    // The approving button wakes only in a focused window, once everything
    // that decides the request has been seen: as a person, look, then press.
    await opened.bringToFront();
    if (context.answer === "decline") {
      await opened.getByRole("button", { name: "Decline" }).click();
      context.declines += 1;
      return;
    }
    const approve = opened.getByRole("button", { name: /^(Connect|Sign write|Sign message|Pay .+)$/ });
    const rest = opened.getByRole("button", { name: /^See the rest/ });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(await approve.isEnabled().catch(() => false))) {
      if (await rest.isVisible().catch(() => false)) await rest.click().catch(() => {});
      await opened.waitForTimeout(250);
    }
    if (!(await approve.isEnabled().catch(() => false))) {
      const why = await opened.locator("body").innerText().catch(() => "?");
      context.walletNotes.push(why.replace(/\s+/g, " ").slice(0, 400));
      return;
    }
    await approve.click();
    context.approvals += 1;
  }
  return context;
}

/** The browser's wallet holds `who`'s key, with the stack's node as its node. */
async function walletHolds(context, who) {
  const page = await context.newPage();
  await page.goto(`${context.walletOrigin}/popup/index.html`);
  const created = await page.evaluate((privHex) => chrome.runtime.sendMessage({ type: "createWallet", password: "moniker-test", privHex }), who.keyHex);
  await page.evaluate(async (url) => {
    const { settings } = await chrome.storage.local.get("settings");
    const endpoints = { ...(settings?.endpoints ?? {}), Nexus: { url, acceptsSubmit: true, source: "user" } };
    await chrome.storage.local.set({ settings: { ...settings, nodeMode: "custom", endpoints } });
  }, stack.node);
  if (!created?.ok) throw new Error(`wallet setup: ${created?.error}`);
  await page.close();
}

/** Selfhold forgets this site, as when the person disconnects it in the wallet. */
async function walletForgetsSite(context) {
  const page = await context.newPage();
  await page.goto(`${context.walletOrigin}/popup/index.html`);
  await page.evaluate(async (origin) => {
    const { connections = {} } = await chrome.storage.local.get("connections");
    delete connections[origin];
    await chrome.storage.local.set({ connections });
  }, new URL(stack.app).origin);
  await page.close();
}

/** Opens the app pointed at the stack, as `who` (connected through the wallet) or as a visitor. */
async function openApp(page, who, hash = "#/", seed = { nodes: [stack.node], chain: stack.chain }) {
  await page.addInitScript((settings) => {
    if (sessionStorage.getItem("moniker-test-seeded")) return;
    sessionStorage.setItem("moniker-test-seeded", "1");
    localStorage.setItem("moniker.settings", JSON.stringify(settings));
  }, seed);
  // Playwright's own clicks and reads count as the person acting, so Selfhold
  // would let a page connect at any time here. As in a page someone just
  // opened, the app sees no recent click, and must ask only from one.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userActivation", { value: { isActive: false, hasBeenActive: false } });
  });
  if (who) await walletHolds(page.context(), who);
  await page.goto(stack.app + (who ? "#/names" : hash));
  if (who) {
    // My names asks for nothing on the way in: it offers to connect.
    const before = page.context().approvals;
    await page.getByRole("button", { name: "Connect Selfhold" }).click();
    await expect(page.getByRole("heading", { name: "My names" })).toBeVisible();
    expect(page.context().approvals).toBe(before + 1);
    if (hash !== "#/names") await page.goto(stack.app + hash);
  }
}

/** A test with a fresh browser and page; on failure, what the page showed. */
const test = (name, body, { wallet: withWallet = true, expectedErrors, timeout = 300_000 } = {}) =>
  nodeTest(name, { timeout }, async () => {
    const context = withWallet ? await walletBrowser() : await browser.newContext();
    const page = context.pages()[0] ?? (await context.newPage());
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && !expectedErrors?.test(message.text()) && errors.push(message.text()));
    try {
      await body({ page });
      if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
    } catch (error) {
      const shown = await page.locator("#app").innerText().catch(() => "(no page)");
      const said = await page.locator("#toasts, #alerts").allInnerTexts().catch(() => []);
      error.message += `\n--- page at ${page.url()}:\n${shown.slice(0, 800)}\n--- status: ${said.join(" ") || "none"}\n--- wallet approvals: ${context.approvals ?? "n/a"}\n--- wallet said: ${context.walletNotes?.join(" || ") || "none"}\n--- page errors: ${errors.join(" | ") || "none"}`;
      throw error;
    } finally {
      await context.close();
    }
  });

/** In a browser of its own, as `who`. */
async function asOther(who, hash, body) {
  const context = await walletBrowser();
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await openApp(page, who, hash);
    await body(page);
  } finally {
    await context.close();
  }
}

const toast = (page, text) => page.locator(".toast", { hasText: text });
/** The row of `@handle` within `scope`, a page or a part of one. */
const row = (scope, handle) => scope.locator(".row", { has: (scope.page?.() ?? scope).getByRole("link", { name: `@${handle}`, exact: true }) });
const sheetButton = (page, name) => page.locator("#sheet").getByRole("button", { name, exact: true });

/** Opens a name's menu on My names and picks `choice`. */
async function menu(page, handle, choice) {
  await page.getByRole("button", { name: `Options for @${handle}`, exact: true }).click();
  await sheetButton(page, choice).click();
}
/** Types `value` into the open sheet, if any, and presses `confirm`. */
async function answerSheet(page, value, confirm) {
  if (value !== undefined) await page.locator("#sheet-input").fill(value);
  await sheetButton(page, confirm).click();
}

// ---------------------------------------------------------------- tests

const alice = newAccount();
const bob = newAccount();
const carol = newAccount();

test("a visitor searches: a name no one owns costs 0, and reading needs no wallet", async ({ page }) => {
  await openApp(page, null, "#/");
  await expect(page.locator("h1")).toHaveText("Own your name on the internet.");
  await page.locator("#q").fill("@No Body");
  await page.getByRole("button", { name: "Search" }).click();
  // Searched as a handle: lowercase, no @ or spaces.
  await expect(page).toHaveURL(/#\/search\/nobody$/);
  await expect(page.locator(".result .badge")).toHaveText("Available");
  await expect(page.locator(".result")).toContainText("No one owns it yet, so it costs 0.");
  // No wallet: how to add Selfhold, in place of Claim.
  await expect(page.locator("#get-wallet")).toHaveText("To claim @nobody, add Selfhold");
  await expect(page.getByRole("button", { name: "Claim @nobody" })).toHaveCount(0);
  // Names close to it, each free.
  await expect(page.getByRole("link", { name: "Claim @nobody_ for 0" })).toBeVisible();
  await page.goto(stack.app + "#/@nobody");
  await expect(page.locator(".result .badge")).toHaveText("Available");
  await page.goto(stack.app + "#/search/no!body");
  await expect(page.locator("#search-note")).toContainText("a name is lowercase letters, digits and _.");

  const store = page.waitForEvent("popup");
  await page.goto(stack.app + "#/search/nobody");
  await page.getByRole("link", { name: /^Add Selfhold/ }).click();
  await (await store).close();
  await expect(page.locator("#wallet-wait")).toBeVisible();
  // Where a key is needed, the same panel instead of an error; old links go there too.
  await page.goto(stack.app + "#/profiles");
  await expect(page).toHaveURL(/#\/names$/);
  await expect(page.locator("#get-wallet")).toHaveText("Your names belong to your wallet's key");

  // A phone can't add Selfhold: it is offered the link to finish on a computer.
  const phone = await browser.newContext({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" });
  const p = await phone.newPage();
  await openApp(p, null, "#/@nobody");
  await expect(p.getByRole("button", { name: "Copy this page's link" })).toBeVisible();
  await expect(p.getByRole("link", { name: /^Add Selfhold/ })).toHaveCount(0);
  await phone.close();
}, { wallet: false });

const short = (who) => `${who.address.slice(7, 11)}…${who.address.slice(-6)}`;

test("Alice claims @alice from a search, pointed at her, in one approval, then shows it", async ({ page }) => {
  await fund(alice.address);
  await openApp(page, alice, "#/search/alice");
  await expect(page.locator(".result .badge")).toHaveText("Available");
  await expect(page.locator(".result")).toContainText("It points at your account");
  const asked = page.context().approvals;
  await page.getByRole("button", { name: "Claim @alice" }).click();
  await expect(page).toHaveURL(/#\/@alice$/);
  await expect(page.locator(".result .badge")).toHaveText("Yours");
  await expect(page.locator(".owned")).toHaveText("Owned by you");
  await expect(page.locator("#points")).toHaveText("Points at you · not shown there");
  expect(page.context().approvals).toBe(asked + 1);
  const entry = await held("alice");
  expect([entry.owner, entry.price, entry.pointer]).toEqual([alice.address, undefined, alice.address]);
  // Show this handle, from the name's page.
  await page.getByRole("button", { name: "Show this handle @alice" }).click();
  await expect(page.locator("#points")).toHaveText("Points at you · shown as @alice");
  await expect(page.getByRole("button", { name: "Show this handle @alice" })).toHaveCount(0);
  expect(await names.handleOf(await state(), alice.address)).toBe("alice");
  await page.getByRole("link", { name: "Go to My names" }).click();
  await expect(page.locator("#shows")).toHaveText("Your account is shown as @alice.");
  await expect(row(page, "alice").locator(".label")).toHaveText("points at you");
});

test("Alice points @alice_lend at Bob's account, Bob shows it, and it stops showing once she points it away", async ({ page }) => {
  await fund(bob.address);
  await claimAs(alice, "alice_lend", { point: true });
  await openApp(page, alice, "#/names");
  await menu(page, "alice_lend", "Point at an account…");
  await answerSheet(page, "bafy-nope", "Point it");
  await expect(page.locator("#sheet-error")).toHaveText("That is not an account ID.");
  await answerSheet(page, bob.address, "Point it");
  await expect(row(page, "alice_lend").locator(".label")).toHaveText(`points at ${short(bob)}`);

  await asOther(bob, "#/names", async (bobPage) => {
    const lent = bobPage.locator("section", { has: bobPage.getByRole("heading", { name: "Others' names pointing at you" }) });
    await expect(row(lent, "alice_lend").locator(".label")).toHaveText(`owned by ${short(alice)}`);
    await lent.getByRole("button", { name: "Show this handle @alice_lend" }).click();
    await expect(bobPage.locator("#shows")).toHaveText("Your account is shown as @alice_lend.");
    await expect(row(lent, "alice_lend").locator(".end")).toHaveText("shown");
  });
  expect(await names.handleOf(await state(), bob.address)).toBe("alice_lend");
  // A visitor sees where it points, linked to Bob's account, and that Bob shows it.
  const visitor = await browser.newPage();
  await openApp(visitor, null, "#/@alice_lend");
  await expect(visitor.locator("#points")).toHaveText(`Points at ${short(bob)} · shown as @alice_lend`);
  await visitor.getByRole("link", { name: short(bob) }).click();
  await expect(visitor).toHaveURL(new RegExp(`#/account/${bob.address}$`));
  await expect(visitor.locator(".shows")).toHaveText("Shown as @alice_lend");
  await visitor.close();

  // Alice points it back at herself: Bob's account stops showing it.
  await menu(page, "alice_lend", "Point at me");
  await expect(row(page, "alice_lend").locator(".label")).toHaveText("points at you");
  expect(await names.handleOf(await state(), bob.address)).toBeUndefined();
  await menu(page, "alice_lend", "Stop pointing");
  await expect(row(page, "alice_lend").locator(".label")).toHaveText("points nowhere");
  expect((await held("alice_lend")).pointer).toBeUndefined();
  await asOther(bob, "#/names", async (bobPage) => {
    await expect(bobPage.locator("#shows")).toHaveText("Your account names @alice_lend, but it doesn't point at you, so no handle is shown.");
    await bobPage.getByRole("button", { name: "Stop showing" }).click();
    await expect(bobPage.locator("#shows")).toHaveText("Your account shows no handle. Point a name at it, then show it.");
  });
  expect(await names.getField(await state(), bob.address, "name")).toBeUndefined();
});

test("a visitor sees who owns @alice, where it points and that it is shown; the account page lists its names", async ({ page }) => {
  await openApp(page, null, "#/search/alice");
  await expect(page.locator(".result .badge")).toHaveText("Taken");
  await expect(page.locator(".owned")).toHaveText(`Owned by ${short(alice)}`);
  await expect(page.locator("#points")).toHaveText(`Points at ${short(alice)} · shown as @alice`);
  await page.locator(".owned").getByRole("link", { name: short(alice) }).click();
  await expect(page).toHaveURL(new RegExp(`#/account/${alice.address}$`));
  await expect(page.locator("h1")).toHaveText(`Account ${alice.address}`);
  await expect(page.locator(".shows")).toHaveText("Shown as @alice");
  await expect(row(page, "alice").locator(".label")).toHaveText(`points at ${short(alice)}`);
  await expect(row(page, "alice_lend").locator(".label")).toHaveText("points nowhere");
  // A bare account ID goes to its page; an account with no names says so.
  await page.goto(stack.app + `#/${carol.address}`);
  await expect(page).toHaveURL(new RegExp(`#/account/${carol.address}$`));
  await expect(page.locator(".shows")).toHaveText("Shows no handle");
  await expect(page.locator(".account-page")).toContainText("This account owns no names.");
}, { wallet: false });

test("Alice claims @alice_art listed at once, reprices it; Bob buys it, and it points at him", async ({ page }) => {
  await openApp(page, alice, "#/names");
  await page.getByLabel("Name", { exact: true }).fill("@Alice_Art");
  await page.getByLabel("Sell it right away at (optional)").fill("05");
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(toast(page, "The price: A whole number of coins")).toBeVisible();
  await page.getByLabel("Sell it right away at (optional)").fill("50");
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page).toHaveURL(/#\/@alice_art$/);
  await expect(page.locator(".owned")).toHaveText("Owned by you · for sale · 50");
  await page.goto(stack.app + "#/names");
  await expect(row(page, "alice_art").locator(".label")).toHaveText("points at you · for sale · 50");
  await menu(page, "alice_art", "Stop selling");
  await expect(row(page, "alice_art").locator(".label")).toHaveText("points at you");
  await menu(page, "alice_art", "Sell");
  await answerSheet(page, "40", "List it");
  await expect(row(page, "alice_art").locator(".label")).toHaveText("points at you · for sale · 40");

  const aliceBefore = await balance(alice.address);
  await asOther(bob, "#/market", async (bobPage) => {
    await expect(bobPage.locator("h1")).toHaveText("Names for sale");
    await bobPage.getByRole("link", { name: "See @alice_art for 40" }).click();
    await expect(bobPage.locator(".result .badge")).toHaveText("For sale");
    await expect(bobPage.locator(".result")).toContainText("It comes pointing at your account.");
    await bobPage.getByRole("button", { name: "Buy @alice_art for 40" }).click();
    await expect(bobPage.locator(".result .badge")).toHaveText("Yours");
    await expect(bobPage.locator("#points")).toHaveText("Points at you · not shown there");
  });
  const entry = await held("alice_art");
  expect([entry.owner, entry.price, entry.pointer]).toEqual([bob.address, undefined, bob.address]);
  expect(await balance(alice.address)).toBe(aliceBefore + 40n);
  // Gone from Alice's names.
  await page.reload();
  await expect(row(page, "alice")).toBeVisible();
  await expect(row(page, "alice_art")).toHaveCount(0);
});

test("Alice gives @alice_gift to Bob's account; only Bob takes it, from the link", async ({ page }) => {
  await claimAs(alice, "alice_gift", { point: true });
  await openApp(page, alice, "#/names");
  await menu(page, "alice_gift", "Give to an account");
  await answerSheet(page, "bafy-nope", "Offer it");
  await expect(page.locator("#sheet-error")).toHaveText("That is not an account ID.");
  await answerSheet(page, alice.address, "Offer it");
  await expect(page.locator("#sheet-error")).toHaveText("That is your own account.");
  await answerSheet(page, bob.address, "Offer it");
  await expect(toast(page, "Offered. Link copied: send it to them.")).toBeVisible();
  await expect(row(page, "alice_gift").locator(".label")).toHaveText(`points at you · offered to ${short(bob)}`);
  await expect(page.getByRole("button", { name: "Copy link to take @alice_gift" })).toBeVisible();

  // Someone else opening the link is told it isn't for them.
  await fund(carol.address, 100n);
  await asOther(carol, "#/take/alice_gift", async (carolPage) => {
    await expect(carolPage.locator("h1")).toHaveText("@alice_gift isn't offered to you");
  });
  await asOther(bob, "#/take/alice_gift", async (bobPage) => {
    await expect(bobPage.locator(".badge")).toHaveText("A gift");
    await bobPage.getByRole("button", { name: "Take @alice_gift" }).click();
    await expect(bobPage).toHaveURL(/#\/@alice_gift$/);
    await expect(bobPage.locator(".result .badge")).toHaveText("Yours");
  });
  const entry = await held("alice_gift");
  expect([entry.owner, entry.offer, entry.pointer]).toEqual([bob.address, undefined, bob.address]);
});

test("Alice offers @alice_back to Carol, then takes the offer back", async ({ page }) => {
  await claimAs(alice, "alice_back");
  await openApp(page, alice, "#/names");
  await menu(page, "alice_back", "Give to an account");
  await answerSheet(page, carol.address, "Offer it");
  await expect(row(page, "alice_back").locator(".label")).toHaveText(`points at you · offered to ${short(carol)}`);
  await menu(page, "alice_back", "Take back the offer");
  await expect(row(page, "alice_back").locator(".label")).toHaveText("points at you");
  await expect(page.getByRole("button", { name: "Copy link to take @alice_back" })).toHaveCount(0);
  expect((await held("alice_back")).offer).toBeUndefined();
});

test("Alice releases @alice after confirming in the page: it is free, pointing nowhere, and her account shows nothing", async ({ page }) => {
  await openApp(page, alice, "#/names");
  const asked = page.context().approvals;
  await menu(page, "alice", "Release");
  await expect(page.locator("#sheet-title")).toHaveText("Release @alice?");
  await expect(page.locator("#sheet-body")).toHaveText("It stops being yours, and stops pointing at its account. Anyone may claim it next, free. This can't be undone.");
  await sheetButton(page, "Cancel").click();
  expect(page.context().approvals).toBe(asked);
  expect((await held("alice")).owner).toBe(alice.address);
  await menu(page, "alice", "Release");
  await sheetButton(page, "Release @alice").click();
  await expect(row(page, "alice")).toHaveCount(0);
  expect(page.context().approvals).toBe(asked + 1);
  expect(await held("alice")).toBeUndefined();
  expect(await names.pointer(await state(), "alice")).toBeUndefined();
  expect(await names.handleOf(await state(), alice.address)).toBeUndefined();
  await expect(page.locator("#shows")).toHaveText("Your account names @alice, but it doesn't point at you, so no handle is shown.");
  // Show another name of hers, from its menu: it points at her and shows in one write.
  await menu(page, "alice_lend", "Show this handle");
  await expect(page.locator("#shows")).toHaveText("Your account is shown as @alice_lend.");
  expect((await held("alice_lend")).pointer).toBe(alice.address);
  await page.goto(stack.app + "#/search/alice");
  await expect(page.locator(".result .badge")).toHaveText("Available");
});

test("Claim and show: a new account claims @una and shows it, in one approval", async ({ page }) => {
  const una = newAccount();
  await openApp(page, una, "#/search/una");
  const asked = page.context().approvals;
  // The page draws again once Selfhold has answered; check the box on the page as last drawn.
  await expect(page.locator(".result .badge")).toHaveText("Available");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Show it as my handle").check();
  await expect(page.getByLabel("Show it as my handle")).toBeChecked();
  await page.getByRole("button", { name: "Claim @una" }).click();
  await expect(page.locator("#points")).toHaveText("Points at you · shown as @una");
  expect(page.context().approvals).toBe(asked + 1);
  expect(await names.handleOf(await state(), una.address)).toBe("una");
});

test("A write proposes the fee the node relays for: a claim on a node asking 3 costs 3", async ({ page }) => {
  const fia = newAccount();
  await fund(fia.address, 100n);
  await until("Fia is funded", async () => (await balance(fia.address)) === 100n);
  // The stack's node relays any fee; the page is told this one asks 3.
  await page.route(/\/api\/chain\/info\?/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), minRelayFee: "3" } });
  });
  await openApp(page, fia, "#/search/fia");
  await expect(page.locator(".result .badge")).toHaveText("Available");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Claim @fia" }).click();
  await until("@fia is Fia's", async () => (await names.resolve(await state(), "fia"))?.owner === fia.address);
  expect(await balance(fia.address)).toBe(97n);
});

test("Take never pays: an offer turned into a listing before Bob presses Take is refused, and the wallet is asked nothing", async ({ page }) => {
  await claimAs(alice, "alice_switch");
  await writeAs(alice, await names.offerName(await state(), alice.address, "alice_switch", bob.address));
  await until("the offer", async () => (await held("alice_switch"))?.offer === bob.address);
  const context = page.context();
  await openApp(page, bob, "#/take/alice_switch");
  await expect(page.getByRole("button", { name: "Take @alice_switch" })).toBeVisible();
  // Alice takes the offer back and lists the name at 30 while Bob looks.
  await writeAs(alice, await names.list(await state(), alice.address, "alice_switch", 30n));
  await until("@alice_switch at 30", async () => (await held("alice_switch"))?.price === 30n);
  const asked = context.approvals;
  const before = await balance(bob.address);
  await page.getByRole("button", { name: "Take @alice_switch" }).click();
  await expect(toast(page, "@alice_switch isn't offered to you anymore. Look again.")).toBeVisible();
  expect(context.approvals).toBe(asked);
  expect((await held("alice_switch")).owner).toBe(alice.address);
  expect(await balance(bob.address)).toBe(before);
});

test("Enter in a sheet confirms it: a price typed and Enter lists the name", async ({ page }) => {
  const ivy = newAccount();
  await claimAs(ivy, "ivy_enter");
  await openApp(page, ivy, "#/names");
  await menu(page, "ivy_enter", "Sell");
  await page.locator("#sheet-input").fill("25");
  await page.locator("#sheet-input").press("Enter");
  await expect(row(page, "ivy_enter").locator(".label")).toHaveText("points at you · for sale · 25");
  expect((await held("ivy_enter")).price).toBe(25n);
  // Escape still cancels, sending nothing.
  const asked = page.context().approvals;
  await menu(page, "ivy_enter", "Stop selling");
  await expect(row(page, "ivy_enter").locator(".label")).toHaveText("points at you");
  await menu(page, "ivy_enter", "Sell");
  await page.locator("#sheet-input").fill("7");
  await page.locator("#sheet-input").press("Escape");
  await expect(page.locator("#sheet")).not.toBeVisible();
  await page.waitForTimeout(3000);
  expect(page.context().approvals).toBe(asked + 1);
  expect((await held("ivy_enter")).price).toBeUndefined();
});

test("declining in Selfhold sends nothing, and the page says so", async ({ page }) => {
  const frank = newAccount();
  const context = page.context();
  await walletHolds(context, frank);
  await openApp(page, null, "#/names");
  context.answer = "decline";
  await page.getByRole("button", { name: "Connect Selfhold" }).click();
  await expect(toast(page, "You declined it in the wallet. Nothing was sent.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Selfhold" })).toBeVisible();
  // Asked again at once: the wallet waits a few seconds after a decline, and the page says so.
  await page.getByRole("button", { name: "Connect Selfhold" }).click();
  await expect(toast(page, "Try again in a moment.")).toBeVisible();
  expect(context.declines).toBe(1);

  context.answer = "approve";
  await page.waitForTimeout(5500);
  await page.getByRole("button", { name: "Connect Selfhold" }).click();
  await expect(page.locator("h1")).toHaveText("My names");
  await page.goto(stack.app + "#/search/frank");
  context.answer = "decline";
  await page.getByRole("button", { name: "Claim @frank" }).click();
  await expect(toast(page, "You declined it in the wallet. Nothing was sent.")).toBeVisible();
  expect(context.declines).toBe(2);
  expect(await held("frank")).toBeUndefined();
});

test("buying refuses a price that changed, or a name just taken, and asks the wallet nothing", async ({ page }) => {
  const gwen = newAccount();
  const hal = newAccount();
  await fund(hal.address, 150n);
  await claimAs(gwen, "gwensale", { price: 100n });
  const context = page.context();
  await openApp(page, hal, "#/@gwensale");
  await expect(page.getByRole("button", { name: "Buy @gwensale for 100" })).toBeVisible();
  // Gwen asks more before Hal presses Buy.
  await writeAs(gwen, await names.list(await state(), gwen.address, "gwensale", 200n));
  await until("@gwensale at 200", async () => (await held("gwensale"))?.price === 200n);
  const asked = context.approvals;
  await page.getByRole("button", { name: "Buy @gwensale for 100" }).click();
  await expect(toast(page, "The price of @gwensale just changed. Look again.")).toBeVisible();

  // A name no one owned, taken while Hal looks at it.
  await page.goto(stack.app + "#/@halsnext");
  await expect(page.getByRole("button", { name: "Claim @halsnext" })).toBeVisible();
  await claimAs(gwen, "halsnext");
  await page.getByRole("button", { name: "Claim @halsnext" }).click();
  await expect(toast(page, "@halsnext was just taken.")).toBeVisible();
  expect(context.approvals).toBe(asked);
  expect(await names.namesOf(await state(), hal.address)).toEqual([]);
});

test("if Selfhold forgets this site, or connects another account, a write sends nothing and the page says so", async ({ page }) => {
  const kit = newAccount();
  const oz = newAccount();
  const context = page.context();
  await claimAs(kit, "kit");
  await openApp(page, kit, "#/names");
  await walletForgetsSite(context);
  const asked = context.approvals;
  await menu(page, "kit", "Sell");
  await answerSheet(page, "9", "List it");
  await expect(toast(page, "Selfhold isn't connected to this site anymore. Connect again, then try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Selfhold" })).toBeVisible();
  expect(context.approvals).toBe(asked);
  await page.getByRole("button", { name: "Connect Selfhold" }).click();
  await expect(row(page, "kit")).toBeVisible();

  // In Selfhold, the person adds Oz's key and connects this site to Oz instead.
  const popup = await context.newPage();
  await popup.goto(`${context.walletOrigin}/popup/index.html`);
  const imported = await popup.evaluate((privHex) => chrome.runtime.sendMessage({ type: "importKey", privHex }), oz.keyHex);
  expect(imported.ok).toBe(true);
  await popup.evaluate(async ({ origin, address }) => {
    const { connections = {} } = await chrome.storage.local.get("connections");
    await chrome.storage.local.set({ connections: { ...connections, [origin]: address } });
  }, { origin: new URL(stack.app).origin, address: oz.address });
  await popup.close();
  await menu(page, "kit", "Sell");
  await answerSheet(page, "9", "List it");
  await expect(toast(page, "Selfhold now connects this site to a different account. Look again, then try again.")).toBeVisible();
  // Redrawn as Oz, who owns no names.
  await expect(page.locator("main")).toContainText("No names yet.");
  expect(context.approvals).toBe(asked + 1);
  expect((await held("kit")).price).toBeUndefined();
});

test("chain-sourced and typed text shows as text: crafted handles, account IDs and named handles", async ({ page }) => {
  const mo = newAccount();
  await claimAs(mo, "mo_xss", { point: true });
  // Another client names markup, and a long word, as the handle Mo shows: neither is a handle, so neither shows.
  const crafted = `<img src=x onerror="window.__hit=1">${"w".repeat(200)}`;
  await writeAs(mo, { actions: [{ key: names.shownKey(mo.address), newValue: crafted }] });
  await until("the crafted name", async () => (await names.getField(await state(), mo.address, "name")) === crafted);
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, mo, "#/names");
  await expect(page.locator("#shows")).toHaveText(`Your account names @${crafted}, but it doesn't point at you, so no handle is shown.`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // An account ID with markup is refused before anything is sent.
  const asked = page.context().approvals;
  await menu(page, "mo_xss", "Point at an account…");
  await answerSheet(page, `<img src=x onerror="window.__hit=2">`, "Point it");
  await expect(page.locator("#sheet-error")).toHaveText("That is not an account ID.");
  await sheetButton(page, "Cancel").click();
  // A typed name with markup is refused.
  await page.getByLabel("Name", { exact: true }).fill(`<img src=x onerror="window.__hit=3">`);
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(toast(page, "A name is lowercase letters, digits and _.")).toBeVisible();
  expect(page.context().approvals).toBe(asked);

  await page.goto(stack.app + "#/");
  await expect(page.locator("h1")).toHaveText("Own your name on the internet.");
  await page.locator("#q").fill(`<script>window.__hit=4</script>`);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("#search-note")).toContainText("<script>window.__hit=4</script>");
  await page.goto(stack.app + `#/take/${encodeURIComponent('<img src=x onerror="window.__hit=5">')}`);
  await expect(page.locator("main")).toBeVisible();
  await page.goto(stack.app + `#/${encodeURIComponent('<img src=x onerror="window.__hit=6">')}`);
  await expect(page.locator("#search-note")).toContainText("is not a name or an account.");
  await page.goto(stack.app + `#/account/${encodeURIComponent('<img src=x onerror="window.__hit=7">')}`);
  await expect(page.locator("#search-note")).toContainText("is not a name or an account.");
  await page.goto(stack.app + "#/search/%E0%A4%A");
  await expect(page.locator("h1")).toBeVisible();
  expect(await page.evaluate(() => window.__hit)).toBeUndefined();
});

test("Settings: a node that is down is skipped, and with none reachable the page says so", async ({ page }) => {
  const down = "http://127.0.0.1:27199"; // nothing listens here
  await openApp(page, null, "#/settings");
  await page.locator("#s-nodes").fill(`${down}\n${stack.node}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Settings saved.")).toBeVisible();
  await page.goto(stack.app + "#/search/nodefall");
  await expect(page.locator(".result .badge")).toHaveText("Available");

  await page.goto(stack.app + "#/settings");
  await page.locator("#s-nodes").fill(down);
  await page.getByRole("button", { name: "Save" }).click();
  await page.goto(stack.app + "#/search/nodefall");
  await expect(page.locator("#app")).toContainText(`No node is serving ${stack.chain}`);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  // Defaults puts back the hosted nodes and chain.
  await page.goto(stack.app + "#/settings");
  await page.getByRole("button", { name: "Defaults" }).click();
  await expect(page.locator("#s-nodes")).toHaveValue("https://lattice-testnet-apps-iad.fly.dev\nhttps://lattice-testnet-apps-ams.fly.dev");
  await expect(page.locator("#s-chain")).toHaveValue("Nexus/moniker");
}, { wallet: false, expectedErrors: /ERR_CONNECTION_REFUSED/ });

test("Settings saved for a trial chain follow the move to Moniker, and keep their nodes", async ({ page }) => {
  await openApp(page, null, "#/settings", { nodes: [stack.node], chain: "Nexus/testnet/moniker-307b2c", follows: "Nexus/testnet/follows-f53551", ownNode: "http://127.0.0.1:1" });
  await expect(page.locator("#s-chain")).toHaveValue("Nexus/moniker");
  await expect(page.locator("#s-nodes")).toHaveValue(stack.node);
  // A chain of one's own choosing, not the default, is kept.
  await page.locator("#s-chain").fill("Nexus/other-names");
  await page.getByRole("button", { name: "Save" }).click();
  await page.reload();
  await page.goto(stack.app + "#/settings");
  await expect(page.locator("#s-chain")).toHaveValue("Nexus/other-names");
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("moniker.settings")))).toEqual({ nodes: [stack.node], chain: "Nexus/other-names" });
}, { wallet: false, expectedErrors: /status of 404/ }); // the stack's node serves no Nexus/other-names

test("back from adding Selfhold: the page reloads at the same name, then offers Claim once Selfhold arrives", async ({ page }) => {
  // Chrome itself can't be made to install an extension here; everything the page does around it can.
  const returnToTab = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const mark = () => page.evaluate(() => (window.__sameDocument = true));
  const reloaded = async () => !(await page.evaluate(() => window.__sameDocument === true));
  await openApp(page, null, "#/@backnow");
  // Coming back to the tab before choosing to add Selfhold changes nothing.
  await mark();
  await returnToTab();
  await page.waitForTimeout(1000);
  expect(await reloaded()).toBe(false);

  const store = page.waitForEvent("popup");
  await page.getByRole("link", { name: /^Add Selfhold/ }).click();
  await (await store).close();
  await expect(page.locator("#wallet-wait")).toBeVisible();
  await mark();
  await Promise.all([page.waitForEvent("load"), returnToTab()]);
  expect(await reloaded()).toBe(true);
  await expect(page).toHaveURL(/#\/@backnow$/);
  await expect(page.locator("#wallet-wait")).toBeVisible();

  // Selfhold announces itself on the page; it now offers Claim, and stops waiting.
  await page.evaluate(() => {
    Object.defineProperty(window, "lattice", { value: { connect: async () => null, address: async () => null } });
    window.dispatchEvent(new Event("lattice#initialized"));
  });
  await expect(page.getByRole("button", { name: "Claim @backnow" })).toBeVisible();
  await expect(page.locator("#get-wallet")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("moniker.awaitingWallet"))).toBeNull();
}, { wallet: false });

// ---------------------------------------------------------------- the handle picker, in another app's page

/** An app's page with <moniker-handle-picker>, as `who`, connected to this origin. */
async function openPicker(page, who) {
  await openApp(page, who, "#/names");
  await page.goto(`${new URL(stack.app).origin}/e2e/ui/picker.html?node=${encodeURIComponent(stack.node)}&chain=${encodeURIComponent(stack.chain)}`);
}

test("the handle picker in another app: a new account claims a free name and shows it, in one approval", async ({ page }) => {
  const pia = newAccount();
  await openPicker(page, pia);
  await page.getByRole("button", { name: "Use a handle" }).click();
  const dialog = page.getByRole("dialog", { name: "Use a handle" });
  await expect(dialog.getByText("You have no names on Moniker yet")).toBeVisible();
  const asked = page.context().approvals;
  await dialog.getByLabel("Or claim a free one").fill("@Pia");
  await dialog.getByLabel("Or claim a free one").press("Enter");
  await expect(page.locator("#result")).toHaveText("shown @pia");
  await expect(dialog).toBeHidden();
  expect(page.context().approvals).toBe(asked + 1);
  expect(await names.handleOf(await state(), pia.address)).toBe("pia");
});

test("the handle picker: Cancel resolves to nothing; someone else's name is refused unasked; an owned name is shown", async ({ page }) => {
  const quin = newAccount();
  const rex = newAccount();
  await claimAs(quin, "quin");
  await claimAs(rex, "rex", { price: 5n });
  await openPicker(page, quin);
  const dialog = page.getByRole("dialog", { name: "Use a handle" });
  await page.getByRole("button", { name: "Use a handle" }).click();
  await expect(dialog.getByRole("radio", { name: "@quin" })).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#result")).toHaveText("none");

  await page.getByRole("button", { name: "Use a handle" }).click();
  const asked = page.context().approvals;
  await dialog.getByLabel("Or claim a free one").fill("rex");
  await dialog.getByRole("button", { name: "Use handle" }).click();
  await expect(dialog.getByRole("status")).toContainText("@rex is someone else's. It's for sale on Moniker for 5.");
  expect(page.context().approvals).toBe(asked);

  await dialog.getByLabel("Or claim a free one").fill("");
  await dialog.getByRole("button", { name: "Use handle" }).click();
  await expect(page.locator("#result")).toHaveText("shown @quin");
  expect(page.context().approvals).toBe(asked + 1);
  const shown = await names.resolve(await state(), "quin");
  expect(shown.pointer).toBe(quin.address);
  expect(await names.handleOf(await state(), quin.address)).toBe("quin");
});
