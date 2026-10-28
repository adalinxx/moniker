// selfhold.js from adalinxx/selfhold-wallet at fc0cb1c (npm run build:web), the client
// for Selfhold's window at wallet.selfhold.app. MIT, see selfhold.LICENSE.
// src/web/client.ts
var CHANNEL = "selfhold";
var ADDRESS = "selfhold.web.address";
var NeedsCoins = class extends Error {
  /** `sponsor`: why the fee sponsor didn't pay, if it was asked: "dear", "down", or "most". */
  constructor(message, address, needed, balance, sponsor) {
    super(message);
    this.address = address;
    this.needed = needed;
    this.balance = balance;
    this.sponsor = sponsor;
    this.name = "NeedsCoins";
  }
};
function selfhold(options = {}) {
  const wallet = new URL(options.wallet ?? "https://wallet.selfhold.app/");
  const key = `${ADDRESS} ${wallet.origin}`;
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
  function ask(call, progress = () => {
  }, route = false, account) {
    if (call instanceof Promise) call.catch(() => {
    });
    const id = crypto.randomUUID();
    const width = 420, height = 700;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 3);
    const opened = window.open(`${wallet.href}#${id}`, `selfhold-${id}`, `popup,width=${width},height=${height},left=${left},top=${top}`);
    if (!opened) return Promise.reject(new Error("The browser blocked Selfhold's window. Allow pop-ups for this site, then try again."));
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
        if (event.origin !== wallet.origin || event.source !== opened || data?.channel !== CHANNEL || data.id !== id) return;
        if (data.ready && sent) {
          opened.close();
          return finish({ ok: false, error: "The Selfhold window was reloaded. Nothing was signed; try again." });
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
            opened.postMessage({ channel: CHANNEL, id, call: asked, ...route ? { route: { ...hosts && { hosts }, ...sponsor && { sponsor } } } : {}, ...account && { account } }, wallet.origin);
          } catch (error) {
            opened.close();
            return finish({ ok: false, error: String(error?.message ?? error) });
          }
        }
        if (typeof data.progress === "string") progress(data.progress);
        if (data.response) finish(data.response);
      };
      window.addEventListener("message", heard);
      const watching = setInterval(() => opened.closed && finish({ ok: false, error: "The Selfhold window was closed. Nothing was signed." }), 400);
    });
  }
  const answered = (answer) => {
    if (answer.ok) return answer;
    if (answer.code === "AccountChanged") forget();
    if (answer.code === "NeedsCoins") {
      throw new NeedsCoins(answer.error ?? "", answer.address, BigInt(answer.needed), BigInt(answer.balance), answer.sponsor ?? null);
    }
    throw new Error(answer.error ?? "Selfhold did not answer");
  };
  return Object.freeze({
    isSelfholdWeb: true,
    /** The address this site was given, or null; never asks. */
    address: async () => given(),
    /** The person's address, once they connect in Selfhold's window. Call it from a click. */
    connect: async () => {
      const { address } = answered(await ask({ method: "connect" }));
      remember(address);
      return address;
    },
    /** Forget the address here. */
    disconnect: async () => forget(),
    /**
     * Write records on one chain, and pay addresses from the account in the
     * same transaction, once the person approves in Selfhold's window, which
     * signs and sends it. `progress(text)` hears what the window is doing.
     * `request` may be a promise; resolving to null closes the window, and
     * the write resolves to null: nothing to send. Built for the address
     * given here, the window signs it only as that account.
     */
    writeRecords: async (request, { progress } = {}) => {
      const call = Promise.resolve(request).then((params) => params === null ? null : { method: "writeRecords", params });
      const answer = answered(await ask(call, progress, true, given() ?? void 0));
      if (answer.nothing) return null;
      remember(answer.address);
      return { transactionCID: answer.transactionCID };
    },
    /** Sign `text`, once the person approves, as the address given here if any. The signed bytes are "lattice-message:" + this origin + "\n" + text. */
    signMessage: async (params) => {
      const { publicKey, signature } = answered(await ask({ method: "signMessage", params }, void 0, false, given() ?? void 0));
      return { publicKey, signature };
    }
  });
}
export {
  NeedsCoins,
  selfhold
};
