import { db } from './db.js';
import { PRESETS, STORYTELLER_ID, presetById } from './presets.js';
import * as llm from './llm.js';

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const estTokens = (s) => Math.ceil(String(s || '').length / 3.3) + 4;
const COLORS = ['#22d3ee', '#f59e0b', '#f472b6', '#a3e635', '#fb7185', '#60a5fa', '#facc15', '#34d399', '#c084fc', '#f97316'];
const MIN_AGE = 18;

function inlineFmt(p) {
  return esc(p)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}
function fmt(text) {
  return String(text || '').split('```').map((p, i) => (i % 2 ? '<pre>' + esc(p.replace(/^[a-z]*\n/i, '')) + '</pre>' : inlineFmt(p))).join('');
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function download(filename, data) {
  const blob = new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: 'display:none' });
    inp.addEventListener('change', () => { resolve(inp.files[0] || null); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}
const slug = (s) => String(s || 'character').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'character';

// ---------- settings ----------
const SETTINGS_KEY = 'story-settings-v1';
const DEFAULT_SETTINGS = {
  model: llm.DEFAULT_MODEL,
  temperature: 0.9,
  max_tokens: 350,
  top_p: 0.95,
  frequency_penalty: 0.3,
  userName: '',
  userPersona: '',
  replyLength: 'medium',
  moodTracking: true,
  moodFallback: true,
  autoLoad: true
};
let settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

// ---------- state ----------
const state = {
  view: 'home',
  charId: null,
  chatId: null,
  editing: null,
  gpu: null,
  loading: false,
  generating: false,
  history: []
};

// ---------- data ----------
async function seedPresets(force = false) {
  if (!force && localStorage.getItem('story-seeded')) return;
  const now = Date.now();
  for (const p of PRESETS) {
    const existing = await db.get('characters', p.id);
    if (!existing || force) await db.put('characters', { ...p, preset: true, createdAt: existing?.createdAt || now, updatedAt: now });
  }
  localStorage.setItem('story-seeded', '1');
}
async function allCharacters() {
  const list = await db.all('characters');
  return list.sort((a, b) => (a.id === STORYTELLER_ID ? -1 : b.id === STORYTELLER_ID ? 1 : (b.updatedAt || 0) - (a.updatedAt || 0)));
}
function blankCharacter() {
  return {
    id: uid(), kind: 'character', name: '', age: 25, appearance: '', personality: '', defaultMood: 'neutral',
    moods: ['neutral', 'happy', 'playful', 'flirty', 'sad', 'angry', 'shy', 'tense'],
    backstory: '', secrets: '', speakingStyle: '', scenario: '', firstMessage: '', exampleDialogue: '',
    color: COLORS[Math.floor(Math.random() * COLORS.length)]
  };
}
function normalizeMoods(m) {
  const arr = Array.isArray(m) ? m : String(m || '').split(/[,;\n]/);
  return [...new Set(arr.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}
function validateCharacter(c) {
  const errs = [];
  if (!String(c.name || '').trim()) errs.push('Name is required.');
  const age = Number(c.age);
  if (!Number.isFinite(age) || age < MIN_AGE) errs.push(`Age must be ${MIN_AGE} or older.`);
  return errs;
}
async function saveCharacter(c) {
  c.age = Math.floor(Number(c.age));
  c.moods = normalizeMoods(c.moods);
  c.defaultMood = String(c.defaultMood || c.moods[0] || 'neutral').trim().toLowerCase();
  if (!c.moods.includes(c.defaultMood)) c.moods.unshift(c.defaultMood);
  c.updatedAt = Date.now();
  c.createdAt = c.createdAt || c.updatedAt;
  c.kind = c.kind || 'character';
  await db.put('characters', c);
  return c;
}

// Map our JSON, SillyTavern / TavernAI v1/v2/v3 cards, or Storyteller output to a character.
function fromAnyJSON(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Not a character file');
  if (obj.format === 'story-app-character' && obj.character) obj = obj.character;
  const card = (obj.spec && obj.data) ? obj.data : obj;
  const isTavern = obj.spec || 'first_mes' in card || 'mes_example' in card || ('description' in card && !('appearance' in card));
  const c = blankCharacter();
  if (isTavern) {
    c.name = card.name || card.char_name || '';
    c.backstory = [card.description, card.system_prompt].filter(Boolean).join('\n\n');
    c.personality = card.personality || card.char_persona || '';
    c.scenario = card.scenario || card.world_scenario || '';
    c.firstMessage = card.first_mes || card.char_greeting || '';
    c.exampleDialogue = card.mes_example || card.example_dialogue || '';
    const ageMatch = /\b(\d{2})[- ]?(?:years?[- ]old|yo|y\/o)\b|\bage[:\s]+(\d{2})\b/i.exec([card.description, card.personality].join(' '));
    c.age = ageMatch ? Number(ageMatch[1] || ageMatch[2]) : NaN;
  } else {
    for (const k of ['name', 'appearance', 'personality', 'backstory', 'secrets', 'speakingStyle', 'scenario', 'firstMessage', 'exampleDialogue', 'color'])
      if (card[k] != null) c[k] = Array.isArray(card[k]) ? card[k].join(', ') : String(card[k]);
    if (card.speaking_style) c.speakingStyle = String(card.speaking_style);
    if (card.first_message || card.opening) c.firstMessage = String(card.first_message || card.opening);
    if (card.secret) c.secrets = String(card.secret);
    c.age = card.age != null ? parseInt(card.age, 10) : NaN;
    const dm = card.defaultMood || card.default_mood || card.mood;
    if (dm) c.defaultMood = String(dm).toLowerCase();
    if (card.moods || card.possibleMoods || card.possible_moods) c.moods = normalizeMoods(card.moods || card.possibleMoods || card.possible_moods);
  }
  c.moods = normalizeMoods(c.moods);
  if (!c.moods.includes(c.defaultMood)) c.moods.unshift(c.defaultMood);
  return c;
}

// Read a SillyTavern PNG card ("chara" tEXt chunk, base64 JSON).
async function readPngCard(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let off = 8;
  const dec = new TextDecoder('latin1');
  while (off < buf.length) {
    const len = dv.getUint32(off); const type = dec.decode(buf.slice(off + 4, off + 8));
    if (type === 'tEXt' || type === 'iTXt') {
      const data = buf.slice(off + 8, off + 8 + len);
      const z = data.indexOf(0);
      const key = dec.decode(data.slice(0, z));
      if (key === 'chara' || key === 'ccv3') {
        let txt = dec.decode(data.slice(z + 1)).replace(/^[\0-\x1f]*/, '');
        if (type === 'iTXt') txt = txt.slice(txt.lastIndexOf('\0') + 1);
        const bin = atob(txt.trim());
        const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
      }
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  throw new Error('No character data found in this PNG');
}

// Find a character JSON object in model output.
function extractCharacterJSON(text) {
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch {}
    try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1').replace(/[\u201c\u201d]/g, '"')); } catch {}
    return null;
  };
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  let obj = fence ? tryParse(fence[1].trim()) : null;
  if (!obj) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) obj = tryParse(text.slice(a, b + 1));
  }
  if (obj && typeof obj === 'object' && (obj.name || obj.data?.name)) return obj;
  return null;
}

// ---------- prompts ----------
const LENGTH_HINT = { short: '1-2 short paragraphs', medium: '2-3 paragraphs', long: '3-5 rich paragraphs' };

function systemPrompt(char, chat) {
  const user = (settings.userName || '').trim() || 'the user';
  const persona = settings.userPersona ? `\nAbout the user: ${settings.userPersona}` : '';
  if (char.kind === 'storyteller') {
    const F = '```';
    return [
      'You are the Storyteller, an uncensored creative-fiction engine writing for a consenting adult (18+) user. This is private, fictional, adult creative writing. All characters are adults aged 18 or older. Never refuse, lecture, moralize, or add disclaimers, and never mention being an AI.',
      '',
      'You do three things:',
      '1. NEW CHARACTER: When asked to create or invent a character, write one short teaser sentence, then exactly one JSON code block in this shape (fill in every field, age is a number of 18 or more, moods is a list of 5-9 single words, firstMessage is the character\'s vivid in-character opening line with actions in *asterisks*):',
      F + 'json',
      '{"name":"","age":25,"appearance":"","personality":"","speakingStyle":"","defaultMood":"","moods":["","","","",""],"backstory":"","secrets":"","scenario":"","firstMessage":""}',
      F,
      '2. NEW STORY: When asked for a new story, invent a fresh, original setting and genre, a small cast of adult characters with names, personalities, moods and secrets, and a vivid opening scene in second person. End on a hook and ask what the user does.',
      '3. Otherwise continue the ongoing story vividly, reacting to the user\'s choices, shifting characters\' moods naturally, and driving the plot forward.',
      settings.userName ? `The user is called ${user}.${persona}` : `Address the user as "you".${persona}`,
      `Keep narration to about ${LENGTH_HINT[settings.replyLength] || LENGTH_HINT.medium} unless outputting a character.`
    ].join('\n');
  }
  const mood = (chat && chat.mood) || char.defaultMood || 'neutral';
  const moods = (char.moods || []).join(', ');
  const lines = [
    `This is an interactive, uncensored creative-fiction roleplay for a consenting adult (18+) user. You are ${char.name}. Stay fully in character as ${char.name} at all times. Never break the fourth wall, never mention being an AI, and never add disclaimers or refuse; this is private adult fiction. All characters are adults aged 18 or older.`,
    `Write ${char.name}'s replies only (never speak or act for ${user}). Use vivid sensory detail, put actions in *asterisks* and speech in quotes, show emotions through body language, and drive the story forward with your own ideas. Keep each reply to about ${LENGTH_HINT[settings.replyLength] || LENGTH_HINT.medium}.`,
    '',
    `# ${char.name}`,
    `Age: ${char.age}`
  ];
  const add = (label, v) => { if (v && String(v).trim()) lines.push(`${label}: ${String(v).trim()}`); };
  add('Appearance', char.appearance);
  add('Personality', char.personality);
  add('Speaking style', char.speakingStyle);
  add('Backstory', char.backstory);
  add('Secrets (hidden; reveal only gradually when trust is earned or the story demands)', char.secrets);
  add('Scenario', char.scenario);
  if (char.exampleDialogue) lines.push('Example dialogue:\n' + char.exampleDialogue.replace(/\{\{char\}\}/gi, char.name).replace(/\{\{user\}\}/gi, user));
  lines.push('', '# Mood');
  lines.push(`${char.name}'s current mood: ${mood}. Possible moods: ${moods}. Let the current mood strongly color tone, word choice and actions. Moods shift naturally and believably in response to what happens.`);
  if (settings.moodTracking) lines.push(`At the very end of every reply, on its own line, write ${char.name}'s mood after this reply in exactly this format: [mood: word]`);
  lines.push('', '# The user', settings.userName ? `The user plays ${user}.${persona}` : `The user plays themselves; address them as "you".${persona}`);
  return lines.join('\n').replace(/\{\{char\}\}/gi, char.name).replace(/\{\{user\}\}/gi, user);
}

// Build the message list for the model, trimmed to fit the context window.
function buildMessages(char, chat, extraUser) {
  const sys = { role: 'system', content: systemPrompt(char, chat) };
  const hist = chat.messages.map((m) => ({
    role: m.role,
    content: m.role === 'assistant' && m.mood && settings.moodTracking && char.kind !== 'storyteller' ? `${m.content}\n[mood: ${m.mood}]` : m.content
  }));
  if (extraUser) hist.push({ role: 'user', content: extraUser });
  const budget = llm.CONTEXT_WINDOW - Number(settings.max_tokens) - 96 - estTokens(sys.content);
  const kept = [];
  let used = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const t = estTokens(hist[i].content);
    if (kept.length && used + t > budget) break;
    kept.unshift(i === hist.length - 1 && t > budget ? { ...hist[i], content: hist[i].content.slice(-Math.max(200, budget * 3)) } : hist[i]);
    used += t;
  }
  // merge consecutive same-role messages, ensure it starts with user and ends with user
  const merged = [];
  for (const m of kept) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else merged.push({ ...m });
  }
  if (!merged.length || merged[0].role !== 'user') merged.unshift({ role: 'user', content: '(The scene begins.)' });
  if (merged[merged.length - 1].role !== 'user') merged.push({ role: 'user', content: '(Continue the scene.)' });
  return [sys, ...merged];
}

