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
import * as follows from "../../follows/src/records/follows.mjs";
import { CHAIN, FOLLOWS, start } from "./stack.mjs";

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
  await until("funds", async () => BigInt((await account(to)).balance ?? 0) >= amount);
}
async function state() {
  const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${stack.node}/volumes`, { chainPath: CHAIN }));
  const { generalStateCID } = await tip(sdk, stack.node, CHAIN, volumes);
  return view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID);
}
/** `who` claims `handle` as another client would, with `card` (if any) for it in the same write. */
/** `who` makes a profile with `handle` and `card` as another client would; resolves to its id. */
async function makeAs(who, handle, card) {
  await fund(who.address, 100n);
  const { id, write } = await profile.createProfile(await state(), who.address, { handle });
  // The card as written, unchecked: another client may write anything.
  await writeAs(who, card ? profile.combine(write, { actions: [{ key: profile.cardKey(id), newValue: JSON.stringify(card) }] }) : write);
  await until(`@${handle}`, async () => (await profile.resolve(await state(), handle))?.profile === id);
  return id;
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
  await page.addInitScript(({ node, chain, follows }) => {
    if (sessionStorage.getItem("moniker-test-seeded")) return;
    sessionStorage.setItem("moniker-test-seeded", "1");
    localStorage.setItem("moniker.settings", JSON.stringify({ nodes: [node], chain, follows }));
  }, { node: stack.node, chain: stack.chain, follows: stack.follows });
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
    // Connected: your profile (with Edit), or My profiles when you have none or several.
    await expect(page.getByRole("link", { name: "Edit", exact: true }).or(page.getByRole("heading", { name: "My profiles" }))).toBeVisible();
    expect(page.context().approvals).toBe(before + 1);
    if (hash !== "#/me") await page.goto(stack.app + hash);
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
const carol = newAccount();
let alices; // Alice's profile

/** The profile holding `@handle` on the chain. */
const holding = async (handle) => profile.profileOf(await state(), handle);
/** A name's row in My profiles. */
const nameRowOf = (page, handle) => page.locator(".row", { has: page.getByRole("button", { name: `Options for @${handle}`, exact: true }) });
/** Opens a name's menu and picks `choice`. */
async function nameMenu(page, handle, choice) {
  await page.getByRole("button", { name: `Options for @${handle}`, exact: true }).click();
  await page.locator("#sheet").getByRole("button", { name: choice }).click();
}
/** Opens a profile's menu and picks `choice`. */
async function profileMenu(page, name, choice) {
  await page.getByRole("button", { name: `Options for ${name}`, exact: true }).click();
  await page.locator("#sheet").getByRole("button", { name: choice }).click();
}

/** The one sheet's input, and its confirm button. */
async function answerSheet(page, value, confirm) {
  if (value !== undefined) await page.locator("#sheet-input").fill(value);
  await page.locator("#sheet").getByRole("button", { name: confirm }).click();
}

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
  // A profile no one holds is the same search.
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
  // Where a key is needed, the same panel instead of an error; old links go there too.
  await page.goto(stack.app + "#/names");
  await expect(page).toHaveURL(/#\/profiles$/);
  await expect(page.locator("#get-wallet")).toHaveText("Your profiles belong to your wallet's key");

  // A phone can't add Selfhold: it is offered the link to finish on a computer.
  const phone = await browser.newContext({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" });
  const p = await phone.newPage();
  await openApp(p, null, "#/buy/nobody");
  await expect(p.getByRole("button", { name: "Copy this page's link" })).toBeVisible();
  await expect(p.getByRole("link", { name: /^Add Selfhold/ })).toHaveCount(0);
  await phone.close();
}, { wallet: false });

test("Alice buys @alice for 0: it makes her first profile, in one approval", async ({ page }) => {
  await fund(alice.address);
  await openApp(page, alice, "#/search/alice");
  await page.getByRole("link", { name: "Buy @alice", exact: true }).click();
  await expect(page.locator("h1")).toHaveText("Checkout");
  await expect(page.locator(".order")).toHaveText("@alice");
  // No profile yet: it goes on a new one, no choice to make.
  await expect(page.locator("#to")).toHaveCount(0);
  await expect(page.locator("form#buy")).toContainText("This makes your profile: the public card people follow.");
  const asked = page.context().approvals;
  await page.getByRole("button", { name: /^Get @\w+ free$/ }).click();
  await expect(page).toHaveURL(/#\/bought\/alice$/);
  await expect(page.locator("h1")).toHaveText("@alice is yours");
  expect(page.context().approvals).toBe(asked + 1);
  const mine = await profile.profilesOf(await state(), alice.address);
  expect(mine.map((p) => p.handle)).toEqual(["alice"]);
  alices = mine[0].id;
});

test("Alice sets up her profile: name, bio, website and links in her order", async ({ page }) => {
  await openApp(page, alice, "#/bought/alice");
  await page.getByRole("link", { name: "Set up the profile" }).click();
  await expect(page).toHaveURL(new RegExp(`#/edit/${alices}$`));
  await expect(page.locator("h1")).toHaveText("Edit profile");
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
  const asked = page.context().approvals;
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/@alice$/);
  await expect(page.locator("h1")).toHaveText("Alice Rivera");
  await expect(page.locator(".bio")).toHaveText("Builds open tools.");
  await expect(page.locator(".links a")).toHaveText(["alice.example", "GitHub", "Newsletter"]);
  expect(page.context().approvals).toBe(asked + 1);
  expect((await holding("alice")).links).toEqual([{ label: "GitHub", url: "https://github.com/alice" }, { label: "Newsletter", url: "https://news.example" }]);

  const visitor = await browser.newPage();
  await openApp(visitor, null, "#/search/alice");
  await expect(visitor.locator(".result .badge")).toHaveText("Taken");
  await visitor.getByRole("link", { name: "See @alice's profile" }).click();
  await expect(visitor.locator("h1")).toHaveText("Alice Rivera");
  await expect(visitor.getByRole("link", { name: "Edit" })).toHaveCount(0);
  // Its owner, by the end of the account's ID; that page lists the account's profiles.
  await visitor.getByRole("link", { name: `Owner: account …${alice.address.slice(-8)}` }).click();
  await expect(visitor.locator("h1.account")).toContainText(`…${alice.address.slice(-8)}`);
  await expect(visitor.locator(".names .row strong")).toHaveText(["Alice Rivera"]);
  await visitor.close();
});

