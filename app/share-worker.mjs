// Grinds shares for a fee sponsor on one of this device's processor cores,
// where it has no graphics chip the page can use (share-gpu.mjs). See
// sha256.mjs for what a share is.
//
//   postMessage({ prefixHex, targetHex, start, count })   // start, count: decimal strings
//   ← { share: "<nonce>" } for each share, { hashes } now and then, { done: true } at the end
import { compress, prepare } from "./sha256.mjs";

onmessage = ({ data: { prefixHex, targetHex, start, count } }) => {
  const { midstate, last, tail, blocks, target } = prepare(prefixHex, targetHex);
  const lastView = new DataView(last.buffer);
  const state = new Uint32Array(8);
  // The nonce as two 32-bit halves: BigInt arithmetic per hash would cost more than the hash.
  const first = BigInt(start);
  let hi = Number(first >> 32n);
  let lo = Number(first & 0xffffffffn);
  let hashes = 0;
  for (let left = Number(count); left > 0; left--) {
    lastView.setUint32(tail, hi);
    lastView.setUint32(tail + 4, lo);
    state.set(midstate);
    for (let b = 0; b < blocks; b++) compress(state, lastView, b * 64);
    // At or under the target, compared as big-endian numbers.
    for (let i = 0; i < 8; i++) {
      if (state[i] === target[i] && i < 7) continue;
      if (state[i] <= target[i]) postMessage({ share: String((BigInt(hi) << 32n) | BigInt(lo)) });
      break;
    }
    if (++lo === 2 ** 32) {
      lo = 0;
      hi = (hi + 1) >>> 0;
    }
    if (++hashes === 1 << 18) {
      postMessage({ hashes });
      hashes = 0;
    }
  }
  postMessage({ hashes, done: true });
};