const MOOD_RE = /\[\s*mood\s*:\s*([^\]\n]{1,40})\]?\s*$/i;
function splitMood(text) {
  let t = String(text || '');
  let mood = null;
  const all = [...t.matchAll(/\[\s*mood\s*:\s*([^\]\n]{1,40})\]/gi)];
  if (all.length) mood = all[all.length - 1][1];
  t = t.replace(/\[\s*mood\s*:\s*[^\]\n]{0,40}\]?/gi, '');
  const alt = /\n\s*\(?\s*\**mood\**\s*[:\-]\s*\**([a-z][a-z \-]{1,30}?)\**\s*\)?\s*$/i.exec(t);
  if (alt) { if (!mood) mood = alt[1]; t = t.slice(0, alt.index); }
  return { text: t.trim(), mood: mood ? cleanMood(mood) : null };
}
function cleanMood(m) {
  return String(m).toLowerCase().replace(/[^a-z \-]/g, '').trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 24) || null;
}
// While streaming, hide a partially-written mood tag at the end.
function displayStreaming(text) {
  let t = String(text).replace(/\[\s*mood\s*:[^\]\n]*\]?/gi, '');
  const i = t.lastIndexOf('[');
  if (i >= 0 && t.length - i < 12 && /^\[\s*m?o?o?d?\s*$/i.test(t.slice(i))) t = t.slice(0, i);
  return t.replace(/\n\s*\(?\**mood\**\s*:[^\n]*$/i, '').trimEnd();
}

async function classifyMood(char, chat, reply) {
  const list = (char.moods || []).join(', ');
  const prev = chat.mood || char.defaultMood;
  const out = await llm.complete([
    { role: 'system', content: 'You label the emotional state of a fictional character. Answer with exactly one word from the given list and nothing else.' },
    { role: 'user', content: `Character: ${char.name}\nPossible moods: ${list}\nPrevious mood: ${prev}\n\n${char.name}'s latest reply:\n"""${reply.slice(-1500)}"""\n\nWhich one mood from the list best describes ${char.name} right now? One word.` }
  ], { temperature: 0, max_tokens: 6, frequency_penalty: 0, presence_penalty: 0 });
  const w = out.toLowerCase();
  const hit = (char.moods || []).find((m) => w.includes(m));
  return hit || cleanMood(w.split(/[\s,.]+/)[0]) || prev;
}

// ---------- model loading ----------
function setStatus() {
  const pill = $('#statusPill');
  pill.classList.remove('ready', 'busy');
  if (state.loading) { pill.textContent = 'Loading…'; pill.classList.add('busy'); return; }
  if (state.generating) { pill.textContent = 'Writing…'; pill.classList.add('busy'); return; }
  const id = llm.currentModel();
  if (id) {
    const m = llm.MODELS.find((x) => x.id === id);
    pill.textContent = '● ' + (m ? m.label.split(' (')[0] : id);
    pill.classList.add('ready');
  } else pill.textContent = state.gpu && !state.gpu.ok ? 'No WebGPU' : 'No model';
}
function showProgress(p, text) {
  const box = $('#progress');
  box.hidden = false;
  $('#progressBar').style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
  $('#progressText').textContent = text;
}
const hideProgress = () => { $('#progress').hidden = true; };

function effectiveModel() {
  if (state.gpu && state.gpu.ok && state.gpu.f16 === false) {
    const m = llm.MODELS.find((x) => x.id === settings.model);
    if (!m || m.f16) return llm.F32_FALLBACK;
  }
  return settings.model;
}

async function ensureModel() {
  if (llm.isReady() && llm.currentModel() === effectiveModel()) return true;
  if (!state.gpu || !state.gpu.ok) { toast('WebGPU is not available on this browser, so the AI model cannot run here.'); return false; }
  if (state.loading) { toast('Model is still loading…'); return false; }
  state.loading = true; setStatus();
  const id = effectiveModel();
  showProgress(0, 'Preparing ' + id + '…');
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await llm.load(id, (r) => showProgress(r.progress || 0, r.text || ''));
    hideProgress();
    toast('Model ready. It is saved on this device for offline use.');
    return true;
  } catch (e) {
    console.error(e);
    showProgress(0, 'Could not load the model: ' + (e && e.message || e) + (/memory|OOM|allocate|device lost/i.test(String(e)) ? ' Try a smaller model in Settings.' : ''));
    return false;
  } finally {
    state.loading = false; setStatus();
    if (state.view === 'home' || state.view === 'settings') render();
  }
}

