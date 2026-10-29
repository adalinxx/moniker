// selfhold.js (@selfhold/web) from adalinxx/selfhold-wallet at 4d4c0a8 (npm run build:web), the client
// for Selfhold for Chrome and Selfhold's window at wallet.selfhold.app. MIT, see selfhold.LICENSE.
// src/web/client.ts
var PROTOCOL = 1;
var CHANNEL = "selfhold";
var ADDRESS = "selfhold.web.address";
var SelfholdError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "SelfholdError";
    this.code = code;
  }
};
var NeedsCoins = class extends SelfholdError {
  address;
  needed;
  balance;
  /** Why the fee sponsor didn't pay, if it was asked: "dear", "down", or "most". */
  sponsor;
  constructor(message, address, needed, balance, sponsor) {
    super("NeedsCoins", message);
    this.name = "NeedsCoins";
    this.address = address;
    this.needed = needed;
    this.balance = balance;
    this.sponsor = sponsor;
  }
};
var TIMES = { slow: 3e4, late: 3e5, giveUp: 18e5, every: 2500, everyLate: 15e3, read: 2e4 };
var LOST_READS = 3;
var CODES = /* @__PURE__ */ new Set(["PopupBlocked", "Closed", "Declined", "Reloaded", "AccountChanged", "NotConnected", "NeedsCoins", "NoWallet", "Lost", "NotRecorded", "Failed"]);
function asSelfholdError(error) {
  if (error instanceof SelfholdError) return error;
  const text = String(error?.message ?? error);
  const code = error?.code;
  if (typeof code === "string" && CODES.has(code)) return new SelfholdError(code, text);
  if (/^The person just declined/.test(text)) return new SelfholdError("Declined", "The wallet waits a few seconds after a decline. Try again in a moment.");
  if (/^The person declined/.test(text)) return new SelfholdError("Declined", "You declined it in the wallet. Nothing was sent.");
  return new SelfholdError("Failed", text);
}
async function waitFor(landed, { onChange = () => {
}, signal } = {}, poke = () => {
}, times = TIMES) {
  const started = Date.now();
  let state = "sent";
  let lost = 0;
  onChange(state);
  for (; ; ) {
    if (signal?.aborted) throw signal.reason;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, state === "late" ? times.everyLate : times.every);
      const now = () => {
        clearTimeout(timer);
        resolve();
      };
      poke(now);
      signal?.addEventListener("abort", now, { once: true });
    });
    if (signal?.aborted) throw signal.reason;
    let result = false;
    try {
      result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no answer")), times.read);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        landed().then(resolve, reject).finally(() => clearTimeout(timer));
      });
    } catch {
    }
    if (result === true) return;
    lost = typeof result === "string" ? lost + 1 : 0;
    if (lost >= LOST_READS) throw new SelfholdError("Lost", result);
    const waited = Date.now() - started;
    if (waited > times.giveUp) throw new SelfholdError("NotRecorded", "Still not recorded after 30 minutes. It probably didn't go through: check your account, then try again.");
    const next = waited > times.late ? "late" : waited > times.slow ? "slow" : "sent";
    if (next !== state) onChange(state = next);
  }
}
async function nonceLanded(hosts, account, chainPath, nonce) {
  let answered = false;
  let error = new Error("No host to read the account from");
  for (const host of hosts) {
    try {
      const response = await fetch(`${host.replace(/\/+$/, "")}/api/state/account/${account}?chainPath=${chainPath.join("/")}`, { cache: "no-store", signal: AbortSignal.timeout(15e3) });
      if (response.status === 404) {
        answered = true;
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      answered = true;
      if (BigInt((await response.json()).nonce ?? 0) > nonce) return true;
    } catch (e) {
      error = e;
    }
  }
  if (answered) return false;
  throw error;
}
function selfhold(options = {}) {
  const use = options.use ?? "auto";
  const page = new URL(options.wallet ?? "https://wallet.selfhold.app/");
  const key = `${ADDRESS} ${page.origin}`;
  const remember = (address) => {
    try {
      if (typeof address === "string") localStorage.setItem(key, address);
    } catch {
    }
  };
  const given = () => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const forget = () => {
    try {
      localStorage.removeItem(key);
    } catch {
    }
  };
  const installed = () => {
    const lattice = globalThis.lattice;
    return lattice?.isLatticeWallet ? lattice : null;
  };
  const extension = () => {
    if (use === "window") return null;
    const found = installed();
    if (!found && use === "extension") throw new SelfholdError("NoWallet", "Selfhold for Chrome isn't installed in this browser.");
    return found;
  };
  function ask(call, progress = () => {
  }, route = false, account) {
    if (call instanceof Promise) call.catch(() => {
    });
    const id = crypto.randomUUID();
    const width = 420, height = 700;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 3);
    const opened = window.open(`${page.href}#${id}`, `selfhold-${id}`, `popup,width=${width},height=${height},left=${left},top=${top}`);
    if (!opened) return Promise.reject(new SelfholdError("PopupBlocked", "The browser blocked Selfhold's window. Allow pop-ups for this site, then try again."));
    return new Promise((resolve) => {
      let sent = false;
      let settled = false;
      const finish = (answer) => {
        settled = true;
        window.removeEventListener("message", heard);
        clearInterval(watching);
        resolve(answer);
      };
      const heard = async (event) => {
        const data = event.data;
        if (event.origin !== page.origin || event.source !== opened || data?.channel !== CHANNEL || data.id !== id) return;
        if (data.ready && sent) {
          opened.close();
          return finish({ ok: false, code: "Reloaded", error: "The Selfhold window was reloaded. Nothing was signed; try again." });
        }
        if (data.ready) {
          sent = true;
          try {
            const asked = await call;
            if (asked === null) {
              opened.close();
              return finish({ ok: true, nothing: true });
            }
            const hosts = route && options.hosts ? await options.hosts() : void 0;
            const sponsor = route && options.sponsor ? await options.sponsor() : void 0;
            if (settled) return;
            opened.postMessage({ channel: CHANNEL, v: PROTOCOL, id, call: asked, ...route ? { route: { ...hosts && { hosts }, ...sponsor && { sponsor } } } : {}, ...account && { account } }, page.origin);
          } catch (error) {
            opened.close();
            const failed = asSelfholdError(error);
            return finish({ ok: false, code: failed.code, error: failed.message });
          }
        }
        if (typeof data.progress === "string") progress(data.progress);
        if (data.response) finish(data.response);
      };
      window.addEventListener("message", heard);
      const watching = setInterval(() => opened.closed && finish({ ok: false, code: "Closed", error: "The Selfhold window was closed. Nothing was signed." }), 400);
    });
  }
  const answered = (answer) => {
    if (answer.ok) return answer;
    if (answer.code === "AccountChanged") forget();
    if (answer.code === "NeedsCoins") {
      throw new NeedsCoins(answer.error ?? "", answer.address, BigInt(answer.needed), BigInt(answer.balance), answer.sponsor ?? null);
    }
    if (answer.code && CODES.has(answer.code)) throw new SelfholdError(answer.code, answer.error ?? "Selfhold did not answer");
    throw asSelfholdError(answer.error ?? "Selfhold did not answer");
  };
  let turn = Promise.resolve();
  const inTurn = (run) => {
    const next = turn.then(run);
    turn = next.catch(() => {
    });
    return next;
  };
  const sentWrite = (transactionCID, account, chainPath, nonce, host) => {
    const pokes = /* @__PURE__ */ new Set();
    return Object.freeze({
      transactionCID,
      account,
      chainPath,
      ...nonce !== void 0 && { nonce },
      ...host !== void 0 && { host },
      wait: async ({ check, ...rest } = {}) => {
        let landed = check;
        if (!landed) {
          if (nonce === void 0) throw new SelfholdError("Failed", "This wallet doesn't say its write's nonce: pass wait() a check.");
          const hosts = [.../* @__PURE__ */ new Set([...host ? [host] : [], ...options.hosts ? await options.hosts() : []])];
          if (!hosts.length) throw new SelfholdError("Failed", "No host to watch this write at: give selfhold() hosts, or wait() a check.");
          landed = () => nonceLanded(hosts, account, chainPath, BigInt(nonce));
        }
        let now = null;
        const poke = () => now?.();
        pokes.add(poke);
        try {
          await waitFor(landed, rest, (wake) => now = wake);
        } finally {
          pokes.delete(poke);
        }
      },
      checkNow: () => pokes.forEach((poke) => poke())
    });
  };
  return Object.freeze({
    isSelfholdWeb: true,
    /** "extension" where Selfhold for Chrome is the wallet here, else "window". It can change once the extension reaches the page. */
    get kind() {
      return extension() ? "extension" : "window";
    },
    /** The address this site was given, or null; never asks. */
    address: async () => {
      const lattice = extension();
      if (!lattice) return given();
      return await lattice.address().catch(() => null) ?? null;
    },
    /** The person's address, once they connect. Call it from a click. */
    connect: async () => {
      const lattice = extension();
      if (lattice) return lattice.connect().catch((error) => {
        throw asSelfholdError(error);
      });
      const { address } = answered(await ask({ method: "connect" }));
      remember(address);
      return address;
    },
    /** Forget the address here. */
    disconnect: async () => {
      const lattice = extension();
      if (lattice) return lattice.disconnect();
      forget();
    },
    /**
     * Write records on one chain, and pay addresses from the account in the
     * same transaction, once the person approves; the wallet signs and sends
     * it. `request` may be a promise; resolving to null sends nothing, and
     * the write resolves to null. `account`, the address the site built the
     * write for, is checked first: if the wallet's is another now, nothing is
     * sent and it fails "AccountChanged". `progress(text)` hears what
     * Selfhold's window is doing.
     */
    writeRecords: async (request, { progress, account } = {}) => {
      const lattice = extension();
      const expected = account ?? (lattice ? void 0 : given() ?? void 0);
      const changed = (now) => {
        Promise.resolve(request).catch(() => {
        });
        return new SelfholdError(now ? "AccountChanged" : "NotConnected", now ? "Selfhold now connects this site to a different account. Look again, then try again." : "Selfhold isn't connected to this site anymore. Connect again, then try again.");
      };
      if (!lattice) {
        if (account !== void 0 && given() !== account) throw changed(given());
        const call = Promise.resolve(request).then((params2) => params2 === null ? null : { method: "writeRecords", params: params2 });
        const answer = answered(await ask(call, progress, true, expected));
        if (answer.nothing) return null;
        remember(answer.address);
        const params = await request;
        return sentWrite(answer.transactionCID, answer.address, params.chainPath, answer.nonce, answer.host);
      }
      return inTurn(async () => {
        const now = await lattice.address().catch(() => null);
        if (now === null || account !== void 0 && now !== account) throw changed(now);
        const params = await request;
        if (params === null) return null;
        const sent = await lattice.writeRecords(params).catch((error) => {
          throw asSelfholdError(error);
        });
        return sentWrite(sent.transactionCID, now, params.chainPath, sent.nonce, sent.host);
      });
    },
    /** Sign `text`, once the person approves, as the address given here if any. The signed bytes are "lattice-message:" + this origin + "\n" + text. */
    signMessage: async (params) => {
      const lattice = extension();
      if (lattice) return lattice.signMessage(params).catch((error) => {
        throw asSelfholdError(error);
      });
      const { publicKey, signature } = answered(await ask({ method: "signMessage", params }, void 0, false, given() ?? void 0));
      return { publicKey, signature };
    }
  });
}
export {
  NeedsCoins,
  PROTOCOL,
  SelfholdError,
  TIMES,
  asSelfholdError,
  selfhold,
  waitFor
};