test("another app shows Alice's profile with <moniker-name>, linked to its page", async ({ page }) => {
  const query = new URLSearchParams({ profile: alices, node: stack.node, chain: stack.chain });
  await page.goto(`${stack.app.replace(/app\/$/, "sdk/")}demo.html?${query}`);
  const byline = page.locator("moniker-name");
  await expect(byline.locator(".name")).toHaveText("Alice Rivera");
  await expect(byline.locator(".handle")).toHaveText("@alice");
  await expect(byline.locator("a")).toHaveAttribute("href", "https://adalinxx.github.io/moniker/app/#/%40alice");
}, { wallet: false });

test("a second name on the same profile: chosen at checkout, shown on request, listed as Also", async ({ page }) => {
  await openApp(page, alice, "#/buy/alice_art");
  await expect(page.locator("#to")).toHaveValue(alices);
  await page.getByRole("button", { name: /^Get @\w+ free$/ }).click();
  await expect(page.locator("h1")).toHaveText("@alice_art is yours");
  expect((await profile.resolve(await state(), "alice_art")).profile).toBe(alices);
  await page.goto(stack.app + `#/${alices}`);
  // Still shows @alice; the other name is listed.
  await expect(page.locator("p.handle")).toHaveText("@alice");
  await expect(page.locator(".also")).toHaveText("Also @alice_art");
  await page.goto(stack.app + "#/profiles");
  const [first, art] = [nameRowOf(page, "alice"), nameRowOf(page, "alice_art")];
  await expect(first.locator(".label")).toContainText("main name");
  await nameMenu(page, "alice_art", "Make main name");
  await expect(art.locator(".label")).toContainText("main name");
  expect((await profile.getProfile(await state(), alices)).handle).toBe("alice_art");
  // Focus is back on the menu button that was used.
  await expect(page.getByRole("button", { name: "Options for @alice_art", exact: true })).toBeFocused();
  await nameMenu(page, "alice", "Make main name");
  await expect(first.locator(".label")).toContainText("main name");
});