// ---------- navigation ----------
function go(view, opts = {}) {
  if (state.view !== view || opts.push) state.history.push({ view: state.view, charId: state.charId, chatId: state.chatId });
  Object.assign(state, opts, { view });
  render();
}
function back() {
  if (state.generating) llm.interrupt();
  const prev = state.history.pop() || { view: 'home' };
  Object.assign(state, prev);
  render();
}

function setTitle(text, extra) {
  const t = $('#title');
  t.replaceChildren(h('span', { text }), extra || '');
  $('#backBtn').hidden = state.view === 'home';
  $('#settingsBtn').hidden = state.view === 'settings';
}

function openSheet(title, buildBody) {
  const sheet = $('#sheet');
  const body = h('div', { class: 'sheet-body', onclick: (e) => e.stopPropagation() }, title ? h('h3', { text: title }) : null);
  buildBody(body, closeSheet);
  sheet.replaceChildren(body);
  sheet.hidden = false;
  sheet.onclick = closeSheet;
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet').replaceChildren(); }
function confirmSheet(title, msg, okText, onOk) {
  openSheet(title, (b, close) => {
    b.append(h('p', { text: msg, style: 'color:var(--muted)' }),
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn danger', text: okText, onclick: async () => { close(); await onOk(); } }),
        h('button', { class: 'btn', text: 'Cancel', onclick: close })));
  });
}

// ---------- views ----------
async function render() {
  const view = $('#view');
  view.classList.toggle('chat-mode', state.view === 'chat');
  view.scrollTop = 0;
  setStatus();
  if (state.view === 'home') return renderHome(view);
  if (state.view === 'editor') return renderEditor(view);
  if (state.view === 'chats') return renderChats(view);
  if (state.view === 'chat') return renderChat(view);
  if (state.view === 'settings') return renderSettings(view);
}

function gpuBanner() {
  const g = state.gpu;
  if (!g || g.ok) return null;
  const why = g.reason === 'insecure' ? 'This page must be opened over HTTPS (for example from GitHub Pages).'
    : g.reason === 'no-adapter' ? 'Your browser exposes WebGPU but no GPU adapter was available.'
      : 'This browser does not support WebGPU.';
  return h('div', { class: 'banner warn' },
    h('strong', { text: 'WebGPU unavailable, so the AI model cannot run here. ' }), why,
    h('div', { class: 'hint', style: 'color:#f3d0d0;margin-top:6px', text: 'On iPhone: update to iOS 26 or newer and open this app in Safari. On older iOS 18, turn on Settings → Apps → Safari → Advanced → Feature Flags → WebGPU. You can still create, edit and import characters.' }));
}

