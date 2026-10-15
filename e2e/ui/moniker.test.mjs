// Moniker through the real page in headless Chromium with the Lattice Wallet
// installed, against a private stack (stack.mjs). The person here approves
// whatever the wallet asks.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js \
//   LATTICE_WALLET=<lattice-wallet>/dist npm test
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, test as nodeTest } from "node:test";
import { chromium, expect as baseExpect } from "@playwright/test";
import * as profile from "../../client/profile.mjs";
import { tip, view, volumeLoader } from "../../client/state.mjs";
import { transaction } from "../../client/wallet.mjs";
import { CHAIN, start } from "./stack.mjs";

const wallet = process.env.LATTICE_WALLET && fileURLToPath(new URL(process.env.LATTICE_WALLET, `file://${process.cwd()}/`));
if (!wallet) throw new Error("LATTICE_WALLET: the built Lattice Wallet extension (its dist/ directory)");
// The wallet as installed by someone who runs the stack's node.
const walletInstalled = mkdtempSync(`${tmpdir()}/moniker-ui-wallet-`);
cpSync(wallet, walletInstalled, { recursive: true });
const manifest = JSON.parse(readFileSync(`${walletInstalled}/manifest.json`, "utf8"));
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

/** A browser with the wallet installed; each approval window is answered Connect or Sign, and counted. */
async function walletBrowser() {
  const context = await chromium.launchPersistentContext(mkdtempSync(`${tmpdir()}/moniker-ui-browser-`), {
    headless: false,
    args: ["--headless=new", `--disable-extensions-except=${walletInstalled}`, `--load-extension=${walletInstalled}`],
  });
  const [worker] = context.serviceWorkers().length ? context.serviceWorkers() : [await context.waitForEvent("serviceworker")];
  context.walletOrigin = worker.url().split("/").slice(0, 3).join("/");
  context.approvals = 0;
  context.walletNotes = []; // what a wallet window said when its button never woke
  context.on("page", (opened) => respond(opened).catch(() => {}));
  async function respond(opened) {
    await opened.waitForLoadState().catch(() => {});
    if (!opened.url().includes("/approve/index.html")) return;
    // The approving button wakes only in a focused window, once everything
    // that decides the request has been seen: as a person, look, then press.
    await opened.bringToFront();
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

/** Opens the app pointed at the stack, as `who` (connected through the wallet) or as a visitor. */
async function openApp(page, who, hash = "#/") {
  await page.addInitScript(({ node, chain }) => {
    if (sessionStorage.getItem("moniker-test-seeded")) return;
    sessionStorage.setItem("moniker-test-seeded", "1");
    localStorage.setItem("moniker.settings", JSON.stringify({ nodes: [node], chain }));
  }, { node: stack.node, chain: stack.chain });
  if (who) await walletHolds(page.context(), who);
  await page.goto(stack.app + "#/find");
  if (who) {
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(page.getByRole("button", { name: "Connect wallet" })).toHaveCount(0);
  }
  await page.goto(stack.app + hash);
}

/** A test with a fresh browser and page; on failure, what the page showed. */
const test = (name, body, { wallet: withWallet = true } = {}) =>
  nodeTest(name, { timeout: 300_000 }, async () => {
    const context = withWallet ? await walletBrowser() : await browser.newContext();
    const page = context.pages()[0] ?? (await context.newPage());
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
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

test("a visitor finds nobody under a free handle, and reads with no wallet", async ({ page }) => {
  await openApp(page, null, "#/@nobody");
  await expect(page.locator("#app")).toContainText("No one holds @nobody.");
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
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
  await expect(page).toHaveURL(/#\/$/);
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

test("Alice claims @alice and puts it on her page; a visitor finds her by it", async ({ page }) => {
  await openApp(page, alice, "#/handles");
  await page.locator("#want").fill("Alice");
  await expect(page.locator("#want-status")).toHaveText("Only lowercase letters, digits and _.");
  await page.locator("#want").fill("alice");
  await expect(page.locator("#want-status")).toHaveText("@alice is free. Claiming costs a fee of 1.");
  await page.getByRole("button", { name: "Claim" }).click();
  await page.locator("#sheet").getByRole("button", { name: "Claim" }).click();
  await expect(page.locator(".row", { hasText: "@alice" })).toBeVisible();
  await page.goto(stack.app + "#/edit");
  await page.locator("#handle").selectOption("alice");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".handle")).toHaveText("@alice");
  // Her name and links stayed: the save changed only the handle.
  await expect(page.locator(".links a")).toHaveCount(3);

  const visitor = await browser.newPage();
  await openApp(visitor, null, "#/find");
  await visitor.locator("#q").fill("@alice");
  await visitor.locator("#q").press("Enter");
  await expect(visitor.locator("h1")).toHaveText("Alice Rivera");
  await expect(visitor.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await visitor.close();
});

test("Alice sells @alice; Bob buys it alone, and it leaves her page", async ({ page }) => {
  {
    await openApp(page, alice, "#/handles");
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
    await openApp(bobPage, bob, "#/handles");
    const offer = bobPage.locator(".row", { hasText: "@alice" });
    await offer.getByRole("button", { name: "Buy · 500" }).click();
    await expect(bobPage.locator("#sheet")).toContainText("If they change the price before it lands, nothing is taken.");
    await bobPage.locator("#sheet").getByRole("button", { name: "Buy for 500" }).click();
    await expect(bobPage.locator("section", { hasText: "Yours" }).locator(".row", { hasText: "@alice" })).toBeVisible();
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