test("Alice sells @alice_art; Bob buys it onto a new profile, and Alice's profile keeps its card", async ({ page }) => {
  await openApp(page, alice, "#/profiles");
  const art = nameRowOf(page, "alice_art");
  await nameMenu(page, "alice_art", "Sell");
  await expect(page.locator("#sheet")).toContainText("Only the name moves: Alice Rivera keeps its card and followers.");
  await answerSheet(page, "05", "List it");
  await expect(page.locator("#sheet-error")).toHaveText("A whole number of coins.");
  await answerSheet(page, "500", "List it");
  await expect(art.locator(".label")).toContainText("for sale · 500");

  await fund(bob.address);
  const bobContext = await walletBrowser();
  try {
    const bobPage = bobContext.pages()[0] ?? (await bobContext.newPage());
    await openApp(bobPage, bob, "#/market");
    await bobPage.getByRole("link", { name: "Buy @alice_art for 500" }).click();
    await expect(bobPage.locator(".sum")).toContainText("paid to its owner");
    await expect(bobPage.locator("main")).toContainText("Only the name moves: its old profile stays with its owner.");
    await bobPage.getByRole("button", { name: "Buy for 500" }).click();
    await expect(bobPage.locator("h1")).toHaveText("@alice_art is yours");
    await expect(bobPage.getByRole("link", { name: "Set up the profile" })).toBeVisible();
  } finally {
    await bobContext.close();
  }
  const bobs = await holding("alice_art");
  expect(bobs.owner).toBe(bob.address);
  expect(bobs.id).not.toBe(alices);
  expect(BigInt((await account(alice.address)).balance)).toBeGreaterThan(2000n);
  // @alice_art's page is Bob's empty profile; @alice's is still Alice's.
  await page.goto(stack.app + "#/@alice_art");
  await expect(page.locator("h1")).toHaveText("@alice_art");
  await expect(page.locator(".bio, .links")).toHaveCount(0);
  await page.goto(stack.app + "#/@alice");
  await expect(page.locator("h1")).toHaveText("Alice Rivera");
  await expect(page.locator(".also")).toHaveCount(0);
});

