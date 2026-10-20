// Moniker through the real page in headless Chromium with the Lattice Wallet
// installed, against a private stack (stack.mjs). The person here approves
// whatever the wallet asks.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js \
//   LATTICE_WALLET=<lattice-wallet>/dist npm test
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect as baseExpect } from "@playwright/test";
import * as profile from "../../sdk/src/records/profile.mjs";
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
  const r = await fetch(`${stack.node}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
  });
  if (!r.ok) throw new Error(`submit: ${r.status} ${await r.text()}`);
}
async function fund(to, amount = 2000n) {
  const nonce = BigInt((await account(stack.miner)).nonce ?? 0);
  await submit(minerAccount, sdk.buildTransfer({ from: stack.miner, to, amount, fee: 1n, nonce, chainPath: CHAIN }));
  await until("funds", async () => BigInt((await account(to)).balance ?? 0) >= amount);
}
async function state() {
  const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${stack.node}/volumes`, { chainPath: CHAIN }));
  const { generalStateCID } = await tip(sdk, stack.node, CHAIN, volumes);
  return view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID);
}
/** Writes as another client would, signing with the key directly. */
async function writeAs(who, write) {
  const nonce = BigInt((await account(who.address)).nonce ?? 0);
  await submit(who, transaction({ owner: who.address, ...write, fee: 1n, nonce, chainPath: CHAIN }));
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
async function openApp(page, who, hash = "#/") {
  await page.addInitScript(({ node, chain }) => {
    if (sessionStorage.getItem("moniker-test-seeded")) return;
    sessionStorage.setItem("moniker-test-seeded", "1");
    localStorage.setItem("moniker.settings", JSON.stringify({ nodes: [node], chain }));
  }, { node: stack.node, chain: stack.chain });
  // Playwright's own clicks and reads count as the person acting, so Selfhold
  // would let a page connect at any time here. As in a page someone just
  // opened, the app sees no recent click, and must ask only from one.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userActivation", { value: { isActive: false, hasBeenActive: false } });
  });
  if (who) await walletHolds(page.context(), who);
  await page.goto(stack.app + (who ? "#/me" : hash));
  if (who) {
    // Your page asks for nothing on the way in: it offers to connect.
    const before = page.context().approvals;
    await page.getByRole("button", { name: "Connect Selfhold" }).click();
    await expect(page.getByRole("link", { name: "Edit", exact: true })).toBeVisible();
    expect(page.context().approvals).toBe(before + 1);
    if (hash !== "#/me") await page.goto(stack.app + hash);
  }
}

/** A test with a fresh browser and page; on failure, what the page showed. */
const test = (name, body, { wallet: withWallet = true, expectedErrors } = {}) =>
  nodeTest(name, { timeout: 300_000 }, async () => {
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
      const said = await page.locator("#toasts").innerText().catch(() => "");
      error.message += `\n--- page at ${page.url()}:\n${shown.slice(0, 800)}\n--- status: ${said || "none"}\n--- wallet approvals: ${context.approvals ?? "n/a"}\n--- wallet said: ${context.walletNotes?.join(" || ") || "none"}\n--- page errors: ${errors.join(" | ") || "none"}`;
      throw error;
    } finally {
      await context.close();
    }
  });

// ---------------------------------------------------------------- tests

const alice = newAccount();
const bob = newAccount();

