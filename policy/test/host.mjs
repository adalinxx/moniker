// Runs the built policy module the way the Lattice host does: allocate with
// `lattice_alloc`, write the canonical context, call the entrypoint.
import { readFileSync } from "node:fs";

export const module = new WebAssembly.Module(
  readFileSync(new URL("../target/wasm32-unknown-unknown/release/moniker_policy.wasm", import.meta.url)),
);

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value);
  return bytes;
}

/** The transaction-scope context for an encoded body on `path`. */
export function context(bodyBytes, { path, version = 2, height = 100n }) {
  const text = new TextEncoder();
  const parts = [
    text.encode("LWPCTX"),
    Uint8Array.of(0, version, 0, 1, 0), // encoding version, ABI version, transaction scope
    u64(height),
    new Uint8Array(8), // timestamp
    u32(3),
    Uint8Array.of(0xa0, 0xa0, 0xa0), // stand-in chain spec bytes; the policy skips them
    u32(path.length),
    ...path.flatMap((segment) => [u32(text.encode(segment).length), text.encode(segment)]),
  ];
  if (bodyBytes === undefined) parts.push(Uint8Array.of(0));
  else parts.push(Uint8Array.of(1), u32(bodyBytes.length), bodyBytes);
  parts.push(Uint8Array.of(0, 0)); // no action, no action index
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

/** Whether the module accepts a context. */
export function validate(bytes) {
  const { exports } = new WebAssembly.Instance(module);
  const pointer = exports.lattice_alloc(bytes.length);
  new Uint8Array(exports.memory.buffer).set(bytes, pointer);
  return exports.lattice_validate_transaction(pointer, bytes.length) === 1;
}
