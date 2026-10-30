// On-device inference with WebLLM (vendored copy of @mlc-ai/web-llm 0.2.79).
// The library is loaded lazily so the rest of the app works even without WebGPU.
// Model weights are fetched once from Hugging Face and then served from the
// browser's Cache Storage, so after the first download everything is offline.

const LIB_URL = './vendor/web-llm.js';
let lib = null;
let engine = null;
let loadedId = null;

// Every model below was verified to exist on Hugging Face in MLC format
// (mlc-chat-config.json, ndarray-cache.json, params_shard_*.bin, tokenizer)
// with a matching prebuilt WebGPU model library for WebLLM 0.2.79.
export const MODELS = [
  {
    id: 'Llama-3.2-1B-Instruct-abliterated-q4f16_1-MLC',
    label: 'Llama 3.2 1B Abliterated (uncensored)',
    note: '~705 MB download · ~0.9 GB memory · fastest',
    custom: true,
    f16: true
  },
  {
    id: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
    label: 'Hermes 3 · Llama 3.2 3B (roleplay)',
    note: '~1.8 GB download · ~2.3 GB memory · smartest',
    f16: true
  },
  {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 1B Instruct',
    note: '~705 MB download · ~0.9 GB memory',
    f16: true
  },
  {
    id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen 2.5 1.5B Instruct',
    note: '~880 MB download · ~1.6 GB memory',
    f16: true
  }
];
// Used automatically if the GPU lacks 16-bit float shader support.
export const F32_FALLBACK = 'Llama-3.2-1B-Instruct-q4f32_1-MLC';
export const DEFAULT_MODEL = MODELS[0].id;
export const CONTEXT_WINDOW = 4096;

async function getLib() {
  if (!lib) lib = await import(LIB_URL);
  return lib;
}

export async function appConfig() {
  const w = await getLib();
  const list = w.prebuiltAppConfig.model_list.map((m) => ({
    ...m,
    overrides: { ...(m.overrides || {}), context_window_size: CONTEXT_WINDOW }
  }));
  list.push({
    // https://huggingface.co/Sandoche/Llama-3.2-1B-Instruct-abliterated-q4f16_1-MLC
    // (huihui-ai/Llama-3.2-1B-Instruct-abliterated compiled for MLC). Same
    // architecture/quantization as mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC,
    // so it reuses that model's WebGPU library.
    model: 'https://huggingface.co/Sandoche/Llama-3.2-1B-Instruct-abliterated-q4f16_1-MLC',
    model_id: 'Llama-3.2-1B-Instruct-abliterated-q4f16_1-MLC',
    model_lib: w.modelLibURLPrefix + w.modelVersion + '/Llama-3.2-1B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm',
    vram_required_MB: 879.04,
    low_resource_required: true,
    overrides: { context_window_size: CONTEXT_WINDOW }
  });
  return { model_list: list, useIndexedDBCache: false };
}

export async function gpuStatus() {
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
  if (!('gpu' in navigator)) return { ok: false, reason: 'no-api' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'no-adapter' };
    return { ok: true, f16: adapter.features.has('shader-f16') };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

export function currentModel() { return loadedId; }
export function isReady() { return !!engine && !!loadedId; }

export async function load(modelId, onProgress) {
  const w = await getLib();
  const cfg = await appConfig();
  const cb = (r) => onProgress && onProgress(r);
  if (!engine) {
    engine = await w.CreateMLCEngine(modelId, { appConfig: cfg, initProgressCallback: cb });
  } else {
    engine.setInitProgressCallback && engine.setInitProgressCallback(cb);
    await engine.reload(modelId);
  }
  loadedId = modelId;
  return engine;
}

export async function unload() {
  if (engine) await engine.unload();
  loadedId = null;
}

export async function isCached(modelId) {
  try {
    const w = await getLib();
    return await w.hasModelInCache(modelId, await appConfig());
  } catch { return false; }
}

export async function deleteCached(modelId) {
  const w = await getLib();
  if (loadedId === modelId) await unload();
  await w.deleteModelAllInfoInCache(modelId, await appConfig());
}

function params(o = {}) {
  const p = {
    temperature: o.temperature ?? 0.9,
    top_p: o.top_p ?? 0.95,
    max_tokens: o.max_tokens ?? 350,
    frequency_penalty: o.frequency_penalty ?? 0.3,
    presence_penalty: o.presence_penalty ?? 0.2
  };
  return p;
}

// Streams text deltas. Yields {delta} objects, then a final {done, finish}.
export async function* stream(messages, opts) {
  if (!engine) throw new Error('Model not loaded');
  const chunks = await engine.chat.completions.create({ messages, stream: true, ...params(opts) });
  let finish = null;
  for await (const c of chunks) {
    const ch = c.choices && c.choices[0];
    if (!ch) continue;
    if (ch.delta && ch.delta.content) yield { delta: ch.delta.content };
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  yield { done: true, finish };
}

export async function complete(messages, opts) {
  if (!engine) throw new Error('Model not loaded');
  const r = await engine.chat.completions.create({ messages, stream: false, ...params(opts) });
  return (r.choices[0].message.content || '').trim();
}

export function interrupt() {
  if (engine) engine.interruptGenerate();
}
