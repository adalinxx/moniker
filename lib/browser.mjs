// Moniker in a browser page, with the Lattice SDK included:
//
//   import { createMoniker, defineMonikerName } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker@v0.1.0/lib/browser.mjs";
//   const moniker = createMoniker();          // or createMoniker({ nodes, chain })
//   defineMonikerName(moniker);               // then <moniker-name address="…">
import * as sdk from "../app/vendor/lattice-sdk.js";
import { createMoniker as create } from "./index.mjs";

export { DEFAULTS, isAddress, isHandle, isWebURL } from "./index.mjs";
export { defineMonikerName } from "./element.mjs";
export const createMoniker = (options = {}) => create({ sdk, ...options });
