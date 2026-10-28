// Moniker, the names manager, through the real page in headless Chromium with
// Selfhold for Chrome installed, or with Selfhold's window and a passkey
// (Chromium's virtual authenticator), against a private stack (stack.mjs).
// The person here approves whatever the wallet asks.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js \
//   LATTICE_WALLET=<lattice-wallet>/dist LATTICE_WALLET_WEB=<lattice-wallet>/dist-web npm test
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, test as nodeTest } from "node:test";
import { chromium, expect as baseExpect } from "@playwright/test";
import * as names from "../../sdk/src/records/names.mjs";
import { tip, view, volumeLoader } from "../../sdk/src/records/state.mjs";
import { transaction } from "../../sdk/src/records/wallet.mjs";
import { ACCOUNT } from "../../sdk/src/records/shared.mjs";
import { shortAccount } from "../../sdk/src/records/account.mjs";
import decodeQR from "qr/decode.js";
import { CHAIN, start } from "./stack.mjs";

const wallet = process.env.LATTICE_WALLET && fileURLToPath(new URL(process.env.LATTICE_WALLET, `file://${process.cwd()}/`));
if (!wallet) throw new Error("LATTICE_WALLET: the built Lattice Wallet extension (its dist/ directory)");
if (!process.env.LATTICE_WALLET_WEB || !existsSync(`${process.env.LATTICE_WALLET_WEB}/selfhold.js`)) throw new Error("LATTICE_WALLET_WEB: Selfhold's window, built (selfhold-wallet's dist-web/ directory, from npm run build:web)");
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

// Selfhold's window grinds a fee sponsor's shares on the graphics chip. A
// machine without one (CI's) gets Chromium's own, SwiftShader, in software.
const gpuArgs = process.platform === "linux"
  ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader"]
  : [];

let browser;
// Pop-ups blocked as for anyone: Selfhold's window opens only from a click, and a test catches one that doesn't.
const popupsBlocked = { ignoreDefaultArgs: ["--disable-popup-blocking"] };
before(async () => (browser = await chromium.launch({ args: gpuArgs, ...popupsBlocked })));
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
    ...popupsBlocked,
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