test("a name given by link: Alice offers @alice_gift to Bob's profile, and only Bob takes it", async ({ page }) => {
  await writeAs(alice, await profile.claim(await state(), alice.address, alices, "alice_gift"));
  await until("@alice_gift", async () => (await profile.resolve(await state(), "alice_gift"))?.profile === alices);
  const bobs = (await profile.profilesOf(await state(), bob.address))[0];
  await openApp(page, alice, "#/profiles");
  await nameMenu(page, "alice_gift", "Give");
  await answerSheet(page, "@alice_art", "Offer it");
  await expect(toast(page, "Offered. Link copied: send it to them.")).toBeVisible();
  await expect(nameRowOf(page, "alice_gift").locator(".label")).toContainText("offered");
  // The link stays on the row, to copy again.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await nameRowOf(page, "alice_gift").getByRole("button", { name: /^Copy link/ }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/#\/take\/alice_gift$/);
  // Not Carol's to take.
  const carolContext = await walletBrowser();
  try {
    const carolPage = carolContext.pages()[0] ?? (await carolContext.newPage());
    await openApp(carolPage, carol, "#/take/alice_gift");
    await expect(carolPage.locator("h1")).toHaveText("@alice_gift isn't offered to a profile of yours");
    await expect(carolPage.locator("main")).toContainText(`Selfhold connects account …${carol.address.slice(-8)} here.`);
  } finally {
    await carolContext.close();
  }
  const bobContext = await walletBrowser();
  try {
    const bobPage = bobContext.pages()[0] ?? (await bobContext.newPage());
    await openApp(bobPage, bob, "#/take/alice_gift");
    await bobPage.getByRole("button", { name: "Take @alice_gift" }).click();
    await expect(bobPage).toHaveURL(/#\/@alice_gift$/);
  } finally {
    await bobContext.close();
  }
  expect((await profile.resolve(await state(), "alice_gift")).profile).toBe(bobs.id);
});

test("Alice sells her whole profile; Carol buys it, card and names with it", async ({ page }) => {
  await fund(carol.address);
  await openApp(page, alice, "#/profiles");
  await profileMenu(page, "Alice Rivera", "Sell profile");
  await expect(page.locator("#sheet-title")).toHaveText("Sell Alice Rivera");
  await expect(page.locator("#sheet")).toContainText("its card, followers and names all go with it");
  await answerSheet(page, "700", "List it");
  await expect(page.locator(".profile-head .label")).toContainText("for sale · 700");
  const carolContext = await walletBrowser();
  try {
    const carolPage = carolContext.pages()[0] ?? (await carolContext.newPage());
    await openApp(carolPage, carol, "#/@alice");
    await expect(carolPage.locator("main .note", { hasText: "Its owner is selling" })).toHaveText("Its owner is selling this profile, names and all, for 700. Buy it");
    await carolPage.getByRole("link", { name: "Buy it" }).click();
    await expect(carolPage.locator("main")).toContainText("It comes whole: its card, its followers and its names, @alice");
    await carolPage.getByRole("button", { name: "Buy for 700" }).click();
    await expect(carolPage.locator("h1")).toHaveText("Alice Rivera");
    await expect(carolPage.getByRole("link", { name: "Owner: you" })).toBeVisible();
  } finally {
    await carolContext.close();
  }
  const p = await profile.getProfile(await state(), alices);
  expect([p.owner, p.name, p.handle]).toEqual([carol.address, "Alice Rivera", "alice"]);
  expect(await profile.profilesOf(await state(), alice.address)).toEqual([]);
});

test("a profile moves to a new key: offered to that account, taken from a link", async ({ page }) => {
  const newKey = newAccount();
  await openApp(page, carol, "#/profiles");
  await profileMenu(page, "Alice Rivera", "Give profile");
  await answerSheet(page, newKey.address, "Offer it");
  await expect(toast(page, "Offered. Link copied: send it to them.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy link to take Alice Rivera" })).toBeVisible();
  const keyContext = await walletBrowser();
  try {
    const keyPage = keyContext.pages()[0] ?? (await keyContext.newPage());
    await fund(newKey.address, 10n);
    await openApp(keyPage, newKey, `#/take-profile/${alices}`);
    await expect(keyPage.locator("h1")).toHaveText("A profile for you");
    await keyPage.getByRole("button", { name: "Take it" }).click();
    await expect(keyPage.getByRole("link", { name: "Owner: you" })).toBeVisible();
  } finally {
    await keyContext.close();
  }
  expect((await profile.getProfile(await state(), alices)).owner).toBe(newKey.address);
});

test("admins are added and removed on the edit page; they can't edit the profile", async ({ page }) => {
  const dee = newAccount();
  const id = await makeAs(dee, "dee", { name: "Dee" });
  await openApp(page, dee, `#/edit/${id}`);
  await page.getByRole("button", { name: "+ Add admin" }).click();
  await answerSheet(page, "not-an-account", "Add admin");
  await expect(page.locator("#sheet-error")).toHaveText("That is not an account ID.");
  await answerSheet(page, bob.address, "Add admin");
  await expect(page.locator('[role="group"][aria-label^="Admin"]')).toHaveCount(1);
  expect(await profile.actsFor(await state(), bob.address, id)).toBe(true);
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.locator('[role="group"][aria-label^="Admin"]')).toHaveCount(0);
  expect(await profile.actsFor(await state(), bob.address, id)).toBe(false);
});