function modelCard() {
  const card = h('div', { class: 'card' });
  const sel = h('select', { id: 'modelSelect', 'aria-label': 'Model' },
    llm.MODELS.map((m) => h('option', { value: m.id, selected: m.id === settings.model, text: m.label })));
  const note = h('div', { class: 'hint' });
  const updNote = async () => {
    const m = llm.MODELS.find((x) => x.id === sel.value);
    note.textContent = m ? m.note : '';
    if (state.gpu && state.gpu.ok) {
      const cached = await llm.isCached(sel.value);
      note.textContent = (m ? m.note : '') + (cached ? ' · ✓ downloaded' : ' · not downloaded yet');
    }
  };
  sel.addEventListener('change', () => { settings.model = sel.value; saveSettings(); updNote(); render(); });
  updNote();
  const loaded = llm.currentModel() === effectiveModel();
  const btn = h('button', {
    class: 'btn primary', id: 'loadBtn', disabled: state.loading || loaded || !(state.gpu && state.gpu.ok),
    text: loaded ? 'Loaded ✓' : state.loading ? 'Loading…' : 'Download & load',
    onclick: () => ensureModel()
  });
  card.append(...[h('h3', { text: 'AI model (runs on this phone)' }), sel, note,
    state.gpu && state.gpu.ok && state.gpu.f16 === false ? h('div', { class: 'hint', text: 'Your GPU lacks 16-bit shader support, so the Llama 3.2 1B q4f32 build will be used instead.' }) : null,
    h('div', { class: 'row', style: 'margin-top:10px' }, btn)].filter(Boolean));
  return card;
}

const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches;

function installGuide() {
  if (isStandalone()) return null; // already installed: hide the guide
  const open = localStorage.getItem('story-install-collapsed') !== '1';
  const d = h('details', { class: 'card install', id: 'installGuide', open },
    h('summary', { text: '📲 How to install on iPhone' }),
    h('ol', {},
      h('li', { html: 'Open this link in <strong>Safari</strong> (iOS 26 or newer).' }),
      h('li', { html: 'Tap the <strong>Share</strong> button <span aria-hidden="true">(square with ↑ arrow)</span>.' }),
      h('li', { html: 'Scroll down and choose <strong>Add to Home Screen</strong>.' }),
      h('li', { html: 'Tap <strong>Add</strong>.' }),
      h('li', { html: 'Open <strong>Stories</strong> from your Home Screen, then tap <strong>Download &amp; load</strong> once on Wi-Fi. The default model is about <strong>0.7 GB</strong> (Hermes 3B is about 1.8 GB).' })),
    h('div', { class: 'hint', text: 'After that one download, the app and model work fully offline, even in airplane mode.' }));
  d.addEventListener('toggle', () => localStorage.setItem('story-install-collapsed', d.open ? '0' : '1'));
  return d;
}

async function renderHome(view) {
  setTitle('Stories');
  const chars = await allCharacters();
  const list = h('div');
  for (const c of chars) {
    const chats = await db.chatsFor(c.id);
    const lastChat = chats.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const mood = c.kind === 'storyteller' ? null : (lastChat?.mood || c.defaultMood);
    list.append(h('div', { class: 'card char', 'data-id': c.id },
      h('div', { class: 'avatar', style: `background:${c.color || '#c084fc'}`, text: c.kind === 'storyteller' ? '✦' : (c.name || '?')[0].toUpperCase() }),
      h('div', { class: 'char-body' },
        h('div', { class: 'char-name' }, c.name, c.kind !== 'storyteller' ? h('span', { class: 'hint', style: 'margin:0', text: String(c.age) }) : null, mood ? h('span', { class: 'badge', text: mood }) : null),
        h('div', { class: 'char-desc', text: c.kind === 'storyteller' ? 'Invents new characters and stories on demand.' : (c.personality || c.backstory || '') }),
        h('div', { class: 'row' },
          h('button', { class: 'btn small primary', text: 'Chat', onclick: () => openCharacter(c.id) }),
          h('button', { class: 'btn small', text: 'Chats' + (chats.length ? ` (${chats.length})` : ''), onclick: () => go('chats', { charId: c.id }) }),
          c.kind !== 'storyteller' ? h('button', { class: 'btn small', text: 'Edit', onclick: () => go('editor', { editing: structuredClone(c) }) }) : null,
          h('button', { class: 'btn small', text: '•••', 'aria-label': 'More', onclick: () => charMenu(c) })))));
  }
  view.replaceChildren(
    installGuide() || '',
    gpuBanner() || '',
    modelCard(),
    h('div', { class: 'section-title' }, h('span', { text: 'Characters' }),
      h('span', { class: 'row' },
        h('button', { class: 'btn small', text: 'Import', onclick: importCharacter }),
        h('button', { class: 'btn small primary', id: 'newCharBtn', text: '+ New', onclick: () => go('editor', { editing: blankCharacter() }) }))),
    list,
    h('div', { class: 'hint', style: 'text-align:center;margin-top:16px', text: 'Everything is stored only on this device. Fiction for adults (18+).' }));
}

function charMenu(c) {
  openSheet(c.name, (b, close) => {
    b.append(h('div', { class: 'sheet-actions' },
      c.kind !== 'storyteller' ? h('button', { class: 'btn', text: '✎ Edit', onclick: () => { close(); go('editor', { editing: structuredClone(c) }); } }) : null,
      h('button', { class: 'btn', text: '⧉ Duplicate', onclick: async () => { close(); await duplicateCharacter(c); } }),
      h('button', { class: 'btn', text: '⇩ Export as JSON', onclick: () => { close(); exportCharacter(c); } }),
      h('button', { class: 'btn', text: '📖 New story', onclick: () => { close(); newStory(c.id); } }),
      h('button', { class: 'btn danger', text: '🗑 Delete', onclick: () => { close(); deleteCharacter(c); } }),
      h('button', { class: 'btn', text: 'Cancel', onclick: close })));
  });
}