/** Opens the app pointed at the stack, with Selfhold chosen, as `who` (connected through it) or as a visitor. */
async function openApp(page, who, hash = "#/", seed = { nodes: [stack.node], chain: stack.chain, sponsor: "", wallet: "selfhold", walletChosen: true }) {
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
      const selfholdShown = await context.selfholdWindow?.locator("body").innerText().catch(() => "?");
      error.message += `\n--- page at ${page.url()}:\n${shown.slice(0, 800)}\n--- status: ${said.join(" ") || "none"}\n--- wallet approvals: ${context.approvals ?? "n/a"}\n--- wallet said: ${context.walletNotes?.join(" || ") || "none"}\n--- Selfhold's window: ${selfholdShown?.replace(/\s+/g, " ").slice(0, 600) ?? "never opened"}\n--- page errors: ${errors.join(" | ") || "none"}`;
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
/**
 * The sponsor's account paid `amount` since it held `before`. The page's
 * shares can be blocks, so it may also have won a block's reward meanwhile:
 * 1000 on the stack's chain.
 */
async function expectSponsorPaid(sponsor, before, amount) {
  const won = (await balance(sponsor.address)) - (before - amount);
  expect(won >= 0n && won % 1000n === 0n).toBe(true);
}

/** On the checkout a Claim opens: its own Claim, by the way it offers first. */
async function claimOnCheckout(page) {
  await expect(page.locator("#buy-title")).toContainText("Claim");
  await page.locator("main").getByRole("button", { name: /^Claim @/ }).click();
}
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
  // No wallet: Claim all the same; Selfhold's window makes the account when it is pressed.
  await expect(page.getByRole("button", { name: "Claim @nobody" })).toBeVisible();
  // Names close to it, each free.
  await expect(page.getByRole("link", { name: "Claim @nobody_ for 0" })).toBeVisible();
  await page.goto(stack.app + "#/@nobody");
  await expect(page.locator(".result .badge")).toHaveText("Available");
  await page.goto(stack.app + "#/search/no!body");
  await expect(page.locator("#search-note")).toContainText("a name is lowercase letters, digits and _.");

  // Where a key is needed, Selfhold's window keeps the account, or Selfhold for Chrome; old links go there too.
  await page.goto(stack.app + "#/profiles");
  await expect(page).toHaveURL(/#\/names$/);
  await expect(page.locator("#get-wallet")).toHaveText("Your names belong to your account's key");
  await expect(page.getByRole("button", { name: "Continue with Selfhold" })).toBeVisible();
  const store = page.waitForEvent("popup");
  await page.getByRole("link", { name: /^Add Selfhold/ }).click();
  await (await store).close();
  await expect(page.locator("#wallet-wait")).toBeVisible();

  // A phone can't add Selfhold for Chrome: it isn't offered there; the window is.
  const phone = await browser.newContext({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" });
  const p = await phone.newPage();
  await openApp(p, null, "#/names");
  await expect(p.getByRole("button", { name: "Continue with Selfhold" })).toBeVisible();
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
  await claimOnCheckout(page);
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

test("Alice claims @alice_art, lists it, then reprices it; Bob buys it, and it points at him", async ({ page }) => {
  await openApp(page, alice, "#/names");
  await page.getByLabel("Name", { exact: true }).fill("@Alice_Art");
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await claimOnCheckout(page);
  await expect(page).toHaveURL(/#\/@alice_art$/);
  await expect(page.locator(".owned")).toHaveText("Owned by you");
  await page.goto(stack.app + "#/names");
  await expect(row(page, "alice_art").locator(".label")).toHaveText("points at you");
  await menu(page, "alice_art", "Sell");
  await answerSheet(page, "05", "List it");
  await expect(page.locator("#sheet")).toContainText("A whole number of coins");
  await answerSheet(page, "50", "List it");
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
    // Buy shows what it would do, asking Selfhold nothing; Pay asks it once.
    const asked = bobPage.context().approvals;
    await bobPage.getByRole("link", { name: "Buy @alice_art for 40" }).click();
    await expect(bobPage.getByRole("heading", { name: "Buy @alice_art" })).toBeVisible();
    await expect(bobPage.locator(".summary")).toContainText("Price40, paid to its owner");
    // With Selfhold the wallet here, it is the way to pay offered first; the passkey account and a request, the others.
    await expect(bobPage.getByRole("radio", { name: /^Selfhold/ })).toBeChecked();
    await bobPage.getByText("Other ways to pay").click();
    await expect(bobPage.getByRole("radio", { name: /^Another wallet or device/ })).not.toBeChecked();
    await expect(bobPage.getByRole("radio", { name: /^Your passkey account/ })).not.toBeChecked();
    await expect(bobPage.getByText("Selfhold shows the payment and its fee, set there, for you to approve.")).toBeVisible();
    expect(bobPage.context().approvals).toBe(asked);
    await bobPage.getByRole("button", { name: "Pay 40 with Selfhold" }).click();
    await expect(bobPage.locator(".result .badge")).toHaveText("Yours");
    expect(bobPage.context().approvals).toBe(asked + 1);
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

test("A write asks for no fee: the wallet pays its own, 1 until the person changes it", async ({ page }) => {
  const fia = newAccount();
  await fund(fia.address, 100n);
  await until("Fia is funded", async () => (await balance(fia.address)) === 100n);
  await openApp(page, fia, "#/search/fia");
  await expect(page.locator(".result .badge")).toHaveText("Available");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Claim @fia" }).click();
  await claimOnCheckout(page);
  await until("@fia is Fia's", async () => (await names.resolve(await state(), "fia"))?.owner === fia.address);
  expect(await balance(fia.address)).toBe(99n);
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
  await claimOnCheckout(page);
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
  await page.getByRole("link", { name: "Buy @gwensale for 100" }).click();
  await expect(page.getByRole("button", { name: "Pay 100 with Selfhold" })).toBeVisible();
  // Gwen asks more before Hal presses Pay.
  await writeAs(gwen, await names.list(await state(), gwen.address, "gwensale", 200n));
  await until("@gwensale at 200", async () => (await held("gwensale"))?.price === 200n);
  const asked = context.approvals;
  await page.getByRole("button", { name: "Pay 100 with Selfhold" }).click();
  await expect(toast(page, "The price of @gwensale just changed. Look again.")).toBeVisible();

  // A name no one owned, taken while Hal looks at it.
  await page.goto(stack.app + "#/@halsnext");
  await expect(page.getByRole("button", { name: "Claim @halsnext" })).toBeVisible();
  await page.getByRole("button", { name: "Claim @halsnext" }).click();
  await expect(page.locator("#buy-title")).toContainText("Claim");
  await claimAs(gwen, "halsnext");
  await page.locator("main").getByRole("button", { name: /^Claim @/ }).click();
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
  await expect(page).toHaveURL(/#\/$/); // Save is done once it goes home
  await expect(toast(page, "Settings saved.")).toBeVisible();
  await page.goto(stack.app + "#/search/nodefall");
  await expect(page.locator(".result .badge")).toHaveText("Available");

  await page.goto(stack.app + "#/settings");
  await page.locator("#s-nodes").fill(down);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/$/); // Save is done once it goes home
  await page.goto(stack.app + "#/search/nodefall");
  await expect(page.locator("#app")).toContainText(`No host is serving ${stack.chain}`);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  // Defaults names no nodes, so reads go to the hosts Nexus lists, and puts back the chain.
  await page.goto(stack.app + "#/settings");
  await page.getByRole("button", { name: "Defaults" }).click();
  await expect(page.locator("#s-nodes")).toHaveValue("");
  await expect(page.locator("#s-nodes")).toHaveAttribute("placeholder", "The hosts Nexus lists for the chain");
  await expect(page.locator("#s-chain")).toHaveValue("Nexus/moniker");
}, { wallet: false, expectedErrors: /ERR_CONNECTION_REFUSED/ });

test("Settings saved for a trial chain follow the move to Moniker, and keep their nodes", async ({ page }) => {
  await openApp(page, null, "#/settings", { nodes: [stack.node], chain: "Nexus/testnet/moniker-307b2c", follows: "Nexus/testnet/follows-f53551", ownNode: "http://127.0.0.1:1" });
  await expect(page.locator("#s-chain")).toHaveValue("Nexus/moniker");
  await expect(page.locator("#s-nodes")).toHaveValue(stack.node);
  // A chain of one's own choosing, not the default, is kept.
  await page.locator("#s-chain").fill("Nexus/other-names");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/$/); // Save is done once it goes home
  await page.reload();
  await page.goto(stack.app + "#/settings");
  await expect(page.locator("#s-chain")).toHaveValue("Nexus/other-names");
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("moniker.settings")))).toEqual({ nodes: [stack.node], chain: "Nexus/other-names", sponsor: "https://lattice-testnet-apps-iad.fly.dev:8650/sponsor", wallet: "web", walletChosen: false });
}, { wallet: false, expectedErrors: /status of 404/ }); // the stack's node serves no Nexus/other-names

test("Settings saved with the hosts once named by default find them through Nexus instead", async ({ page }) => {
  await openApp(page, null, "#/settings", { nodes: ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"], chain: "Nexus/moniker" });
  await expect(page.locator("#s-nodes")).toHaveValue("");
  await expect(page.locator("#s-chain")).toHaveValue("Nexus/moniker");
}, { wallet: false });

test("back from adding Selfhold: the page reloads at the same place, then offers to connect once Selfhold arrives", async ({ page }) => {
  // Chrome itself can't be made to install an extension here; everything the page does around it can.
  const returnToTab = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const mark = () => page.evaluate(() => (window.__sameDocument = true));
  const reloaded = async () => !(await page.evaluate(() => window.__sameDocument === true));
  await openApp(page, null, "#/names");
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
  await expect(page).toHaveURL(/#\/names$/);
  await expect(page.locator("#wallet-wait")).toBeVisible();

  // Selfhold announces itself on the page; it now offers to connect it, and stops waiting.
  await page.evaluate(() => {
    Object.defineProperty(window, "lattice", { value: { connect: async () => null, address: async () => null } });
    window.dispatchEvent(new Event("lattice#initialized"));
  });
  await expect(page.getByRole("button", { name: "Connect Selfhold" })).toBeVisible();
  await expect(page.locator("#get-wallet")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("moniker.awaitingWallet"))).toBeNull();
}, { wallet: false });

// ---------------------------------------------------------------- Selfhold's window, with a passkey

const REQUESTS = "moniker-test-selfhold"; // sessionStorage: the page's requests to Selfhold's window so far
const walletOrigin = new URL(stack.walletPage).origin;

/**
 * `page` opened at `hash`, its wallet Selfhold's window, served on
 * localhost, with a platform passkey provider there. Chromium's virtual
 * authenticator belongs to one page, and a passkey made in one window
 * derives no key in another, so every window the page opens is one window,
 * kept open: each request navigates it, `?n=` counting them.
 */
async function withSelfhold(page, hash, { settings = {} } = {}) {
  const context = page.context();
  await context.addInitScript((origin) => {
    if (location.origin === origin) window.close = () => {};
  }, walletOrigin);
  await page.addInitScript((key) => {
    const open = window.open.bind(window);
    window.open = (url, _name, features) => {
      const to = new URL(url);
      const n = Number(sessionStorage.getItem(key) ?? 0) + 1;
      sessionStorage.setItem(key, String(n));
      to.searchParams.set("n", String(n));
      return open(to.href, "selfhold-test", features);
    };
  }, REQUESTS);
  await page.addInitScript((settings) => {
    if (!localStorage.getItem("moniker.settings")) localStorage.setItem("moniker.settings", JSON.stringify(settings));
  }, { nodes: [stack.node], chain: stack.chain, sponsor: "", walletPage: stack.walletPage, ...settings });
  const arm = () => (context.selfhold = new Promise((resolve) => {
    const opened = async (popup) => {
      if (!(await popup.opener().catch(() => null))) return;
      context.off("page", opened);
      const cdp = await context.newCDPSession(popup);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
      });
      context.selfholdWindow = popup;
      // Closed by the page itself (a write with nothing to send, or one it couldn't build): the next request opens another.
      popup.on("close", () => arm());
      resolve(popup);
    };
    context.on("page", opened);
  }));
  arm();
  await page.goto(stack.app + hash);
}

/** Presses `button` on `page`, and resolves with Selfhold's window once it shows this request. */
async function inSelfhold(page, button) {
  const n = Number(await page.evaluate((key) => sessionStorage.getItem(key) ?? 0, REQUESTS)) + 1;
  await button.click();
  const opened = await page.context().selfhold;
  await until(`Selfhold's window, request ${n}`, async () => new URL(opened.url()).searchParams.get("n") === String(n), 30);
  // Its approving button wakes only in a focused window.
  await opened.bringToFront();
  return opened;
}

/** The account Selfhold's window gave this site, as the page remembers it, or null. */
const selfholdAccount = (page) => page.evaluate((origin) => localStorage.getItem(`selfhold.web.address ${origin}`), walletOrigin);

/** Continue with Selfhold: in its window, a new account, made with a passkey, connected here. Its address. */
async function newSelfholdAccount(page) {
  const opened = await inSelfhold(page, page.getByRole("button", { name: "Continue with Selfhold" }).first());
  await opened.getByRole("button", { name: "Create an account" }).click();
  await opened.getByRole("button", { name: "Connect", exact: true }).click();
  await until("Selfhold's account, here", async () => Boolean(await selfholdAccount(page)), 30);
  return selfholdAccount(page);
}

/** Presses `button`, then approves the write in Selfhold's window, with the passkey. */
async function approveInSelfhold(page, button) {
  const opened = await inSelfhold(page, button);
  await opened.getByRole("button", { name: "Approve with your passkey" }).click();
  return opened;
}
const onCheckout = (page) => page.locator("main").getByRole("button", { name: /^Claim @/ });
/** Every request to the hosts' /transactions, from any of the context's pages. */
function sends(context) {
  const sent = [];
  context.on("request", (request) => request.method() === "POST" && new URL(request.url()).pathname === "/transactions" && sent.push(request));
  return sent;
}
/** The hosts, as Moniker's: they ask a relay fee of 1. */
const relayFee = (context) => context.route("**/api/chain/info?*", async (route) => {
  const response = await route.fetch();
  await route.fulfill({ response, json: { ...(await response.json()), minRelayFee: "1" } });
});
/** Every status the page shows, however briefly, from now. */
const watchToasts = (page) => page.evaluate(() => {
  window.said = [];
  new MutationObserver(() => window.said.push(document.querySelector("#toasts").innerText)).observe(document.querySelector("#toasts"), { subtree: true, childList: true, characterData: true });
});

test("Selfhold's window makes the account with a passkey: a visitor claims @pia_web; the page never holds a key; Disconnect forgets the account here only", async ({ page }) => {
  await withSelfhold(page, "#/@pia_web");
  await page.getByRole("button", { name: "Claim @pia_web" }).click();
  await expect(page.getByRole("radio", { name: /^Selfhold\s*In a window/ })).toBeChecked();
  const address = await newSelfholdAccount(page);
  await approveInSelfhold(page, onCheckout(page));
  await expect(page.locator("#points")).toHaveText("Points at you · not shown there");
  expect((await held("pia_web")).owner).toBe(address);
  // The page keeps its settings and the address it was given: nothing else.
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(["moniker.settings", `selfhold.web.address ${walletOrigin}`]);

  // After a reload, My names asks nothing until a write, and a write asks only the window.
  await page.reload();
  await page.goto(stack.app + "#/names");
  await expect(page.getByRole("heading", { name: "My names" })).toBeVisible();
  await approveInSelfhold(page, page.getByRole("button", { name: "Show this handle @pia_web" }));
  await expect(page.locator("#shows")).toHaveText("Your account is shown as @pia_web.");
  expect(await names.handleOf(await state(), address)).toBe("pia_web");

  // Disconnected, the page forgets the account; the window keeps it, and connects it again.
  await page.goto(stack.app + "#/settings");
  await expect(page.getByRole("heading", { name: "Selfhold" })).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).click();
  expect(await selfholdAccount(page)).toBeNull();
  await page.goto(stack.app + "#/names");
  const opened = await inSelfhold(page, page.getByRole("button", { name: "Continue with Selfhold" }));
  await opened.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(row(page, "pia_web")).toBeVisible();
}, { wallet: false });

test("pressed twice, Claim opens Selfhold's window once, and sends once", async ({ page }) => {
  await withSelfhold(page, "#/names");
  const address = await newSelfholdAccount(page);
  await expect(page.getByRole("heading", { name: "My names" })).toBeVisible();
  const sent = sends(page.context());
  await page.getByLabel("Name", { exact: true }).fill("tia_twice");
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  const opened = await inSelfhold(page, onCheckout(page));
  await onCheckout(page).click();
  await opened.getByRole("button", { name: "Approve with your passkey" }).click();
  await expect(page.locator("#points")).toHaveText("Points at you · not shown there");
  expect((await held("tia_twice")).owner).toBe(address);
  // A second write would have gone out by now, behind the first.
  await page.waitForTimeout(3000);
  expect(sent).toHaveLength(1);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), REQUESTS)).toBe("2"); // the connection, and the claim
  await expect(page.locator("#alerts")).toBeEmpty();
}, { wallet: false });