test("New profile makes an empty one and opens its editor", async ({ page }) => {
  await openApp(page, bob, "#/profiles");
  const before = (await profile.profilesOf(await state(), bob.address)).length;
  await page.getByRole("button", { name: "New profile" }).click();
  await expect(page).toHaveURL(/#\/edit\/[a-z2-7]{16}$/);
  await expect(page.locator("h1")).toHaveText("Edit profile");
  expect((await profile.profilesOf(await state(), bob.address)).length).toBe(before + 1);
});

test("links another client wrote are shown only when they are web addresses", async ({ page }) => {
  const cleo = newAccount();
  await makeAs(cleo, "cleo", { name: "Cleo", url: "javascript:alert(1)", links: [{ label: "Evil", url: "javascript:alert(1)" }, { label: "Fine", url: "https://fine.example" }] });
  await openApp(page, null, "#/@cleo");
  await expect(page.locator("h1")).toHaveText("Cleo");
  await expect(page.locator(".links a")).toHaveText(["Fine"]);
}, { wallet: false });

test("a newcomer with no coins searches, buys @erin for 0 in one approval, then sets up the profile", async ({ page }) => {
  const erin = newAccount();
  assert.equal(BigInt((await account(erin.address)).balance ?? 0), 0n);
  await walletHolds(page.context(), erin);
  await openApp(page, null, "#/");
  await page.locator("#q").fill("erin");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("link", { name: "Buy @erin", exact: true }).click();
  // Checkout asks the wallet for nothing until Buy, which connects, then buys.
  await expect(page).toHaveURL(/#\/buy\/erin$/);
  assert.equal(page.context().approvals, 0);
  await page.getByRole("button", { name: /^Get @\w+ free$/ }).click();
  await expect(page.locator("h1")).toHaveText("@erin is yours");
  // Connecting, and one write that made the profile and put the name on it.
  assert.equal(page.context().approvals, 2);
  await page.getByRole("link", { name: "Set up the profile" }).click();
  await page.locator("#name").fill("Erin Vale");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/@erin$/);
  await expect(page.locator("h1")).toHaveText("Erin Vale");
});

test("Your page: a new account sees My profiles, one with a profile sees it", async ({ page }) => {
  const dan = newAccount();
  await openApp(page, dan, "#/me");
  await expect(page.locator("h1")).toHaveText("My profiles");
  await expect(page.locator(".note")).toContainText("No profiles yet.");
  await expect(page.getByRole("button", { name: "New profile" })).toHaveCount(0);
  const context = await walletBrowser();
  try {
    const bobPage = context.pages()[0] ?? (await context.newPage());
    const fresh = newAccount();
    await makeAs(fresh, "freshone", { name: "Fresh One" });
    await openApp(bobPage, fresh, "#/me");
    await expect(bobPage.locator("h1")).toHaveText("Fresh One");
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
  await expect(page.locator("h1")).toHaveText("My profiles");
  const id = await makeAs(frank, "frank");
  await page.goto(stack.app + `#/edit/${id}`);
  await page.locator("#name").fill("Frank");
  context.answer = "decline";
  await page.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "You declined it in the wallet. Nothing was sent.")).toBeVisible();
  expect(context.declines).toBe(2);
  expect((await profile.getProfile(await state(), id)).name).toBeUndefined();
});

test("checkout refuses a price that changed, or a name just taken, and asks the wallet nothing", async ({ page }) => {
  const gwen = newAccount();
  const hal = newAccount();
  // Hal can pay the 100 he is shown, so it is the price check that stops him.
  await fund(hal.address, 150n);
  const gwens = await makeAs(gwen, "gwensale");
  await writeAs(gwen, await profile.list(await state(), gwen.address, "gwensale", 100n));
  await until("@gwensale for sale at 100", async () => (await profile.resolve(await state(), "gwensale"))?.price === 100n);
  const context = page.context();
  await openApp(page, hal, "#/buy/gwensale");
  await expect(page.getByRole("button", { name: "Buy for 100" })).toBeVisible();
  // Gwen asks more before Hal presses Buy.
  await writeAs(gwen, await profile.list(await state(), gwen.address, "gwensale", 200n));
  await until("@gwensale at 200", async () => (await profile.resolve(await state(), "gwensale"))?.price === 200n);
  const asked = context.approvals;
  await page.getByRole("button", { name: "Buy for 100" }).click();
  await expect(toast(page, "The price of @gwensale just changed. Look again.")).toBeVisible();

  // A name no one owned, taken while Hal looks at it.
  await page.goto(stack.app + "#/buy/halsnext");
  await expect(page.getByRole("button", { name: /^Get @\w+ free$/ })).toBeVisible();
  await writeAs(gwen, await profile.claim(await state(), gwen.address, gwens, "halsnext"));
  await until("@halsnext taken", async () => (await profile.resolve(await state(), "halsnext"))?.profile === gwens);
  await page.getByRole("button", { name: /^Get @\w+ free$/ }).click();
  await expect(toast(page, "@halsnext was just taken, and it isn't for sale.")).toBeVisible();
  expect(context.approvals).toBe(asked);
  expect(await profile.profilesOf(await state(), hal.address)).toEqual([]);
});