test("a visitor searches: a name no one owns is for sale at 0, and reading needs no wallet", async ({ page }) => {
  await openApp(page, null, "#/");
  await expect(page.locator("h1")).toHaveText("Own your name on the internet.");
  await page.locator("#q").fill("@No Body");
  await page.getByRole("button", { name: "Search" }).click();
  // Searched as a handle: lowercase, no @ or spaces.
  await expect(page).toHaveURL(/#\/search\/nobody$/);
  await expect(page.locator(".result .badge")).toHaveText("Available");
  await expect(page.locator(".result")).toContainText("No one owns it yet, so it costs 0.");
  await expect(page.getByRole("link", { name: "Buy @nobody", exact: true })).toBeVisible();
  // Names close to it, each with its price.
  await expect(page.getByRole("link", { name: "Buy @nobody_ for 0" })).toBeVisible();
  // A page no one holds is the same search.
  await page.goto(stack.app + "#/@nobody");
  await expect(page.locator(".result .badge")).toHaveText("Available");
  await page.goto(stack.app + "#/search/no!body");
  await expect(page.locator("#search-note")).toContainText("a name is lowercase letters, digits and _.");
}, { wallet: false });

test("with no wallet, checkout still shows the order, with how to add Selfhold in place of Buy", async ({ page }) => {
  await openApp(page, null, "#/search/nobody");
  await page.getByRole("link", { name: "Buy @nobody", exact: true }).click();
  await expect(page.locator("h1")).toHaveText("Checkout");
  await expect(page.locator(".sum")).toContainText("no one owns it yet");
  await expect(page.getByRole("button", { name: /^Buy for/ })).toHaveCount(0);
  await expect(page.locator("#get-wallet")).toHaveText("To buy @nobody, add Selfhold");
  const store = page.waitForEvent("popup");
  await page.getByRole("link", { name: /^Add Selfhold/ }).click();
  await (await store).close();
  await expect(page.locator("#wallet-wait")).toBeVisible();
  // Where a key is needed, the same panel instead of an error.
  await page.goto(stack.app + "#/names");
  await expect(page.locator("#get-wallet")).toHaveText("Your names live in your wallet");

  // A phone can't add Selfhold: it is offered the link to finish on a computer.
  const phone = await browser.newContext({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" });
  const p = await phone.newPage();
  await openApp(p, null, "#/buy/nobody");
  await expect(p.getByRole("button", { name: "Copy this page's link" })).toBeVisible();
  await expect(p.getByRole("link", { name: /^Add Selfhold/ })).toHaveCount(0);
  await phone.close();
}, { wallet: false });

test("Alice makes her page: name, bio, website and links in her order", async ({ page }) => {
  await fund(alice.address);
  await openApp(page, alice, "#/edit");
  await page.locator("#name").fill("Alice Rivera");
  await page.locator("#bio").fill("Builds open tools.");
  await page.locator("#url").fill("https://alice.example");
  for (const [label, url] of [["Newsletter", "https://news.example"], ["GitHub", "https://github.com/alice"]]) {
    await page.getByRole("button", { name: "+ Add link" }).click();
    const row = page.locator("[data-link]").last();
    await row.locator('[data-field="label"]').fill(label);
    await row.locator('[data-field="url"]').fill(url);
  }
  // A link that is not a web address is refused before the wallet is asked.
  await page.getByRole("button", { name: "+ Add link" }).click();
  await page.locator("[data-link]").last().locator('[data-field="label"]').fill("Bad");
  await page.locator("[data-link]").last().locator('[data-field="url"]').fill("javascript:alert(1)");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".toast")).toContainText("“Bad” needs an http or https address.");
  await page.getByRole("button", { name: "Delete link 3" }).click();
  // GitHub first.
  await page.getByRole("button", { name: "Move link 2 up" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/me$/);
  await expect(page.locator("h1")).toHaveText("Alice Rivera");
  await expect(page.locator(".bio")).toHaveText("Builds open tools.");
  await expect(page.locator(".links a")).toHaveText(["alice.example", "GitHub", "Newsletter"]);
  await expect(page.locator(".links a").nth(1)).toHaveAttribute("href", "https://github.com/alice");
  // Connect, then one write.
  expect(page.context().approvals).toBe(2);
  // On the chain, read by another client.
  const p = await profile.getProfile(await state(), alice.address);
  expect(p.links).toEqual([{ label: "GitHub", url: "https://github.com/alice" }, { label: "Newsletter", url: "https://news.example" }]);
});

test("Alice buys @alice, which no one owned, for 0; a visitor finds her by it", async ({ page }) => {
  await openApp(page, alice, "#/");
  await page.locator("#q").fill("alice");
  await page.locator("#q").press("Enter");
  await page.getByRole("link", { name: "Buy @alice", exact: true }).click();
  // Already connected: straight to the checkout, which is only the order.
  await expect(page.locator("h1")).toHaveText("Checkout");
  await expect(page.locator(".order")).toHaveText("@alice");
  await expect(page.locator(".sum")).toContainText("no one owns it yet");
  const asked = page.context().approvals;
  await page.getByRole("button", { name: "Buy for 0" }).click();
  await expect(page).toHaveURL(/#\/bought\/alice$/);
  await expect(page.locator("h1")).toHaveText("@alice is yours");
  await expect(page.locator("main")).toContainText(`It's held by ${alice.address.slice(0, 7)}`);
  // Buying needed no account: her page, made before, was left as it was. Connected, she can put it there.
  expect((await profile.getProfile(await state(), alice.address)).handle).toBeUndefined();
  await page.getByRole("button", { name: "Put @alice on your page" }).click();
  await expect(page.getByRole("button", { name: "Put @alice on your page" })).toHaveCount(0);
  expect(page.context().approvals).toBe(asked + 2);
  await page.getByRole("link", { name: "View your page" }).click();
  await expect(page.locator(".handle")).toHaveText("@alice");
  await expect(page.locator(".links a")).toHaveCount(3);

  const visitor = await browser.newPage();
  await openApp(visitor, null, "#/search/alice");
  await expect(visitor.locator(".result .badge")).toHaveText("Taken");
  // Taken: names close to it that can be bought.
  await expect(visitor.getByRole("link", { name: "Buy @alice_ for 0" })).toBeVisible();
  await visitor.getByRole("link", { name: "See @alice's page" }).click();
  await expect(visitor.locator("h1")).toHaveText("Alice Rivera");
  await expect(visitor.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await visitor.close();
});

test("another app shows Alice with <moniker-name>, linked to her page", async ({ page }) => {
  const query = new URLSearchParams({ address: alice.address, node: stack.node, chain: stack.chain });
  await page.goto(`${stack.app.replace(/app\/$/, "sdk/")}demo.html?${query}`);
  const byline = page.locator("moniker-name");
  await expect(byline.locator(".name")).toHaveText("Alice Rivera");
  await expect(byline.locator(".handle")).toHaveText("@alice");
  await expect(byline.locator("a")).toHaveAttribute("href", `https://adalinxx.github.io/moniker/app/#/${alice.address}`);
}, { wallet: false });

test("Alice sells @alice; Bob buys it alone, and it leaves her page", async ({ page }) => {
  {
    await openApp(page, alice, "#/names");
    const row = page.locator(".row", { hasText: "@alice" });
    await row.getByRole("button", { name: "Sell" }).click();
    await expect(page.locator("#sheet")).toContainText("Anyone can buy it at this price at once");
    await page.locator("#sheet-input").fill("05");
    await page.locator("#sheet").getByRole("button", { name: "List it" }).click();
    await expect(page.locator("#sheet-error")).toHaveText("A whole number of coins.");
    await page.locator("#sheet-input").fill("500");
    await page.locator("#sheet").getByRole("button", { name: "List it" }).click();
    await expect(row).toContainText("for sale · 500");
  }
  await fund(bob.address);
  const bobContext = await walletBrowser();
  try {
    const bobPage = bobContext.pages()[0] ?? (await bobContext.newPage());
    await openApp(bobPage, bob, "#/");
    await bobPage.getByRole("link", { name: "Marketplace" }).click();
    await bobPage.getByRole("link", { name: "Buy @alice for 500" }).click();
    // The same checkout as a name no one owns, at the owner's price.
    await expect(bobPage.locator("h1")).toHaveText("Checkout");
    await expect(bobPage.locator(".sum")).toContainText("paid to its owner");
    await expect(bobPage.locator("main")).toContainText("If the owner changes the price before it lands, nothing is taken.");
    await bobPage.getByRole("button", { name: "Buy for 500" }).click();
    await expect(bobPage.locator("h1")).toHaveText("@alice is yours");
    await bobPage.getByRole("link", { name: "Go to My names" }).click();
    await expect(bobPage.locator(".row", { hasText: "@alice" })).toContainText("on your page");
  } finally {
    await bobContext.close();
  }
  const s = await state();
  expect((await profile.resolve(s, "alice")).holder).toBe(bob.address);
  expect(BigInt((await account(alice.address)).balance)).toBeGreaterThan(2000n);
  // Alice's card still names it, but she no longer holds it: not shown.
  await page.goto(stack.app + `#/${alice.address}`);
  await expect(page.locator("h1")).toHaveText("Alice Rivera");
  await expect(page.locator(".handle")).toHaveCount(0);
});

test("links another client wrote are shown only when they are web addresses", async ({ page }) => {
  const carol = newAccount();
  await fund(carol.address, 100n);
  await writeAs(carol, {
    actions: [{
      key: profile.cardKey(carol.address),
      newValue: JSON.stringify({ name: "Carol", url: "javascript:alert(1)", links: [{ label: "Evil", url: "javascript:alert(1)" }, { label: "Fine", url: "https://fine.example" }] }),
    }],
  });
  await until("Carol's card", async () => (await profile.getProfile(await state(), carol.address)).name === "Carol");
  await openApp(page, null, `#/${carol.address}`);
  await expect(page.locator("h1")).toHaveText("Carol");
  await expect(page.locator(".links a")).toHaveText(["Fine"]);
}, { wallet: false });

test("a newcomer with no coins searches, buys @erin for 0 in one approval, then sets up their page", async ({ page }) => {
  const erin = newAccount();
  assert.equal(BigInt((await account(erin.address)).balance ?? 0), 0n);
  await walletHolds(page.context(), erin);
  await openApp(page, null, "#/");
  await page.locator("#q").fill("erin");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("link", { name: "Buy @erin", exact: true }).click();

  // Checkout asks the wallet for nothing until Buy, which needs no connection.
  await expect(page).toHaveURL(/#\/buy\/erin$/);
  await expect(page.locator("h1")).toHaveText("Checkout");
  assert.equal(page.context().approvals, 0);
  await page.getByRole("button", { name: "Buy for 0" }).click();
  await expect(page.locator("h1")).toHaveText("@erin is yours");
  // One write, which bought the name and made a page showing it.
  assert.equal(page.context().approvals, 1);
  expect((await profile.getProfile(await state(), erin.address)).handle).toBe("erin");
  expect(await page.evaluate(() => window.lattice.address())).toBeNull();

  // Setting up the page edits it, so that connects.
  await page.getByRole("link", { name: "Set up your page" }).click();
  await page.getByRole("button", { name: "Connect Selfhold" }).click();
  await expect(page.locator("#handle")).toHaveValue("erin");
  assert.equal(page.context().approvals, 2);
  await page.locator("#name").fill("Erin Vale");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/me$/);
  await expect(page.locator("h1")).toHaveText("Erin Vale");
  await expect(page.locator(".handle")).toHaveText("@erin");

  const visitor = await browser.newPage();
  await openApp(visitor, null, "#/search/erin");
  await visitor.getByRole("link", { name: "See @erin's page" }).click();
  await expect(visitor.locator("h1")).toHaveText("Erin Vale");
  await visitor.close();
});

test("Your page shows a new account where to start, and one with a page its page", async ({ page }) => {
  const dave = newAccount();
  await openApp(page, dave, "#/me");
  await expect(page.locator(".empty")).toHaveText("Nothing here yet. Make your page.");
  const context = await walletBrowser();
  try {
    const alicePage = context.pages()[0] ?? (await context.newPage());
    await openApp(alicePage, alice, "#/me");
    await expect(alicePage.locator("h1")).toHaveText("Alice Rivera");
  } finally {
    await context.close();
  }
});

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const toast = (page, text) => page.locator(".toast", { hasText: text });

test("declining in Selfhold sends nothing, and the page says so", async ({ page }) => {
  const frank = newAccount();
  const context = page.context();
  await walletHolds(context, frank);
  await openApp(page, null, "#/me");
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
  await expect(page.locator(".empty")).toHaveText("Nothing here yet. Make your page.");
  await page.goto(stack.app + "#/edit");
  await page.locator("#name").fill("Frank");
  context.answer = "decline";
  await page.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "You declined it in the wallet. Nothing was sent.")).toBeVisible();
  expect(context.declines).toBe(2);
  expect((await profile.getProfile(await state(), frank.address)).name).toBeUndefined();
});

test("checkout refuses a price that changed, or a name just taken, and asks the wallet nothing", async ({ page }) => {
  const gwen = newAccount();
  const hal = newAccount();
  await fund(gwen.address, 100n);
  // Hal can pay the 100 he is shown, so it is the price check that stops him.
  await fund(hal.address, 150n);
  await writeAs(gwen, await profile.claim(await state(), gwen.address, "gwensale", 100n));
  await until("@gwensale for sale at 100", async () => (await profile.resolve(await state(), "gwensale"))?.price === 100n);
  const context = page.context();
  await openApp(page, hal, "#/buy/gwensale");
  await expect(page.getByRole("button", { name: "Buy for 100" })).toBeVisible();
  // Gwen asks more before Hal presses Buy.
  await writeAs(gwen, profile.list(await profile.resolve(await state(), "gwensale"), 200n));
  await until("@gwensale at 200", async () => (await profile.resolve(await state(), "gwensale"))?.price === 200n);
  const asked = context.approvals;
  await page.getByRole("button", { name: "Buy for 100" }).click();
  await expect(toast(page, "The price of @gwensale just changed. Look again.")).toBeVisible();

  // A name no one owned, taken while Hal looks at it.
  await page.goto(stack.app + "#/buy/halsnext");
  await expect(page.getByRole("button", { name: "Buy for 0" })).toBeVisible();
  await writeAs(gwen, await profile.claim(await state(), gwen.address, "halsnext"));
  await until("@halsnext taken", async () => (await profile.resolve(await state(), "halsnext"))?.holder === gwen.address);
  await page.getByRole("button", { name: "Buy for 0" }).click();
  await expect(toast(page, "@halsnext was just taken, and it isn't for sale.")).toBeVisible();
  expect(context.approvals).toBe(asked);
  expect(await profile.heldBy(await state(), hal.address)).toEqual([]);
});

test("My names: another name on the page, sell and stop selling, give one away, release one", async ({ page }) => {
  const ivy = newAccount();
  const jo = newAccount();
  await openApp(page, ivy, "#/");
  for (const handle of ["ivyone", "ivytwo"]) {
    await page.goto(stack.app + `#/buy/${handle}`);
    await page.getByRole("button", { name: "Buy for 0" }).click();
    await expect(page.locator("h1")).toHaveText(`@${handle} is yours`);
  }
  await page.getByRole("link", { name: "Go to My names" }).click();
  const one = page.locator(".row", { hasText: "@ivyone" });
  const two = page.locator(".row", { hasText: "@ivytwo" });
  // Her first name went on her page; the second did not.
  await expect(one).toContainText("on your page");
  await expect(two).not.toContainText("on your page");
  await two.getByRole("button", { name: "Use on page" }).click();
  await expect(two).toContainText("on your page");
  await expect(one).not.toContainText("on your page");

  await two.getByRole("button", { name: "Sell" }).click();
  await page.locator("#sheet-input").fill("50");
  await page.locator("#sheet").getByRole("button", { name: "List it" }).click();
  await expect(two).toContainText("for sale · 50");
  await two.getByRole("button", { name: "Stop selling" }).click();
  await expect(two).not.toContainText("for sale");
  expect((await profile.resolve(await state(), "ivytwo")).price).toBeUndefined();

  // Given only to an account address.
  await one.getByRole("button", { name: "Give" }).click();
  await page.locator("#sheet-input").fill("@jo");
  await page.locator("#sheet").getByRole("button", { name: "Give it" }).click();
  await expect(page.locator("#sheet-error")).toHaveText("That is not an account address.");
  await page.locator("#sheet-input").fill(jo.address);
  await page.locator("#sheet").getByRole("button", { name: "Give it" }).click();
  await expect(one).toHaveCount(0);
  expect((await profile.resolve(await state(), "ivyone")).holder).toBe(jo.address);

  // Released: anyone's next, at 0.
  await two.getByRole("button", { name: "Release" }).click();
  await expect(page.locator("#sheet")).toContainText("anyone may buy it next, for 0");
  await page.locator("#sheet").getByRole("button", { name: "Release it" }).click();
  await expect(two).toHaveCount(0);
  await expect(page.locator(".note")).toContainText("You don't own a name yet.");
  expect(await profile.resolve(await state(), "ivytwo")).toBeUndefined();
  await page.goto(stack.app + "#/search/ivytwo");
  await expect(page.locator(".result .badge")).toHaveText("Available");
});

test("if Selfhold forgets this site while Moniker is open, a save sends nothing and offers to connect again", async ({ page }) => {
  const kit = newAccount();
  const context = page.context();
  await openApp(page, kit, "#/edit");
  await page.locator("#name").fill("Kit");
  await walletForgetsSite(context);
  const asked = context.approvals;
  await page.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Selfhold isn't connected to this site anymore. Connect again, then try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Selfhold" })).toBeVisible();
  expect(context.approvals).toBe(asked);
  await page.getByRole("button", { name: "Connect Selfhold" }).click();
  await page.locator("#name").fill("Kit");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("h1")).toHaveText("Kit");
  // Connect again, then the one save.
  expect(context.approvals).toBe(asked + 2);
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
  await expect(page.locator("#app")).toContainText(`No node is serving ${stack.chain} right now.`);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  // Defaults puts back the hosted nodes.
  await page.goto(stack.app + "#/settings");
  await page.getByRole("button", { name: "Defaults" }).click();
  await expect(page.locator("#s-nodes")).toHaveValue("https://lattice-testnet-apps-iad.fly.dev\nhttps://lattice-testnet-apps-ams.fly.dev");
}, { wallet: false, expectedErrors: /ERR_CONNECTION_REFUSED/ });

test("a photo kept on your own node goes on your page, and visitors see it", async ({ page }) => {
  const lu = newAccount();
  await openApp(page, lu, "#/edit");
  await page.locator("#photo").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await expect(toast(page, "Choose a PNG, JPEG, GIF, WebP or AVIF image.")).toBeVisible();
  await page.locator("#photo").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
  await expect(toast(page, "Photos are kept by your own node. Set it in Settings first.")).toBeVisible();

  await page.goto(stack.app + "#/settings");
  await page.locator("#s-own").fill(stack.rpc);
  await page.locator("#s-cookie").fill(readFileSync(`${stack.root}/chains/Nexus/.cookie`, "utf8").trim());
  await page.getByRole("button", { name: "Save" }).click();
  await page.goto(stack.app + "#/edit");
  await page.locator("#name").fill("Lu");
  await page.locator("#photo").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
  await expect(toast(page, "Photo kept. Save to put it on your page.")).toBeVisible();
  await page.locator("#name").fill("Lu");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("h1")).toHaveText("Lu");
  await expect(page.locator("img.avatar")).toHaveAttribute("src", /^blob:/);
  const { avatar } = await profile.getProfile(await state(), lu.address);
  expect(avatar).toMatch(/^bafy/);

  const visitor = await browser.newPage();
  await openApp(visitor, null, `#/${lu.address}`);
  await expect(visitor.locator("img.avatar")).toHaveAttribute("src", /^blob:/);
  await visitor.close();
});