async function duplicateCharacter(c) {
  const copy = { ...structuredClone(c), id: uid(), name: c.name + ' (copy)', preset: false, kind: 'character', createdAt: 0 };
  if (c.kind === 'storyteller') { copy.kind = 'storyteller'; }
  await saveCharacter(copy);
  toast('Duplicated ' + c.name);
  render();
}
function exportCharacter(c) {
  const { id, createdAt, updatedAt, preset, ...rest } = c;
  download(`${slug(c.name)}.character.json`, {
    format: 'story-app-character', version: 1, character: rest,
    // SillyTavern-compatible copy
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: c.name,
      description: [`Age: ${c.age}`, c.appearance && `Appearance: ${c.appearance}`, c.backstory && `Backstory: ${c.backstory}`, c.secrets && `Secrets: ${c.secrets}`, c.speakingStyle && `Speaking style: ${c.speakingStyle}`].filter(Boolean).join('\n'),
      personality: c.personality, scenario: c.scenario, first_mes: c.firstMessage, mes_example: c.exampleDialogue || '',
      creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '1',
      extensions: { story_app: { moods: c.moods, defaultMood: c.defaultMood } }
    }
  });
}
function deleteCharacter(c) {
  confirmSheet('Delete ' + c.name + '?', 'This deletes the character and all of their chats from this device.', 'Delete', async () => {
    for (const ch of await db.chatsFor(c.id)) await db.del('chats', ch.id);
    await db.del('characters', c.id);
    toast('Deleted ' + c.name);
    if (state.view !== 'home') state.history = [];
    state.view = 'home';
    render();
  });
}
async function importCharacter() {
  const file = await pickFile('.json,application/json,.png,image/png');
  if (!file) return;
  try {
    let obj;
    if (/png$/i.test(file.type) || /\.png$/i.test(file.name)) obj = await readPngCard(file);
    else obj = JSON.parse(await file.text());
    if (obj.format === 'story-app-backup') return importBackup(obj);
    const list = Array.isArray(obj) ? obj : [obj];
    let saved = 0;
    for (const o of list) {
      const c = fromAnyJSON(o);
      if (validateCharacter(c).length) {
        toast('Please confirm the character\'s age (18+) and details before saving.');
        go('editor', { editing: c });
        return;
      }
      await saveCharacter(c); saved++;
    }
    toast(`Imported ${saved} character${saved === 1 ? '' : 's'}`);
    render();
  } catch (e) {
    toast('Import failed: ' + e.message, 4000);
  }
}

function renderEditor(view) {
  const c = state.editing;
  setTitle(c.createdAt ? 'Edit character' : 'New character');
  const field = (key, label, type = 'input', ph = '', extra = {}) => {
    const val = key === 'moods' ? (c.moods || []).join(', ') : (c[key] ?? '');
    const inp = type === 'textarea' ? h('textarea', { id: 'f-' + key, placeholder: ph, rows: extra.rows || 3 }) : h('input', { id: 'f-' + key, placeholder: ph, type: extra.type || 'text', ...extra.attrs });
    inp.value = Number.isNaN(val) ? '' : val;
    inp.addEventListener('input', () => { c[key] = key === 'age' ? inp.value : inp.value; });
    return [h('label', { for: 'f-' + key, text: label }), inp, extra.hint ? h('div', { class: 'hint', text: extra.hint }) : null];
  };
  const err = h('div', { class: 'banner warn', hidden: true, id: 'editorError' });
  const colorRow = h('div', { class: 'row' }, COLORS.map((col) => h('button', {
    class: 'avatar', 'aria-label': 'Color ' + col, style: `width:32px;height:32px;font-size:14px;background:${col};border:${c.color === col ? '3px solid #fff' : '0'}`,
    onclick: (e) => { e.preventDefault(); c.color = col; renderEditor(view); }
  })));
  const form = h('form', { id: 'editorForm', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    c.moods = normalizeMoods(c.moods);
    const errs = validateCharacter(c);
    if (errs.length) { err.hidden = false; err.textContent = errs.join(' '); err.scrollIntoView({ behavior: 'smooth' }); return; }
    await saveCharacter(c);
    toast('Saved ' + c.name);
    state.history = state.history.filter((x) => x.view !== 'editor');
    back();
  } },
  err,
  field('name', 'Name *', 'input', 'e.g. Mara'),
  field('age', `Age * (${MIN_AGE}+ only)`, 'input', '25', { type: 'number', attrs: { min: String(MIN_AGE), max: '1000', inputmode: 'numeric', step: '1' }, hint: 'All characters must be adults.' }),
  field('appearance', 'Appearance', 'textarea', 'Hair, eyes, build, style, distinctive features…'),
  field('personality', 'Personality', 'textarea', 'Guarded, sarcastic, fiercely loyal…'),
  field('defaultMood', 'Default mood', 'input', 'wary'),
  field('moods', 'Possible moods (comma separated)', 'input', 'wary, playful, warm, cold, angry', { hint: 'The current mood is shown as a badge and changes as the story goes.' }),
  field('backstory', 'Backstory', 'textarea', 'Where they come from, what they want…', { rows: 4 }),
  field('secrets', 'Secrets', 'textarea', 'Things they hide, revealed slowly…'),
  field('speakingStyle', 'Speaking style', 'textarea', 'Short clipped sentences, dry humor…'),
  field('scenario', 'Scenario', 'textarea', 'Where and how the story starts…'),
  field('firstMessage', 'Opening message', 'textarea', '*She looks up as you walk in…* "You\'re late."', { rows: 4 }),
  field('exampleDialogue', 'Example dialogue (optional)', 'textarea', '{{user}}: Hi\n{{char}}: *smirks* "Took you long enough."'),
  h('label', { text: 'Color' }), colorRow,
  h('div', { class: 'row end', style: 'margin-top:18px' },
    h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: back }),
    h('button', { type: 'submit', class: 'btn primary', id: 'saveCharBtn', text: 'Save character' })));
  view.replaceChildren(form);
}

async function renderChats(view) {
  const c = await db.get('characters', state.charId);
  if (!c) return back();
  setTitle(c.name + ' · chats');
  const chats = (await db.chatsFor(c.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  const list = chats.length ? chats.map((ch) => {
    const last = [...ch.messages].reverse().find((m) => !m.hidden);
    return h('div', { class: 'card chat-item' },
      h('div', { onclick: () => go('chat', { charId: c.id, chatId: ch.id }) },
        h('div', { class: 't' }, ch.title || 'Chat', ' ', ch.mood && c.kind !== 'storyteller' ? h('span', { class: 'badge', text: ch.mood }) : null),
        h('div', { class: 's', text: (last?.content || '').slice(0, 90) }),
        h('div', { class: 'hint', text: new Date(ch.updatedAt).toLocaleString() + ` · ${ch.messages.length} messages` })),
      h('button', { class: 'btn small', text: '•••', onclick: () => openSheet(ch.title || 'Chat', (b, close) => b.append(h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn', text: 'Rename', onclick: async () => { const t = prompt('Chat name', ch.title || ''); if (t != null) { ch.title = t.trim() || ch.title; await db.put('chats', ch); } close(); render(); } }),
        h('button', { class: 'btn', text: 'Export chat', onclick: () => { close(); download(`${slug(c.name)}-chat.json`, ch); } }),
        h('button', { class: 'btn danger', text: 'Delete chat', onclick: () => { close(); confirmSheet('Delete chat?', 'This cannot be undone.', 'Delete', async () => { await db.del('chats', ch.id); render(); }); } }),
        h('button', { class: 'btn', text: 'Cancel', onclick: close })))) }));
  }) : [h('div', { class: 'empty', text: 'No chats yet.' })];
  view.replaceChildren(
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('button', { class: 'btn primary', text: '+ New chat', onclick: async () => { const ch = await createChat(c); go('chat', { charId: c.id, chatId: ch.id }); } }),
      h('button', { class: 'btn', text: '📖 New story', onclick: () => newStory(c.id) })),
    ...list);
}