test("if Selfhold forgets this site while Moniker is open, a save sends nothing and offers to connect again", async ({ page }) => {
  const kit = newAccount();
  const context = page.context();
  const id = await makeAs(kit, "kit");
  await openApp(page, kit, `#/edit/${id}`);
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


test("a photo kept on your own node goes on the profile, and visitors see it", async ({ page }) => {
  const lu = newAccount();
  const id = await makeAs(lu, "lu");
  await openApp(page, lu, `#/edit/${id}`);
  await page.locator("#photo").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await expect(toast(page, "Choose a PNG, JPEG, GIF, WebP or AVIF image.")).toBeVisible();
  await page.locator("#photo").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
  await expect(toast(page, "Photos are kept by your own node. Set it in Settings first.")).toBeVisible();

  await page.goto(stack.app + "#/settings");
  await page.locator("#s-own").fill(stack.rpc);
  await page.locator("#s-cookie").fill(readFileSync(`${stack.root}/chains/Nexus/.cookie`, "utf8").trim());
  await page.getByRole("button", { name: "Save" }).click();
  await page.goto(stack.app + `#/edit/${id}`);
  await page.locator("#name").fill("Lu");
  await page.locator("#photo").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
  await expect(toast(page, "Photo kept. Save to put it on the page.")).toBeVisible();
  await page.locator("#name").fill("Lu");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("h1")).toHaveText("Lu");
  await expect(page.locator("img.avatar")).toHaveAttribute("src", /^blob:/);
  expect((await profile.getProfile(await state(), id)).avatar).toMatch(/^bafy/);

  const visitor = await browser.newPage();
  await openApp(visitor, null, "#/@lu");
  await expect(visitor.locator("img.avatar")).toHaveAttribute("src", /^blob:/);
  await visitor.close();
});

test("a card another client wrote shows as text, long ones fit a phone, and odd searches are refused", async ({ page }) => {
  const mo = newAccount();
  const long = "w".repeat(300);
  const name = `<img src=x onerror="window.__hit=1">Mo`;
  await makeAs(mo, "mo_card", { name, description: `${long}\n<script>window.__hit=2</script>`, links: [{ label: `<b>bold</b> ${long}`, url: `https://example.com/${long}` }] });
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, null, "#/@mo_card");
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
  await expect(page.getByRole("button", { name: /^Get @\w+ free$/ })).toBeVisible();
  await expect(page.locator("#get-wallet")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("moniker.awaitingWallet"))).toBeNull();
}, { wallet: false });

test("if Selfhold now connects this site to another account, a save sends nothing and the page shows that account", async ({ page }) => {
  const nia = newAccount();
  const oz = newAccount();
  const context = page.context();
  const nias = await makeAs(nia, "nia");
  const ozs = await makeAs(oz, "oz");
  await openApp(page, nia, `#/edit/${nias}`);
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
  // Nia's profile isn't Oz's to edit; his own is, and Nia's card is untouched.
  await expect(page.locator("h1")).toHaveText("This profile isn't yours");
  await page.goto(stack.app + `#/edit/${ozs}`);
  await page.locator("#name").fill("Oz");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("h1")).toHaveText("Oz");
  const s = await state();
  expect((await profile.getProfile(s, ozs)).name).toBe("Oz");
  expect((await profile.getProfile(s, nias)).name).toBeUndefined();
});

test("checkout says when an account is short, and still leaves paying to the wallet", async ({ page }) => {
  const pia = newAccount();
  const quinn = newAccount();
  await makeAs(pia, "piasale");
  await writeAs(pia, await profile.list(await state(), pia.address, "piasale", 500n));
  await until("@piasale for sale at 500", async () => (await profile.resolve(await state(), "piasale"))?.price === 500n);
  const pias = (await profile.resolve(await state(), "piasale")).profile;
  const context = page.context();
  await openApp(page, quinn, "#/buy/piasale");
  await expect(page.locator("#short")).toHaveText("This costs 500. Your account has 0 on this chain.");
  // Another wallet might bring the coins in its own way: Buy still asks it.
  const asked = context.approvals;
  context.answer = "decline";
  await page.getByRole("button", { name: "Buy for 500" }).click();
  await expect(toast(page, "You declined it in the wallet. Nothing was sent.")).toBeVisible();
  expect(context.declines).toBe(1);
  expect(context.approvals).toBe(asked);
  expect((await profile.resolve(await state(), "piasale")).profile).toBe(pias);

  // An account that can pay is told nothing.
  await fund(quinn.address, 600n);
  await page.reload();
  await expect(page.getByRole("button", { name: "Buy for 500" })).toBeVisible();
  await expect(page.locator("#short")).toHaveCount(0);
});