test("a card another client wrote shows as text, long ones fit a phone, and odd searches are refused", async ({ page }) => {
  const mo = newAccount();
  await fund(mo.address, 100n);
  const long = "w".repeat(300);
  const name = `<img src=x onerror="window.__hit=1">Mo`;
  await writeAs(mo, {
    actions: [{
      key: profile.cardKey(mo.address),
      newValue: JSON.stringify({ name, description: `${long}\n<script>window.__hit=2</script>`, links: [{ label: `<b>bold</b> ${long}`, url: `https://example.com/${long}` }] }),
    }],
  });
  await until("Mo's card", async () => (await profile.getProfile(await state(), mo.address)).name === name);
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, null, `#/${mo.address}`);
  await expect(page.locator("h1")).toHaveText(name);
  await expect(page.locator(".bio")).toContainText("<script>window.__hit=2</script>");
  await expect(page.locator(".links a")).toHaveText(`<b>bold</b> ${long}`);
  expect(await page.evaluate(() => window.__hit)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  await page.goto(stack.app + "#/");
  await page.locator("#q").fill("Ünïcode");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("#search-note")).toContainText("a name is lowercase letters, digits and _.");
}, { wallet: false });

test("back from adding Selfhold: the page reloads at the same checkout, then offers Buy once Selfhold arrives", async ({ page }) => {
  // Chrome itself can't be made to install an extension here; everything the page does around it can.
  const returnToTab = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const mark = () => page.evaluate(() => (window.__sameDocument = true));
  const reloaded = async () => !(await page.evaluate(() => window.__sameDocument === true));
  await openApp(page, null, "#/buy/backnow");
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
  await expect(page).toHaveURL(/#\/buy\/backnow$/);
  await expect(page.locator("#wallet-wait")).toBeVisible();

  // Selfhold announces itself on the page; checkout now offers Buy, and stops waiting.
  await page.evaluate(() => {
    Object.defineProperty(window, "lattice", { value: { connect: async () => null, address: async () => null } });
    window.dispatchEvent(new Event("lattice#initialized"));
  });
  await expect(page.getByRole("button", { name: "Buy for 0" })).toBeVisible();
  await expect(page.locator("#get-wallet")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("moniker.awaitingWallet"))).toBeNull();
}, { wallet: false });