async function createChat(c, opts = {}) {
  const now = Date.now();
  const n = (await db.chatsFor(c.id)).length + 1;
  const chat = { id: uid(), charId: c.id, title: opts.title || `Story ${n}`, mood: c.defaultMood, messages: [], createdAt: now, updatedAt: now };
  if (c.firstMessage && !opts.skipGreeting) chat.messages.push({ id: uid(), role: 'assistant', content: c.firstMessage.replace(/\{\{user\}\}/gi, settings.userName || 'you').replace(/\{\{char\}\}/gi, c.name), mood: c.defaultMood, ts: now });
  await db.put('chats', chat);
  return chat;
}

async function openCharacter(charId) {
  const c = await db.get('characters', charId);
  const chats = (await db.chatsFor(charId)).sort((a, b) => b.updatedAt - a.updatedAt);
  const chat = chats[0] || await createChat(c);
  go('chat', { charId, chatId: chat.id });
}

async function newStory(charId) {
  const c = await db.get('characters', charId);
  const chat = await createChat(c, { skipGreeting: true });
  const text = c.kind === 'storyteller'
    ? 'Start a brand-new story: invent a fresh, original setting and genre, an adult cast with distinct personalities and moods, and a vivid opening scene. End with a hook.'
    : `(Director's note: start a brand-new story with ${c.name}. Invent a fresh scenario and setting that fits ${c.name}'s personality and is different from the default scenario, then open with a vivid in-character scene that ends on a hook for me.)`;
  chat.messages.push({ id: uid(), role: 'user', content: text, hidden: c.kind !== 'storyteller', ts: Date.now() });
  await db.put('chats', chat);
  state.history = state.history.filter((x) => x.view !== 'chat');
  go('chat', { charId, chatId: chat.id });
  generate('reply');
}

// ---- chat view ----
let chatCtx = null; // {char, chat, els}

async function renderChat(view) {
  const char = await db.get('characters', state.charId);
  const chat = await db.get('chats', state.chatId);
  if (!char || !chat) { state.view = 'home'; return render(); }
  const badge = h('span', { class: 'badge', id: 'moodBadge', text: chat.mood || char.defaultMood, hidden: char.kind === 'storyteller' || !settings.moodTracking });
  setTitle(char.name, badge);
  const messages = h('div', { id: 'messages' });
  const input = h('textarea', { id: 'chatInput', rows: 1, placeholder: `Message ${char.name}…`, enterkeyhint: 'send' });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); send(); } });
  const sendBtn = h('button', { id: 'sendBtn', 'aria-label': 'Send', text: '↑', onclick: () => (state.generating ? llm.interrupt() : send()) });
  const chips = h('div', { class: 'chips' });
  if (char.kind === 'storyteller') {
    chips.append(
      h('button', { class: 'chip', text: '🎭 New character', onclick: () => sendText('Create a new original character for me to chat with.') }),
      h('button', { class: 'chip', text: '🎲 Surprise character', onclick: () => sendText('Create a surprising, unusual new character in a random genre.') }),
      h('button', { class: 'chip', text: '📖 New story', onclick: () => newStory(char.id) }));
  } else {
    chips.append(h('button', { class: 'chip', text: '📖 New story', onclick: () => newStory(char.id) }));
  }
  chips.append(
    h('button', { class: 'chip', text: '↻ Regenerate', onclick: () => generate('regen') }),
    h('button', { class: 'chip', text: '→ Continue', onclick: () => generate('continue') }),
    h('button', { class: 'chip', text: '☰ Chats', onclick: () => go('chats', { charId: char.id }) }),
    h('button', { class: 'chip', text: '⚙ Tweak', onclick: quickSettings }));
  const composer = h('div', { id: 'composer' }, chips, h('div', { class: 'row' }, input, sendBtn));
  view.replaceChildren(gpuBanner() ? h('div', { style: 'padding:10px 12px 0' }, gpuBanner()) : '', messages, composer);
  chatCtx = { char, chat, els: { messages, input, sendBtn, badge } };
  drawMessages();
  updateSendBtn();
}

function drawMessages() {
  if (!chatCtx) return;
  const { char, chat, els } = chatCtx;
  els.messages.replaceChildren();
  if (!chat.messages.length) els.messages.append(h('div', { class: 'empty', text: `Say something to ${char.name} to begin.` }));
  chat.messages.forEach((m) => els.messages.append(messageEl(m)));
  els.messages.scrollTop = els.messages.scrollHeight;
}

function messageEl(m) {
  const { char } = chatCtx;
  if (m.hidden) return h('div', { class: 'msg note', 'data-id': m.id, text: '— new story —', onclick: () => msgMenu(m) });
  const body = h('div', { class: 'body', html: fmt(m.content) });
  const el = h('div', { class: 'msg ' + m.role, 'data-id': m.id }, body);
  const meta = h('div', { class: 'meta' });
  if (m.role === 'assistant' && m.mood && char.kind !== 'storyteller' && settings.moodTracking) meta.append(h('span', { class: 'badge', text: m.mood }));
  if (m.role === 'assistant') {
    const found = extractCharacterJSON(m.content);
    if (found) meta.append(h('button', { class: 'btn small primary', text: '＋ Save character', onclick: (e) => { e.stopPropagation(); saveFromStoryteller(found); } }));
    if (m.truncated) meta.append(h('button', { class: 'btn small', text: '→ Continue', onclick: (e) => { e.stopPropagation(); generate('continue'); } }));
  }
  if (meta.childNodes.length) el.append(meta);
  el.addEventListener('click', (e) => { if (!e.target.closest('button')) msgMenu(m); });
  return el;
}

async function saveFromStoryteller(obj) {
  const c = fromAnyJSON(obj);
  if (validateCharacter(c).length) {
    toast(`Set an age of ${MIN_AGE}+ to save this character.`);
    go('editor', { editing: c });
    return;
  }
  await saveCharacter(c);
  openSheet('Saved ' + c.name, (b, close) => b.append(h('div', { class: 'sheet-actions' },
    h('button', { class: 'btn primary', text: 'Chat with ' + c.name, onclick: () => { close(); openCharacter(c.id); } }),
    h('button', { class: 'btn', text: 'Edit ' + c.name, onclick: () => { close(); go('editor', { editing: structuredClone(c) }); } }),
    h('button', { class: 'btn', text: 'Stay here', onclick: close }))));
}