// ---------------------------------------------------------------- follows

/** The Follows chain's state at the node's tip. */
async function followsState() {
  const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${stack.node}/volumes`, { chainPath: FOLLOWS }));
  const { generalStateCID } = await tip(sdk, stack.node, FOLLOWS, volumes);
  return view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID);
}
/** Whether an account acts for a profile on Moniker now: how a follow counts. */
const actsFor = async (account, p) => profile.actsFor(await state(), account, p);

/** `who`, as its profile `as`, follows each of the profiles `targets`, as another app would. */
async function followAs(who, as, ...targets) {
  const s = await followsState();
  const actions = [];
  for (const t of targets) actions.push(...(await follows.follow(s, who.address, as, t)).actions);
  const nonce = BigInt((await (await fetch(`${stack.node}/api/state/account/${who.address}?chainPath=${stack.follows}`)).json().catch(() => ({}))).nonce ?? 0);
  await submit(who, transaction({ owner: who.address, actions, fee: 0n, nonce, chainPath: FOLLOWS }));
  await until("the follows land", async () => {
    const now = await followsState();
    for (const t of targets) if (!(await follows.follows(now, as, t, actsFor))) return false;
    return true;
  });
}
const followButton = (page) => page.locator("follows-button button");
const counts = (page) => page.locator(".counts a");

const tess = newAccount(); // a bakery
const uma = newAccount();
let tessbakes, umas;

test("a profile's page counts its followers, and Follow follows the profile", async ({ page }) => {
  tessbakes = await makeAs(tess, "tessbakes", { name: "Tess Bakes" });
  umas = await makeAs(uma, "uma", { name: "Uma Reyes" });
  await followAs(uma, umas, tessbakes);

  await openApp(page, null, "#/@tessbakes");
  await expect(page.locator("h1")).toHaveText("Tess Bakes");
  await expect(counts(page)).toHaveText(["1 follower", "0 following"]);
  await expect(followButton(page)).toHaveText("Follow @tessbakes");
  await expect(page.locator("main")).not.toContainText("bafyrei");
  // The owner, by the end of its ID: its page lists the account's profiles, and has no Follow.
  await page.getByRole("link", { name: `Owner: account …${tess.address.slice(-8)}` }).click();
  await expect(page.locator(".names .row strong")).toHaveText(["Tess Bakes"]);
  await expect(followButton(page)).toHaveCount(0);
}, { wallet: false });

test("the counts open the lists: who follows a profile, and whom it follows", async ({ page }) => {
  await openApp(page, null, "#/@tessbakes");
  await counts(page).first().click();
  await expect(page).toHaveURL(new RegExp(`#/${tessbakes}/followers$`));
  await expect(page.locator("h1")).toHaveText("@tessbakes's followers");
  await expect(page.locator(".row.person strong")).toHaveText(["Uma Reyes"]);
  await page.locator(".row.person").click();
  await expect(page.locator("h1")).toHaveText("Uma Reyes");
  await counts(page).nth(1).click();
  await expect(page.locator("h1")).toHaveText("@uma follows");
  await expect(page.locator(".row.person strong")).toHaveText(["Tess Bakes"]);
}, { wallet: false });

test("following a profile from its page: one approval, saving, then counted", async ({ page }) => {
  const wren = newAccount();
  const wrens = await makeAs(wren, "wren", { name: "Wren" });
  const context = page.context();
  await openApp(page, wren, "#/@tessbakes");
  await expect(followButton(page)).toHaveText("Follow @tessbakes");
  const before = context.approvals;
  await followButton(page).click();
  await expect(followButton(page)).toHaveText("Following @tessbakes");
  await expect(page.locator("follows-button .note")).toHaveText("Saved.");
  expect(context.approvals).toBe(before + 1);
  await expect(counts(page).first()).toHaveText("2 followers");
  expect(await follows.follows(await followsState(), wrens, tessbakes, actsFor)).toBe(true);
  // Following again unfollows.
  await expect(page.locator("follows-button .note")).toHaveText("", { timeout: 10_000 });
  await followButton(page).click();
  await expect(followButton(page)).toHaveText("Follow @tessbakes");
  await expect(page.locator("follows-button .note")).toHaveText("Saved.");
  await expect(counts(page).first()).toHaveText("1 follower");
});

