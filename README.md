# Story Characters (offline AI roleplay PWA)

A private web app for adult (18+) interactive fiction. The AI model runs on your
iPhone's GPU through [WebLLM](https://github.com/mlc-ai/web-llm). After the
one-time model download it works fully offline. There are no accounts, no
analytics, and no server. Your characters and chats are saved only on your phone
(IndexedDB).

## Features
- On-device LLM (WebGPU) with download progress and an offline cache
- Model picker (all verified on Hugging Face, MLC format):
  | Model | Hugging Face repo | Download | GPU memory |
  |---|---|---|---|
  | **Llama 3.2 1B Abliterated (default, uncensored)** | `Sandoche/Llama-3.2-1B-Instruct-abliterated-q4f16_1-MLC` | ~705 MB | ~0.9 GB |
  | Hermes 3 · Llama 3.2 3B (roleplay) | `mlc-ai/Hermes-3-Llama-3.2-3B-q4f16_1-MLC` | ~1.8 GB | ~2.3 GB |
  | Llama 3.2 1B Instruct | `mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC` | ~705 MB | ~0.9 GB |
  | Qwen 2.5 1.5B Instruct | `mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC` | ~880 MB | ~1.6 GB |
- A character creator with name, age (18+ enforced), appearance, personality,
  default mood, possible moods, backstory, secrets, speaking style, scenario,
  opening message, and example dialogue. You can edit, duplicate, delete,
  export, and import characters. Imports accept this app's JSON and
  SillyTavern/TavernAI cards (v1/v2 JSON and PNG).
- Built-in characters: Mara, Elias, and Nova, plus the **Storyteller**, which
  invents new characters (tap **＋ Save character** under its reply) and new
  stories on demand.
- Dynamic moods. Each reply ends with a hidden `[mood: …]` tag. If the model
  forgets it, a quick second pass picks one. The current mood is shown as a
  badge and fed back into the prompt.
- Chat features: streaming replies, Stop, Regenerate, Continue, editing and
  deleting messages, multiple chats per character, a "New story" button,
  temperature and max-token sliders, and automatic context trimming (4k window).

## Deploy to GitHub Pages
Live URL: **https://tylotus66-spec.github.io/story-app/** (repo `tylotus66-spec/story-app`, branch `main`).

This repo has a workflow at `.github/workflows/pages.yml` that publishes the
repo root to GitHub Pages every time you push to `main`. It uses
`configure-pages` with `enablement: true`, so Pages is switched on
automatically.

1. Push or upload every file in this folder to the `main` branch, including the
   hidden `.github/` folder and `.nojekyll`. From a computer:
   ```
   git init && git add -A && git commit -m "Story app"
   git branch -M main
   git remote add origin https://github.com/tylotus66-spec/story-app.git
   git push -u origin main
   ```
2. Check the **Actions** tab. When "Deploy to GitHub Pages" turns green, the
   app is live at the URL above.
3. If the first run fails on enablement, open **Settings → Pages**, set
   **Source: GitHub Actions**, and re-run the workflow.

All paths are relative, so it also works under any other repo name.

## Install on iPhone
1. Open the link in **Safari**. WebGPU needs iOS 26 or newer. On iOS 18 you can
   turn on Settings → Apps → Safari → Advanced → Feature Flags → **WebGPU**.
2. Tap **Share → Add to Home Screen → Add**.
3. Open **Stories** from your Home Screen. The Home Screen app has its own
   storage, so download the model from inside it.
4. On the home screen of the app, pick a model and tap **Download & load**.
   Stay on Wi-Fi with the screen on until it reaches 100%.
5. In Settings, tap **Keep data** so iOS is less likely to clear the
   downloaded model.

After that, the app and model work in airplane mode.

## Tips
- Start with the 1B Abliterated model, since it is the fastest and has the fewest refusals.
  For better writing, try Hermes 3 3B. If the app reloads or crashes while
  loading, iOS ran out of memory, so close other apps or use a 1B model.
- Say "create a new character: a moody vampire noble" to the Storyteller, then
  tap **＋ Save character**.
- Tap any message to edit, copy, delete, regenerate, or continue it.
- Back up regularly with Settings → **Export backup**.

## Updating the app
After changing files, bump `VERSION` in `sw.js` so phones pick up the new
version. Open the app twice to refresh.

## Tech notes
- WebLLM 0.2.79 is vendored as a single ES module (`vendor/web-llm.js`, built by
  jsDelivr from `@mlc-ai/web-llm@0.2.79`). It is pinned on purpose: newer
  versions expect `tensor-cache.json`, and the abliterated model repo only ships
  `ndarray-cache.json`. 0.2.79 loads both the `mlc-ai` models and the
  abliterated one.
- The abliterated model reuses WebLLM's prebuilt
  `v0_2_48/Llama-3.2-1B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm` library, since its
  architecture and quantization are the same as `mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC`.
- If the GPU has no `shader-f16`, the app switches to `Llama-3.2-1B-Instruct-q4f32_1-MLC` automatically.
- Network requests happen only for model files (huggingface.co) and model
  libraries (raw.githubusercontent.com).
