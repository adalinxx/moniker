// Grinds shares for a fee sponsor on this device's graphics chip, through
// WebGPU: a compute shader hashes a batch of nonces at a time, each from the
// midstate and last blocks sha256.mjs lays out, and lists those at or under
// the share target. Hundreds of times the processor's pace on most chips.
import { K, prepare } from "./sha256.mjs";

const MOST_FOUND = 64; // shares one batch reports; past these it still counts them
const WORKGROUP = 256;
const ACROSS = 32768; // workgroups along x; more go along y

// The parameters, as u32s: midstate [0, 8), target [8, 16), the last blocks
// [16, 48) with the nonce's bytes 0, then the batch's first nonce (hi, lo),
// its size, the nonce's byte offset in the last blocks, and how many blocks.
const SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> P: array<u32>;
@group(0) @binding(1) var<storage, read_write> R: array<atomic<u32>>;

var<private> K: array<u32, 64> = array<u32, 64>(${Array.from(K, (k) => `${k}u`).join(", ")});

fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }

fn compress(state: ptr<function, array<u32, 8>>, block: ptr<function, array<u32, 32>>, base: u32) {
  var w: array<u32, 64>;
  for (var i = 0u; i < 16u; i++) { w[i] = (*block)[base + i]; }
  for (var i = 16u; i < 64u; i++) {
    let x = w[i - 15u];
    let y = w[i - 2u];
    w[i] = w[i - 16u] + (rotr(x, 7u) ^ rotr(x, 18u) ^ (x >> 3u)) + w[i - 7u] + (rotr(y, 17u) ^ rotr(y, 19u) ^ (y >> 10u));
  }
  var a = (*state)[0]; var b = (*state)[1]; var c = (*state)[2]; var d = (*state)[3];
  var e = (*state)[4]; var f = (*state)[5]; var g = (*state)[6]; var h = (*state)[7];
  for (var i = 0u; i < 64u; i++) {
    let t1 = h + (rotr(e, 6u) ^ rotr(e, 11u) ^ rotr(e, 25u)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
    let t2 = (rotr(a, 2u) ^ rotr(a, 13u) ^ rotr(a, 22u)) + ((a & b) ^ (a & c) ^ (b & c));
    h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  (*state)[0] += a; (*state)[1] += b; (*state)[2] += c; (*state)[3] += d;
  (*state)[4] += e; (*state)[5] += f; (*state)[6] += g; (*state)[7] += h;
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let index = id.y * groups.x * ${WORKGROUP}u + id.x;
  if (index >= P[50]) { return; }
  let lo = P[49] + index;
  let hi = P[48] + select(0u, 1u, lo < P[49]);

  var block: array<u32, 32>;
  for (var i = 0u; i < 32u; i++) { block[i] = P[16u + i]; }
  // The nonce, big-endian, at any byte offset.
  for (var k = 0u; k < 8u; k++) {
    let half = select(lo, hi, k < 4u);
    let byte = (half >> (24u - 8u * (k % 4u))) & 0xffu;
    let at = P[51] + k;
    block[at / 4u] |= byte << (24u - 8u * (at % 4u));
  }
  var state: array<u32, 8>;
  for (var i = 0u; i < 8u; i++) { state[i] = P[i]; }
  compress(&state, &block, 0u);
  if (P[52] == 2u) { compress(&state, &block, 16u); }

  // At or under the target, compared as big-endian numbers.
  for (var i = 0u; i < 8u; i++) {
    if (state[i] < P[8u + i]) { break; }
    if (state[i] > P[8u + i]) { return; }
  }
  let slot = atomicAdd(&R[0], 1u);
  if (slot < ${MOST_FOUND}u) {
    atomicStore(&R[1u + 2u * slot], hi);
    atomicStore(&R[2u + 2u * slot], lo);
  }
}`;

let ready = null;

/**
 * This device's graphics chip, ready to grind, or null where WebGPU or a
 * chip isn't there. `job(prefixHex, targetHex)` gives `run(start, count)`,
 * which hashes nonces [start, start + count) (start: BigInt, count up to
 * 2^26) and resolves to the shares found, as BigInts.
 */
export function gpuGrinder() {
  ready ??= open().catch(() => null);
  return ready;
}

async function open() {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  // Lost (a driver reset, or the tab put away): open it again next time.
  device.lost.then(() => (ready = null));
  const module = device.createShaderModule({ code: SHADER });
  const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });

  return {
    job(prefixHex, targetHex) {
      const { midstate, last, tail, blocks, target } = prepare(prefixHex, targetHex);
      const params = new Uint32Array(53);
      params.set(midstate, 0);
      params.set(target, 8);
      const lastView = new DataView(last.buffer);
      for (let i = 0; i < last.length / 4; i++) params[16 + i] = lastView.getUint32(i * 4);
      params[51] = tail;
      params[52] = blocks;

      const input = device.createBuffer({ size: params.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const found = device.createBuffer({ size: (1 + 2 * MOST_FOUND) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const read = device.createBuffer({ size: found.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const bindings = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: found } }],
      });

      return {
        async run(start, count) {
          params[48] = Number(start >> 32n) >>> 0;
          params[49] = Number(start & 0xffffffffn);
          params[50] = count;
          device.queue.writeBuffer(input, 0, params);
          device.queue.writeBuffer(found, 0, new Uint32Array(1));
          const groups = Math.ceil(count / WORKGROUP);
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindings);
          pass.dispatchWorkgroups(Math.min(groups, ACROSS), Math.ceil(groups / ACROSS));
          pass.end();
          encoder.copyBufferToBuffer(found, 0, read, 0, found.size);
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          const words = new Uint32Array(read.getMappedRange().slice(0));
          read.unmap();
          const shares = [];
          for (let i = 0; i < Math.min(words[0], MOST_FOUND); i++) shares.push((BigInt(words[1 + 2 * i]) << 32n) | BigInt(words[2 + 2 * i]));
          return shares;
        },
        close() {
          input.destroy();
          found.destroy();
          read.destroy();
        },
      };
    },
  };
}