test("an account with no profile is told to make one, and nothing is sent", async ({ page }) => {
  const zed = newAccount();
  const context = page.context();
  await openApp(page, zed, "#/@tessbakes");
  const before = context.approvals;
  await followButton(page).click();
  await expect(page.locator("follows-button .note")).toHaveText("To follow, get a name first. It makes your profile.");
  expect(context.approvals).toBe(before);
});

test("declining the follow in Selfhold sends nothing and says so", async ({ page }) => {
  const yara = newAccount();
  const yaras = await makeAs(yara, "yara");
  const context = page.context();
  await openApp(page, yara, "#/@tessbakes");
  context.answer = "decline";
  await followButton(page).click();
  await expect(page.locator("follows-button .note")).toHaveText("Canceled in Selfhold. Nothing was sent.");
  await expect(followButton(page)).toHaveText("Follow @tessbakes");
  expect(await follows.follows(await followsState(), yaras, tessbakes, actsFor)).toBe(false);
});

test("a visitor without Selfhold is told how to follow", async ({ page }) => {
  await openApp(page, null, "#/@tessbakes");
  await followButton(page).click();
  await expect(page.locator("follows-button .note")).toContainText("To follow, add Selfhold");
}, { wallet: false });

test("your own profile shows its counts but no Follow button", async ({ page }) => {
  await openApp(page, uma, "#/me");
  await expect(page.locator("h1")).toHaveText("Uma Reyes");
  await expect(counts(page)).toHaveText(["0 followers", "1 following"]);
  await expect(followButton(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Owner: you" })).toHaveAttribute("href", `#/${uma.address}`);
});

test("if Follows can't be reached, a page still shows, without counts", async ({ page }) => {
  await page.route((url) => url.searchParams.get("chainPath") === stack.follows, (route) => route.abort());
  await openApp(page, null, "#/@tessbakes");
  await expect(page.locator("h1")).toHaveText("Tess Bakes");
  await expect(page.locator("p.handle")).toHaveText("@tessbakes");
  await expect(counts(page)).toHaveCount(0);
}, { wallet: false, expectedErrors: /Failed to load resource|net::ERR_FAILED/ });

test("a long list shows 50, then all of them on request", async ({ page }) => {
  // One account with 55 profiles, made five to a write, each following @tessbakes.
  const fan = newAccount();
  await fund(fan.address, 100n);
  const made = [];
  for (let i = 0; i < 55; i += 5) {
    const batch = [];
    for (let j = i; j < i + 5; j++) batch.push(await profile.createProfile(await state(), fan.address, { card: { name: `Fan ${j}` } }));
    await writeAs(fan, profile.combine(...batch.map((m) => m.write)));
    const last = batch.at(-1).id;
    await until(`${i + 5} profiles`, async () => (await profile.profileToken(await state(), last))?.owner === fan.address, 300);
    made.push(...batch);
  }
  // Their follows, nine to a write.
  for (let i = 0; i < made.length; i += 9) {
    const s = await followsState();
    const actions = [];
    for (const m of made.slice(i, i + 9)) actions.push(...(await follows.follow(s, fan.address, m.id, tessbakes)).actions);
    const nonce = BigInt((await (await fetch(`${stack.node}/api/state/account/${fan.address}?chainPath=${stack.follows}`)).json().catch(() => ({}))).nonce ?? 0);
    await submit(fan, transaction({ owner: fan.address, actions, fee: 0n, nonce, chainPath: FOLLOWS }));
    const last = made.slice(i, i + 9).at(-1).id;
    await until(`follows up to ${i + 9}`, async () => (await followsState()).get(follows.followKey(last, tessbakes, fan.address)).then((v) => v !== undefined), 300);
  }
  await openApp(page, null, "#/@tessbakes/followers");
  await expect(page.locator(".row.person")).toHaveCount(50);
  await page.getByRole("button", { name: /^Show all \d+$/ }).click();
  await expect(page.locator(".row.person")).toHaveCount(56);
  await expect(page.getByRole("button", { name: /^Show all/ })).toHaveCount(0);
}, { wallet: false, timeout: 600_000 });