test("Selfhold's window buys from a page that shows the price, whom it pays, the fee and the balance; short of coins, the page offers to add them", async ({ page }) => {
  const seller = newAccount();
  await claimAs(seller, "uma_sale", { price: 30n });
  await claimAs(seller, "uma_dear", { price: 5000n });
  // A visitor's checkout starts with the account, since buying takes coins.
  await withSelfhold(page, "#/buy/uma_sale");
  await expect(page.getByRole("heading", { name: "Buy @uma_sale" })).toBeVisible();
  await expect(page.locator("main")).toContainText("Buying takes coins");
  await expect(page.getByRole("button", { name: /^Pay/ })).toHaveCount(0);
  const address = await newSelfholdAccount(page);
  await expect(page.locator("main")).toContainText("Your account holds0");
  await expect(page.getByRole("button", { name: "Add coins" })).toBeVisible();
  await fund(address, 100n);

  const sent = sends(page.context());
  await page.goto(stack.app + "#/@uma_sale");
  await page.getByRole("link", { name: "Buy @uma_sale for 30" }).click();
  await expect(page.getByRole("heading", { name: "Buy @uma_sale" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Selfhold\s*In a window/ })).toBeChecked();
  const summary = page.locator("main");
  await expect(summary).toContainText("Price30, paid to its owner");
  await expect(summary).toContainText("FeeNone"); // these hosts ask no fee
  await expect(summary).toContainText("Your account holds100");
  // Nothing goes out until Pay; Not now goes back.
  await page.getByRole("link", { name: "Not now" }).click();
  await expect(page.locator("#exact")).toHaveText("@uma_sale");
  expect(sent).toHaveLength(0);
  await page.getByRole("link", { name: "Buy @uma_sale for 30" }).click();
  await approveInSelfhold(page, page.getByRole("button", { name: "Pay 30 and buy @uma_sale" }));
  await expect(page.locator(".result .badge")).toHaveText("Yours");
  expect(sent).toHaveLength(1);
  expect((await held("uma_sale")).owner).toBe(address);
  expect(await balance(address)).toBe(70n);

  // More than the account holds: no Pay, and Add coins shows where to send them.
  await page.goto(stack.app + "#/buy/uma_dear");
  await expect(page.locator("main").getByRole("status")).toHaveText("This needs 4,930 more coins than your account holds.");
  await expect(page.getByRole("button", { name: /^Pay/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Add coins" }).click();
  await expect(page.locator("#sheet-title")).toHaveText("Add coins to your account");
  await expect(page.locator("#sheet .sheet-detail")).toHaveText(address);
  await sheetButton(page, "Cancel").click();
  expect(sent).toHaveLength(1);
}, { wallet: false });

test("another wallet pays by request: the page draws it as a QR code and text, and follows the chain to the purchase", async ({ page }) => {
  const seller = newAccount();
  const buyer = newAccount();
  await fund(buyer.address, 100n);
  await claimAs(seller, "vic_qr", { price: 25n });
  await withSelfhold(page, "#/buy/vic_qr");
  const sent = sends(page.context());
  // A request needs no account here at all.
  await page.getByText("Other ways to pay").click();
  await page.getByRole("radio", { name: /^Another wallet or device/ }).check();
  await expect(page.getByRole("radio", { name: /^Another wallet or device/ })).toBeFocused();
  await expect(page.getByRole("img", { name: "QR code of the request to buy @vic_qr" })).toBeVisible();
  await expect(page.locator("main").getByRole("status")).toContainText("Waiting for the payment. The request is good until");
  const uri = await page.getByRole("button", { name: "Copy the request" }).getAttribute("data-copy");
  expect(await page.locator("[data-request]").getAttribute("draggable")).toBe("true");

  // The code says what the text does: drawn, then read as a camera would.
  const pixels = await page.evaluate(async () => {
    const svg = document.querySelector(".qr svg");
    const size = svg.viewBox.baseVal.width * 4;
    const image = new Image();
    image.src = URL.createObjectURL(new Blob([svg.outerHTML], { type: "image/svg+xml" }));
    await image.decode();
    const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size, size);
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0, size, size);
    return { size, data: Array.from(context.getImageData(0, 0, size, size).data) };
  });
  expect(decodeQR({ width: pixels.size, height: pixels.size, data: Uint8Array.from(pixels.data) })).toBe(uri);

  // A lattice://write for whichever account signs: the name's price, to its owner, at the value read.
  const url = new URL(uri);
  expect(`${url.protocol}//${url.hostname}`).toBe("lattice://write");
  const intent = JSON.parse(Buffer.from(url.searchParams.get("intent"), "base64url").toString("utf8"));
  expect(intent.chainPath).toEqual(CHAIN);
  expect(intent.label).toBe("Buy @vic_qr");
  expect(intent.payments).toEqual([{ to: seller.address, amount: "25" }]);
  expect(intent.fee).toBeUndefined();
  expect(Date.parse(intent.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
  expect(JSON.stringify(intent)).not.toContain(buyer.address);

  // Signed elsewhere, as the buyer: the page sees it bought, and says by whom.
  const fill = (text) => text?.replaceAll(ACCOUNT, buyer.address);
  await writeAs(buyer, {
    actions: intent.actions.map((a) => ({ ...a, key: fill(a.key), ...(a.newValue === undefined ? {} : { newValue: fill(a.newValue) }) })),
    payments: intent.payments.map((p) => ({ to: p.to, amount: BigInt(p.amount) })),
  });
  await expect(toast(page, `@vic_qr is bought, by ${shortAccount(buyer.address)}.`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#exact")).toHaveText("@vic_qr");
  expect((await held("vic_qr")).owner).toBe(buyer.address);
  expect(sent).toHaveLength(0);
}, { wallet: false });

test("the account pays only the price: its fee, free, paid with this device's GPU; with that down, coins pay the fee, unasked", async ({ page }) => {
  await relayFee(page.context());
  const seller = newAccount();
  await claimAs(seller, "wes_fee", { price: 30n });
  await claimAs(seller, "wes_down", { price: 5n });
  const sponsor = await running.sponsor((address) => fund(address, 1000n));
  await withSelfhold(page, "#/buy/wes_fee", { settings: { sponsor: sponsor.url } });
  const address = await newSelfholdAccount(page);
  await expect(page.getByRole("button", { name: "Add coins instead" })).toBeVisible();
  await fund(address, 40n);
  await page.goto(stack.app + "#/@wes_fee");
  await page.getByRole("link", { name: "Buy @wes_fee for 30" }).click();
  // The price, the fee said to be free and paid with the GPU, and Pay: no total, no choice of how.
  await expect(page.getByRole("button", { name: "Pay 30 and buy @wes_fee" })).toBeVisible();
  const main = page.locator("main");
  await expect(main).toContainText("FeeFree, paid with this device's GPU");
  await expect(main).not.toContainText("Total");
  await expect(main).not.toContainText(/sponsor/i);
  // The other ways wait, folded.
  await expect(page.getByRole("radio", { name: /^Another wallet or device/ })).toBeHidden();
  const before = await balance(sponsor.address);
  await watchToasts(page);
  await approveInSelfhold(page, page.getByRole("button", { name: "Pay 30 and buy @wes_fee" }));
  await expect(page.locator(".result .badge")).toHaveText("Yours");
  // The window says what it is doing, and the page passes it on.
  expect((await page.evaluate(() => window.said)).join(" ")).toContain("Buying @wes_fee: paying the fee with this device's GPU");
  expect((await held("wes_fee")).owner).toBe(address);
  // The account paid the price only; the sponsor, the fee.
  expect(await balance(address)).toBe(10n);
  await expectSponsorPaid(sponsor, before, 1n);

  // The sponsor gone: the account has the coins, so they pay the fee, with nothing more asked.
  await page.context().route(`${sponsor.url}/*`, (route) => route.abort("connectionrefused"));
  await page.goto(stack.app + "#/buy/wes_down");
  await approveInSelfhold(page, page.getByRole("button", { name: "Pay 5 and buy @wes_down" }));
  await expect(page.locator(".result .badge")).toHaveText("Yours");
  expect(await balance(address)).toBe(4n);
}, { wallet: false, expectedErrors: /status of (400|503)|ERR_CONNECTION_REFUSED/ });

test("an account with no coins buys with this device's GPU: it pays the price and the fee; past what the service pays, the page asks for coins", async ({ page }) => {
  await relayFee(page.context());
  const seller = newAccount();
  await claimAs(seller, "yan_gpu", { price: 20n });
  await claimAs(seller, "yan_dear", { price: 150n });
  const sponsor = await running.sponsor((address) => fund(address, 1000n));
  await withSelfhold(page, "#/buy/yan_gpu", { settings: { sponsor: sponsor.url } });
  const address = await newSelfholdAccount(page);
  // Nothing in the account, and the GPU offered first; coins, second.
  await expect(page.getByRole("button", { name: "Pay with this device's GPU" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add coins instead" })).toBeVisible();
  const main = page.locator("main");
  await expect(main).toContainText("This device's GPU can pay the 20 your account is short, as it pays the fee.");
  await expect(main).not.toContainText(/sponsor/i);
  const [sellerBefore, sponsorBefore] = [await balance(seller.address), await balance(sponsor.address)];
  await approveInSelfhold(page, page.getByRole("button", { name: "Pay with this device's GPU" }));
  await expect(page.locator(".result .badge")).toHaveText("Yours", { timeout: 120_000 });
  expect((await held("yan_gpu")).owner).toBe(address);
  // The seller has the price; the account, still nothing; the sponsor paid both.
  expect(await balance(seller.address)).toBe(sellerBefore + 20n);
  expect(await balance(address)).toBe(0n);
  await expectSponsorPaid(sponsor, sponsorBefore, 21n);

  // Past the 100 this service pays of a price: coins, and why.
  await page.goto(stack.app + "#/buy/yan_dear");
  await approveInSelfhold(page, page.getByRole("button", { name: "Pay with this device's GPU" }));
  await expect(page.locator("#sheet-title")).toHaveText("Add coins to your account");
  await expect(page.locator("#sheet-body")).toContainText("This device's GPU pays fees here, but not a price this high, so send coins");
  await sheetButton(page, "Cancel").click();
  expect((await held("yan_dear")).owner).toBe(seller.address);
}, { wallet: false, expectedErrors: /status of 400/ });

test("a free name with the GPU's fee service down, and no coins: the page says its fee is usually paid with the GPU, and to try again", async ({ page }) => {
  await relayFee(page.context());
  const sponsor = "http://localhost:27199/sponsor";
  await page.context().route(`${sponsor}/*`, (route) => route.abort("connectionrefused"));
  await withSelfhold(page, "#/@xia_down", { settings: { sponsor } });
  await page.getByRole("button", { name: "Claim @xia_down" }).click();
  await newSelfholdAccount(page);
  await approveInSelfhold(page, onCheckout(page));
  await expect(page.locator("#sheet-title")).toHaveText("Add coins to your account");
  await expect(page.locator("#sheet-body")).toContainText("Its fee is usually paid with this device's GPU, but that isn't working right now: try again in a few minutes, or send coins");
  await sheetButton(page, "Cancel").click();
  expect(await held("xia_down")).toBeUndefined();
}, { wallet: false, expectedErrors: /ERR_CONNECTION_REFUSED/ });

test("with Selfhold for Chrome too, Settings switch to it and back: each writes as its own account, and only it asks the extension", async ({ page }) => {
  const kit = newAccount();
  await fund(kit.address, 100n); // Selfhold for Chrome's fee
  await walletHolds(page.context(), kit);
  await withSelfhold(page, "#/settings");
  const useExtension = page.getByLabel("Use Selfhold for Chrome, not Selfhold's window");
  await expect(page.getByText("Each keeps its own account.")).toBeVisible();
  await useExtension.check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/$/); // Save is done once it goes home
  await expect(toast(page, "Now Selfhold for Chrome, and its own account")).toBeVisible();
  // Settings read the account Selfhold for Chrome connects here, if it remembers one; else it is asked.
  await page.goto(stack.app + "#/names");
  const connect = page.getByRole("button", { name: "Connect Selfhold" });
  await expect(page.getByRole("heading", { name: "My names" }).or(connect)).toBeVisible();
  if (await connect.isVisible()) await connect.click();
  await expect(page.getByRole("heading", { name: "My names" })).toBeVisible();
  await expect(page.locator("main")).toContainText(shortAccount(kit.address));
  await expect(page.locator("main")).toContainText("Kept by Selfhold for Chrome.");

  await page.goto(stack.app + "#/settings");
  await useExtension.uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await page.goto(stack.app + "#/names");
  const asked = page.context().approvals;
  const made = await newSelfholdAccount(page);
  expect(made).not.toBe(kit.address);
  await expect(page.getByRole("heading", { name: "My names" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("kit_web");
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await approveInSelfhold(page, onCheckout(page));
  await expect(page.locator("#points")).toHaveText("Points at you · not shown there");
  expect((await held("kit_web")).owner).toBe(made);
  expect(page.context().approvals).toBe(asked);

  await page.goto(stack.app + "#/settings");
  await useExtension.check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await page.goto(stack.app + "#/names");
  await expect(page.getByRole("heading", { name: "My names" })).toBeVisible();
  await expect(row(page, "kit_web")).toHaveCount(0);
  await page.getByLabel("Name", { exact: true }).fill("kit_self");
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await claimOnCheckout(page);
  await expect(page.locator("#points")).toHaveText("Points at you · not shown there");
  expect((await held("kit_self")).owner).toBe(kit.address);
  expect(page.context().approvals).toBe(asked + 1);
  // The window's account is still given here, for when it's switched back.
  expect(await selfholdAccount(page)).toBe(made);
});

test("Selfhold's window is the default, Selfhold for Chrome installed or not; whoever connected Selfhold for Chrome here while it was the default keeps it", async ({ page }) => {
  const sol = newAccount();
  await walletHolds(page.context(), sol);
  // Installed, nothing chosen: the window.
  await openApp(page, null, "#/names", { nodes: [stack.node], chain: stack.chain, sponsor: "" });
  await expect(page.getByRole("button", { name: "Continue with Selfhold" })).toBeVisible();
  // Chosen, and connected here.
  await page.evaluate((nodes) => localStorage.setItem("moniker.settings", JSON.stringify({ nodes, chain: "Nexus/moniker", sponsor: "", wallet: "extension", walletChosen: true })), [stack.node]);
  await page.reload();
  await page.getByRole("button", { name: "Connect Selfhold" }).click();
  await expect(page.getByRole("heading", { name: "My names" })).toBeVisible();
  // Saved as Selfhold for Chrome was once by default, chosen by no one: still it, as it is connected here, and now chosen.
  await page.evaluate((nodes) => localStorage.setItem("moniker.settings", JSON.stringify({ nodes, chain: "Nexus/moniker", sponsor: "", wallet: "selfhold" })), [stack.node]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "My names" })).toBeVisible();
  await expect(page.locator("main")).toContainText(shortAccount(sol.address));
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("moniker.settings")))).toMatchObject({ wallet: "extension", walletChosen: true });
});

test("with Selfhold for Chrome in use, the checkout still offers Selfhold's window, its fee paid with the GPU; claiming with it turns the page to the window", async ({ page }) => {
  await relayFee(page.context());
  await walletHolds(page.context(), newAccount());
  const sponsor = await running.sponsor((address) => fund(address, 1000n));
  await withSelfhold(page, "#/@ned_gpu", { settings: { sponsor: sponsor.url, wallet: "extension", walletChosen: true } });
  await page.getByRole("button", { name: "Claim @ned_gpu" }).click();
  await expect(page.getByRole("radio", { name: /^Selfhold for Chrome/ })).toBeChecked();
  await page.getByText("Other ways to pay").click();
  await page.getByRole("radio", { name: /^Selfhold\s*In a window/ }).check();
  const made = await newSelfholdAccount(page);
  await expect(page.locator("main")).toContainText("FeeFree, paid with this device's");
  const asked = page.context().approvals;
  await approveInSelfhold(page, onCheckout(page));
  await expect(page.locator("#points")).toHaveText("Points at you · not shown there");
  expect((await held("ned_gpu")).owner).toBe(made);
  expect(page.context().approvals).toBe(asked);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("moniker.settings")))).toMatchObject({ wallet: "web", walletChosen: true });
}, { expectedErrors: /status of (400|503)/ });

test("with Selfhold's window in use, the checkout never offers Selfhold for Chrome, installed or not, and says whose account pays", async ({ page }) => {
  await walletHolds(page.context(), newAccount());
  await withSelfhold(page, "#/@lou_one");
  await page.getByRole("button", { name: "Claim @lou_one" }).click();
  const address = await newSelfholdAccount(page);
  await expect(page.getByRole("radio", { name: /^Selfhold\s*In a window/ })).toBeChecked();
  // The window, and a request for any wallet, folded: nothing else.
  expect(await page.locator('input[name="pay"]').evaluateAll((inputs) => inputs.map((i) => i.value))).toEqual(["web", "request"]);
  await expect(page.locator("main")).toContainText(`From${shortAccount(address)}, Selfhold's window's account`);
  // My names says which wallet keeps it.
  await page.goto(stack.app + "#/names");
  await expect(page.locator("main")).toContainText("Kept by Selfhold's window, with your passkey.");
});

test("without a sponsor the account pays the hosts' relay fee: short of it, the page asks for coins and sends nothing; funded, it pays", async ({ page }) => {
  await relayFee(page.context());
  await withSelfhold(page, "#/@ola_pass");
  await page.getByRole("button", { name: "Claim @ola_pass" }).click();
  const address = await newSelfholdAccount(page);
  await expect(page.locator("main")).toContainText("This needs 1 more coin than your account holds.");
  await page.getByRole("button", { name: "Add coins", exact: true }).click();
  await expect(page.locator("#sheet-title")).toHaveText("Add coins to your account");
  await expect(page.locator("#sheet-body")).toContainText(`needs 1 coin, and your account holds 0`);
  await expect(page.locator("#sheet .sheet-detail")).toHaveText(address);
  await sheetButton(page, "Cancel").click();
  expect(await held("ola_pass")).toBeUndefined();

  await fund(address, 10n);
  await page.reload();
  await approveInSelfhold(page, onCheckout(page));
  await expect(page.locator("#points")).toHaveText("Points at you · not shown there");
  expect(await balance(address)).toBe(9n);
}, { wallet: false });

test("a fee sponsor that asks more work than the window will do: the page asks for coins instead, and nothing is ground", async ({ page }) => {
  await relayFee(page.context());
  // One share of 2^60 hashes for the fee: years, on any device.
  const sponsor = "http://localhost:27199/sponsor";
  const asked = [];
  await page.context().route(`${sponsor}/*`, (route) => {
    asked.push(new URL(route.request().url()).pathname);
    if (!route.request().url().endsWith("/work")) return route.fulfill({ status: 402, json: { error: { message: "insufficientCredit" } } });
    return route.fulfill({ json: { client: "c", assignment: "a", prefixHex: "00", shareTarget: `${"0".repeat(15)}${"f".repeat(49)}`, startNonce: "0", count: "4294967296", fee: "1", sharesForFee: "1", expiresInMilliseconds: "30000" } });
  });
  await withSelfhold(page, "#/@dee_pass", { settings: { sponsor } });
  await page.getByRole("button", { name: "Claim @dee_pass" }).click();
  await newSelfholdAccount(page);
  await approveInSelfhold(page, onCheckout(page));
  await expect(page.locator("#sheet-title")).toHaveText("Add coins to your account");
  await expect(page.locator("#sheet-body")).toContainText("This device's GPU can't pay for it in reasonable time, so send coins to your account ID");
  expect(asked).toEqual(["/sponsor/work"]);
  await sheetButton(page, "Cancel").click();
  expect(await held("dee_pass")).toBeUndefined();
}, { wallet: false });

for (const { on, handle, gpu } of [{ on: "the graphics chip", handle: "sia_gpu", gpu: true }, { on: "the processor, with no graphics chip", handle: "sia_cpu", gpu: false }]) {
  test(`with a fee sponsor, an account with no coins pays the relay fee in work, on ${on}: the sponsor's account pays it`, async ({ page }) => {
    await relayFee(page.context());
    // Counts the workers Selfhold's window starts, and with `gpu` false, hides WebGPU from it.
    await page.context().addInitScript(({ origin, gpu }) => {
      if (location.origin !== origin) return;
      if (!gpu) Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined });
      const Base = Worker;
      window.workersStarted = 0;
      window.Worker = class extends Base {
        constructor(...args) {
          super(...args);
          window.workersStarted += 1;
        }
      };
    }, { origin: walletOrigin, gpu });
    const sponsor = await running.sponsor((address) => fund(address, 1000n));
    await withSelfhold(page, `#/@${handle}`, { settings: { sponsor: sponsor.url } });
    const before = await balance(sponsor.address);
    await page.getByRole("button", { name: `Claim @${handle}` }).click();
    const address = await newSelfholdAccount(page);
    const opened = await approveInSelfhold(page, onCheckout(page));
    await expect(page.locator("#points")).toHaveText("Points at you · not shown there");
    expect((await held(handle)).owner).toBe(address);
    expect(await balance(address)).toBe(0n);
    await expectSponsorPaid(sponsor, before, 1n);
    const workers = await opened.evaluate(() => window.workersStarted);
    if (gpu) expect(workers).toBe(0);
    else expect(workers).toBeGreaterThan(0);
  }, { wallet: false, expectedErrors: /status of (400|503)/ });
}

// ---------------------------------------------------------------- the handle picker, in another app's page

/** An app's page with <moniker-handle-picker>, as `who`, connected to this origin. */
async function openPicker(page, who) {
  await openApp(page, who, "#/names");
  await page.goto(`${new URL(stack.app).origin}/e2e/ui/picker.html?node=${encodeURIComponent(stack.node)}&chain=${encodeURIComponent(stack.chain)}`);
}

test("the handle picker in another app: a new account claims a free name and shows it, in one approval", async ({ page }) => {
  const pia = newAccount();
  await fund(pia.address, 100n); // the wallet's fee, 1 by default
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