test("if Selfhold now connects this site to another account, a save sends nothing and the page shows that account", async ({ page }) => {
  const nia = newAccount();
  const oz = newAccount();
  const context = page.context();
  await openApp(page, nia, "#/edit");
  await page.locator("#name").fill("Nia");
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

  const asked = context.approvals;
  await page.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Selfhold now connects this site to a different account. Look again, then try again.")).toBeVisible();
  expect(context.approvals).toBe(asked);
  // Edit is now Oz's page, empty; saving it writes Oz's card, and Nia's is untouched.
  await expect(page.locator("#name")).toHaveValue("");
  await page.locator("#name").fill("Oz");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("h1")).toHaveText("Oz");
  const s = await state();
  expect((await profile.getProfile(s, oz.address)).name).toBe("Oz");
  expect((await profile.getProfile(s, nia.address)).name).toBeUndefined();
});

test("paying from another wallet: the QR code on checkout, opened in Selfhold elsewhere, buys the name", async ({ page }) => {
  const pia = newAccount();
  const quinn = newAccount();
  await fund(pia.address, 100n);
  await fund(quinn.address, 600n);
  await writeAs(pia, await profile.claim(await state(), pia.address, "piasale", 500n));
  await until("@piasale for sale at 500", async () => (await profile.resolve(await state(), "piasale"))?.price === 500n);

  // A visitor's browser, with no wallet: the order, as a code and as text.
  const visitor = await browser.newPage();
  await openApp(visitor, null, "#/buy/piasale");
  await expect(visitor.locator("#get-wallet")).toBeVisible();
  await visitor.getByText("Pay from another wallet or device").click();
  await expect(visitor.locator("#elsewhere")).toContainText("In Selfhold, choose Open request");
  const request = await visitor.getByRole("button", { name: "Copy request" }).getAttribute("data-copy");
  expect(request).toMatch(/^lattice:\/\/write\?v=1&intent=/);
  const code = Buffer.from((await visitor.locator("img.qr").getAttribute("src")).split(",")[1], "base64");
  const image = `${mkdtempSync(`${tmpdir()}/moniker-qr-`)}/request.gif`;
  writeFileSync(image, code);

  // Quinn's Selfhold, in another browser, never connected to Moniker: it reads the code.
  const context = page.context();
  await walletHolds(context, quinn);
  const popup = await context.newPage();
  await popup.goto(`${context.walletOrigin}/popup/index.html`);
  await popup.getByRole("button", { name: "Open request" }).click();
  await popup.locator('input[type="file"]').setInputFiles(image);
  await expect(popup.getByText("Review it in the window that opened.")).toBeVisible();
  await until("one approval", async () => context.approvals === 1);

  // The visitor's page saw the name change hands.
  await expect(visitor).toHaveURL(/#\/bought\/piasale$/, { timeout: 120_000 });
  await expect(visitor.locator("main")).toContainText(`It's held by ${quinn.address.slice(0, 7)}`);
  await visitor.close();
  const s = await state();
  expect((await profile.resolve(s, "piasale")).holder).toBe(quinn.address);
  expect((await profile.getProfile(s, quinn.address)).handle).toBe("piasale");
  expect(BigInt((await account(pia.address)).balance)).toBeGreaterThan(500n);
});

test("a request copied from checkout is refused once it has expired, or after the name was taken", async ({ page }) => {
  const rae = newAccount();
  const sam = newAccount();
  const context = page.context();
  await walletHolds(context, rae);
  await openApp(page, null, "#/buy/samsnext");
  await page.getByText("Pay from another wallet or device").click();
  const request = await page.getByRole("button", { name: "Copy request" }).getAttribute("data-copy");
  // Someone else takes it first: Rae's request, opened later, is refused by the chain and pays nothing.
  await fund(sam.address, 100n);
  await writeAs(sam, await profile.claim(await state(), sam.address, "samsnext"));
  await until("@samsnext taken", async () => (await profile.resolve(await state(), "samsnext"))?.holder === sam.address);
  const popup = await context.newPage();
  await popup.goto(`${context.walletOrigin}/popup/index.html`);
  await popup.getByRole("button", { name: "Open request" }).click();
  await popup.locator("textarea").fill(request);
  await popup.getByRole("button", { name: "Use pasted text" }).click();
  await until("the window answered", async () => context.approvals === 1);
  expect((await profile.resolve(await state(), "samsnext")).holder).toBe(sam.address);
  expect(await profile.heldBy(await state(), rae.address)).toEqual([]);

  // Past its expiry, the wallet refuses it outright.
  const old = request.replace(/intent=([^&]+)/, (_, b64) => {
    const intent = JSON.parse(Buffer.from(b64, "base64url").toString());
    return `intent=${Buffer.from(JSON.stringify({ ...intent, expiresAt: "2020-01-01T00:00:00.000Z" })).toString("base64url")}`;
  });
  await popup.reload();
  await popup.getByRole("button", { name: "Open request" }).click();
  await popup.locator("textarea").fill(old);
  await popup.getByRole("button", { name: "Use pasted text" }).click();
  await expect(popup.getByText("This request has expired")).toBeVisible();
  expect(context.approvals).toBe(1);
});
