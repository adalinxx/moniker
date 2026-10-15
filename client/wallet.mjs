// Apps keep no key: every write goes to the person's Lattice wallet
// through `window.lattice.writeRecords`, which shows it, picks the nonce,
// signs with the connected account and sends it. The wallet debits that
// account for the payments plus the fee and credits each payee, the same
// body `transaction` below builds.

/**
 * The wallet request for `actions` on `chainPath`, paying `payments`
 * (`{ to, amount }`, as profile.mjs `buy` returns them) from the connected
 * account. The wallet takes each payee once, so payments to one payee are
 * added together.
 */
export function writeRequest(chainPath, { actions, payments = [] }, fee = 1n) {
  if (actions.length === 0) throw new Error("Nothing to write");
  const credits = new Map();
  for (const { to, amount } of payments) credits.set(to, (credits.get(to) ?? 0n) + amount);
  return {
    chainPath: [...chainPath],
    actions,
    ...(credits.size > 0 && { payments: [...credits].map(([to, amount]) => ({ to, amount: String(amount) })) }),
    fee: String(fee),
  };
}

/** Asks the wallet to approve, sign and send the write. Resolves to `{ transactionCID }`. */
export const send = (lattice, chainPath, write, fee) => lattice.writeRecords(writeRequest(chainPath, write, fee));

/**
 * The same write as a transaction body signed for by `owner`, who pays the
 * fee and each payment: for scripts and tests that hold a key themselves.
 */
export function transaction({ owner, actions, payments = [], fee, nonce, chainPath }) {
  const credits = new Map();
  for (const { to, amount } of payments) credits.set(to, (credits.get(to) ?? 0n) + amount);
  const debit = fee + [...credits.values()].reduce((sum, amount) => sum + amount, 0n);
  return {
    accountActions: [
      ...(debit > 0n ? [{ owner, delta: -debit }] : []),
      ...[...credits].map(([to, amount]) => ({ owner: to, delta: amount })),
    ],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [owner],
    nonce,
    chainPath: [...chainPath],
  };
}