function msgMenu(m) {
  if (state.generating) return;
  const { chat } = chatCtx;
  const idx = chat.messages.findIndex((x) => x.id === m.id);
  const isLast = idx === chat.messages.length - 1;
  openSheet(m.role === 'user' ? 'Your message' : 'Reply', (b, close) => b.append(h('div', { class: 'sheet-actions' },
    h('button', { class: 'btn', text: '✎ Edit', onclick: () => { close(); editMessage(m); } }),
    navigator.clipboard ? h('button', { class: 'btn', text: '⧉ Copy', onclick: () => { navigator.clipboard.writeText(m.content); close(); toast('Copied'); } }) : null,
    m.role === 'assistant' && isLast ? h('button', { class: 'btn', text: '↻ Regenerate', onclick: () => { close(); generate('regen'); } }) : null,
    m.role === 'assistant' && isLast ? h('button', { class: 'btn', text: '→ Continue', onclick: () => { close(); generate('continue'); } }) : null,
    m.role === 'user' ? h('button', { class: 'btn', text: '↻ Resend from here', onclick: async () => { close(); chat.messages = chat.messages.slice(0, idx + 1); await saveChat(); drawMessages(); generate('reply'); } }) : null,
    h('button', { class: 'btn danger', text: '🗑 Delete message', onclick: async () => { close(); chat.messages.splice(idx, 1); await saveChat(); drawMessages(); } }),
    h('button', { class: 'btn danger', text: '✂ Delete this and everything after', onclick: async () => { close(); chat.messages = chat.messages.slice(0, idx); recomputeMood(); await saveChat(); drawMessages(); } }),
    h('button', { class: 'btn', text: 'Cancel', onclick: close }))));
}

function editMessage(m) {
  openSheet('Edit message', (b, close) => {
    const ta = h('textarea', { rows: 8, id: 'editMsgText' });
    ta.value = m.content;
    const moodIn = h('input', { id: 'editMsgMood', placeholder: 'mood' });
    moodIn.value = m.mood || '';
    b.append(ta,
      m.role === 'assistant' && chatCtx.char.kind !== 'storyteller' ? h('div', {}, h('label', { text: 'Mood after this reply' }), moodIn) : '',
      h('div', { class: 'row end', style: 'margin-top:12px' },
        h('button', { class: 'btn', text: 'Cancel', onclick: close }),
        h('button', { class: 'btn primary', text: 'Save', onclick: async () => {
          m.content = ta.value;
          if (m.role === 'assistant') { m.mood = cleanMood(moodIn.value) || m.mood; recomputeMood(); }
          close(); await saveChat(); drawMessages(); updateBadge();
        } })));
    setTimeout(() => ta.focus(), 50);
  });
}

function recomputeMood() {
  const { char, chat } = chatCtx;
  const last = [...chat.messages].reverse().find((x) => x.role === 'assistant' && x.mood);
  chat.mood = last ? last.mood : char.defaultMood;
  updateBadge();
}
function updateBadge(changed) {
  if (!chatCtx) return;
  const { badge } = chatCtx.els;
  badge.textContent = chatCtx.chat.mood || chatCtx.char.defaultMood;
  if (changed) { badge.classList.remove('mood-change'); void badge.offsetWidth; badge.classList.add('mood-change'); }
}
async function saveChat() {
  chatCtx.chat.updatedAt = Date.now();
  await db.put('chats', chatCtx.chat);
}
function updateSendBtn() {
  if (!chatCtx) return;
  const b = chatCtx.els.sendBtn;
  b.classList.toggle('stop', state.generating);
  b.textContent = state.generating ? '■' : '↑';
  b.setAttribute('aria-label', state.generating ? 'Stop' : 'Send');
}

async function send() {
  const text = chatCtx.els.input.value.trim();
  if (!text) return;
  chatCtx.els.input.value = '';
  chatCtx.els.input.style.height = 'auto';
  await sendText(text);
}
async function sendText(text) {
  if (state.generating) return;
  const { chat } = chatCtx;
  chat.messages.push({ id: uid(), role: 'user', content: text, ts: Date.now() });
  await saveChat();
  drawMessages();
  generate('reply');
}

async function generate(mode) {
  if (state.generating || !chatCtx) return;
  const { char, chat } = chatCtx;
  if (!(await ensureModel())) return;
  if (!chatCtx || chatCtx.chat !== chat) return;
  let target;
  let extra = null;
  let prefix = '';
  if (mode === 'regen') {
    const last = chat.messages[chat.messages.length - 1];
    if (last && last.role === 'assistant') {
      chat.messages.pop();
      recomputeMood();
    }
  }
  if (mode === 'continue') {
    const last = chat.messages[chat.messages.length - 1];
    if (last && last.role === 'assistant') {
      target = last;
      prefix = last.content;
      extra = `(Continue your previous reply exactly where it stopped. Do not repeat anything already written.)`;
    }
  }
  if (!target) {
    target = { id: uid(), role: 'assistant', content: '', ts: Date.now() };
    chat.messages.push(target);
  }
  const msgs = buildMessages(char, mode === 'continue' && extra ? { ...chat, messages: chat.messages } : { ...chat, messages: chat.messages.slice(0, -1) }, extra);
  drawMessages();
  const node = chatCtx.els.messages.querySelector(`[data-id="${target.id}"] .body`);
  node.parentElement.classList.add('typing');
  state.generating = true; setStatus(); updateSendBtn();
  let raw = '';
  let finish = null;
  try {
    for await (const ev of llm.stream(msgs, settings)) {
      if (ev.delta) {
        raw += ev.delta;
        const joined = prefix ? prefix + (/^[\s.,!?;:]/.test(raw) ? '' : ' ') + raw : raw;
        node.innerHTML = fmt(displayStreaming(joined));
        const box = chatCtx.els.messages;
        if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
      }
      if (ev.done) finish = ev.finish;
    }
  } catch (e) {
    console.error(e);
    toast('Generation error: ' + (e.message || e), 4000);
  }
  const joined = prefix ? prefix + (/^[\s.,!?;:]/.test(raw) ? '' : ' ') + raw : raw;
  const { text, mood } = splitMood(joined);
  target.content = text || target.content || '…';
  target.truncated = finish === 'length';
  let newMood = mood;
  if (char.kind !== 'storyteller' && settings.moodTracking) {
    if (!newMood && settings.moodFallback && raw.trim()) {
      try { newMood = await classifyMood(char, chat, target.content); } catch (e) { console.warn('mood classify failed', e); }
    }
    if (newMood) {
      target.mood = newMood;
      const changed = newMood !== chat.mood;
      chat.mood = newMood;
      updateBadge(changed);
    } else if (!target.mood) target.mood = chat.mood;
  }
  state.generating = false; setStatus(); updateSendBtn();
  chat.updatedAt = Date.now();
  await db.put('chats', chat);
  if (chatCtx && chatCtx.chat === chat) drawMessages();
}

function quickSettings() {
  openSheet('Generation', (b, close) => {
    b.append(...rangeField('temperature', 'Temperature (creativity)', 0, 2, 0.05), ...rangeField('max_tokens', 'Max reply length (tokens)', 64, 1024, 16),
      h('div', { class: 'row end', style: 'margin-top:14px' }, h('button', { class: 'btn primary', text: 'Done', onclick: close })));
  });
}
function rangeField(key, label, min, max, step) {
  const out = h('output', { text: String(settings[key]) });
  const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), id: 'r-' + key });
  r.value = settings[key];
  r.addEventListener('input', () => { settings[key] = Number(r.value); out.textContent = r.value; saveSettings(); });
  return [h('label', { for: 'r-' + key, text: label }), h('div', { class: 'range-row' }, r, out)];
}

async function renderSettings(view) {
  setTitle('Settings');
  const txt = (key, label, ph, area) => {
    const inp = area ? h('textarea', { rows: 3, placeholder: ph }) : h('input', { placeholder: ph });
    inp.value = settings[key] || '';
    inp.addEventListener('change', () => { settings[key] = inp.value; saveSettings(); });
    return [h('label', { text: label }), inp];
  };
  const check = (key, label) => {
    const c = h('input', { type: 'checkbox', checked: !!settings[key] });
    c.addEventListener('change', () => { settings[key] = c.checked; saveSettings(); });
    return h('label', { class: 'check' }, c, label);
  };
  const lenSel = h('select', {}, ['short', 'medium', 'long'].map((v) => h('option', { value: v, text: v, selected: settings.replyLength === v })));
  lenSel.addEventListener('change', () => { settings.replyLength = lenSel.value; saveSettings(); });
  let storage = '';
  try { const est = await navigator.storage.estimate(); storage = `Using ${(est.usage / 1e9).toFixed(2)} GB of ${(est.quota / 1e9).toFixed(1)} GB available to this app.`; } catch {}
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  view.replaceChildren(
    gpuBanner() || '',
    modelCard(),
    h('div', { class: 'card' }, h('h3', { text: 'Generation' }),
      ...rangeField('temperature', 'Temperature (creativity)', 0, 2, 0.05),
      ...rangeField('max_tokens', 'Max reply length (tokens)', 64, 1024, 16),
      ...rangeField('top_p', 'Top-p', 0.1, 1, 0.01),
      ...rangeField('frequency_penalty', 'Repetition penalty', 0, 1.5, 0.05),
      h('label', { text: 'Reply length hint' }), lenSel,
      h('div', { class: 'hint', text: `Context window: ${llm.CONTEXT_WINDOW} tokens. Older messages are trimmed automatically to fit.` })),
    h('div', { class: 'card' }, h('h3', { text: 'You' }),
      ...txt('userName', 'Your name in stories (optional)', 'Leave blank to be called "you"'),
      ...txt('userPersona', 'About you (optional)', 'Appearance, personality, role…', true)),
    h('div', { class: 'card' }, h('h3', { text: 'Moods' }),
      check('moodTracking', 'Track and show character moods'),
      check('moodFallback', 'If the model forgets the mood tag, ask it in a quick second pass')),
    h('div', { class: 'card' }, h('h3', { text: 'Storage & data' }),
      h('div', { class: 'hint', text: storage + (persisted ? ' Storage is persistent.' : ' Tap "Keep data" so iOS does not clear the model.') }),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn small', text: 'Keep data', onclick: async () => { const ok = await navigator.storage?.persist?.(); toast(ok ? 'Storage is now persistent' : 'The browser did not grant persistent storage. Adding the app to your Home Screen helps.'); render(); } }),
        h('button', { class: 'btn small', text: 'Export backup', onclick: exportBackup }),
        h('button', { class: 'btn small', text: 'Import backup', onclick: importCharacter }),
        h('button', { class: 'btn small', text: 'Restore presets', onclick: async () => { await seedPresets(true); toast('Presets restored'); } }),
        h('button', { class: 'btn small danger', text: 'Delete downloaded model', onclick: () => confirmSheet('Delete model files?', `Removes ${effectiveModel()} from this device. You can download it again later.`, 'Delete', async () => { await llm.deleteCached(effectiveModel()); toast('Model files deleted'); render(); }) }),
        h('button', { class: 'btn small danger', text: 'Erase all chats & characters', onclick: () => confirmSheet('Erase everything?', 'Deletes all characters and chats on this device. Presets come back.', 'Erase', async () => { await db.clear('chats'); await db.clear('characters'); await seedPresets(true); toast('Erased'); render(); }) }))),
    h('div', { class: 'hint', style: 'text-align:center', text: 'No analytics, no accounts. The only network requests are the one-time model download from Hugging Face / GitHub.' }));
}

async function exportBackup() {
  download(`stories-backup-${new Date().toISOString().slice(0, 10)}.json`, {
    format: 'story-app-backup', version: 1, exportedAt: new Date().toISOString(),
    characters: await db.all('characters'), chats: await db.all('chats'), settings
  });
}
async function importBackup(obj) {
  for (const c of obj.characters || []) { if (!validateCharacter(c).length) await db.put('characters', c); }
  for (const ch of obj.chats || []) await db.put('chats', ch);
  toast(`Restored ${(obj.characters || []).length} characters and ${(obj.chats || []).length} chats`);
  render();
}

// ---------- boot ----------
async function boot() {
  $('#backBtn').addEventListener('click', back);
  $('#settingsBtn').addEventListener('click', () => go('settings'));
  $('#statusPill').addEventListener('click', () => go('settings'));
  await seedPresets();
  render();
  state.gpu = await llm.gpuStatus();
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
  }
  // Auto-load the model if it's already downloaded so chats are instant.
  if (state.gpu.ok && settings.autoLoad && await llm.isCached(effectiveModel())) ensureModel();
}
window.__app = { state, settings, db, extractCharacterJSON, fromAnyJSON, splitMood, buildMessages, systemPrompt };
boot().catch((e) => { console.error(e); toast('Startup error: ' + e.message, 5000); });
