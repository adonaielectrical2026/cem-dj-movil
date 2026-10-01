'use strict';
/* ============================================================
   CEM DJ móvil: reproductor de música para celular y tablet (estilo reproductor, con los colores del CEM).
   Canciones y listas guardadas en el propio equipo (IndexedDB), mezcla suave entre canciones (crossfade con 2 motores de audio),
   nivelación de volumen (LUFS), "sin voz" rápido y ecualizador de 3 bandas.
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = (s) => { if (!isFinite(s) || s == null) return '–:––'; s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const svg = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const ICON = {
  play: svg('M8 5v14l11-7z'),
  pause: svg('M6 5h4v14H6zM14 5h4v14h-4z'),
  next: svg('M6 18l8.5-6L6 6zM16 6h2v12h-2z'),
  prev: svg('M6 6h2v12H6zM9.5 12l8.5 6V6z'),
  shuffle: svg('M10.6 9.2 5.4 4 4 5.4l5.2 5.2zM14.5 4l2.1 2.1L4 18.6 5.4 20 18 7.4 20 9.5V4zM14.8 13.4l-1.4 1.4 3.2 3.2L14.5 20H20v-5.5l-2.1 2.1z'),
  repeat: svg('M7 7h10v3l4-4-4-4v3H5v6h2zM17 17H7v-3l-4 4 4 4v-3h12v-6h-2z'),
  plus: svg('M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z'),
  more: svg('M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'),
  down: svg('M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z'),
  back: svg('M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z'),
  songs: svg('M12 3v10.55A4 4 0 1 0 14 17V7h4V3z'),
  lists: svg('M15 6H3v2h12zm0 4H3v2h12zM3 16h8v-2H3zM17 6v8.18A3 3 0 1 0 19 17V8h3V6z'),
  settings: svg('M3 17v2h6v-2zM3 5v2h10V5zm10 16v-2h8v-2h-8v-2h-2v6zM7 9v2H3v2h4v2h2V9zm14 4v-2H11v2zm-6-4h2V7h4V5h-4V3h-2z'),
  vol: svg('M3 9v6h4l5 5V4L7 9zM16.5 12A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z'),
  logo: 'logo.jpg',
};

/* ---------------- Base de datos local (canciones) ---------------- */
const DB = (() => {
  let p;
  const open = () => (p ||= new Promise((res, rej) => {
    const r = indexedDB.open('cem-dj-movil', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('songs', mode);
      const rq = fn(t.objectStore('songs'));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  };
  return { all: () => tx('readonly', (s) => s.getAll()), put: (o) => tx('readwrite', (s) => s.put(o)), del: (id) => tx('readwrite', (s) => s.delete(id)) };
})();

/* ---------------- Etiquetas ID3 (título, artista, carátula) ---------------- */
async function readTags(blob) {
  const out = {};
  try {
    const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return out;
    const ver = head[3];
    const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
    const buf = new Uint8Array(await blob.slice(10, 10 + Math.min(size, 8 * 1024 * 1024)).arrayBuffer());
    const sync = (o) => (buf[o] << 21) | (buf[o + 1] << 14) | (buf[o + 2] << 7) | buf[o + 3];
    const u32 = (o) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
    let p = 0;
    if (head[5] & 0x40) p += ver === 4 ? sync(0) : u32(0) + 4;
    while (p + 10 <= buf.length) {
      const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fs = ver === 4 ? sync(p + 4) : u32(p + 4);
      if (fs <= 0 || p + 10 + fs > buf.length) break;
      const body = buf.subarray(p + 10, p + 10 + fs);
      p += 10 + fs;
      if (id === 'TIT2') out.title = id3Text(body);
      else if (id === 'TPE1') out.artist = id3Text(body);
      else if (id === 'APIC' && !out.cover) out.cover = id3Pic(body);
    }
  } catch {}
  return out;
}
function id3Text(b) {
  const label = ['windows-1252', 'utf-16', 'utf-16be', 'utf-8'][b[0]] || 'utf-8';
  return new TextDecoder(label).decode(b.subarray(1)).replace(/\0+$/g, '').replace(/\0/g, ' ').trim();
}
function id3Pic(b) {
  const enc = b[0];
  let i = 1; while (i < b.length && b[i] !== 0) i++;
  const mime = String.fromCharCode(...b.subarray(1, i));
  i += 2;
  if (enc === 0 || enc === 3) { while (i < b.length && b[i] !== 0) i++; i++; }
  else { while (i + 1 < b.length && !(b[i] === 0 && b[i + 1] === 0)) i += 2; i += 2; }
  const data = b.subarray(i);
  if (data.length < 100) return null;
  const type = /^image\/(png|jpe?g|webp|gif)$/.test(mime) ? mime : data[0] === 0x89 ? 'image/png' : 'image/jpeg';
  return new Blob([data], { type });
}

/* ---------------- Ajustes ---------------- */
const S = Object.assign({ xfade: 6, level: true, novoice: false, eq: { low: 0, mid: 0, high: 0 }, vol: 90, shuffle: false, repeat: 'off' }, store.get('cem.s', {}));
S.eq = Object.assign({ low: 0, mid: 0, high: 0 }, S.eq);
const saveS = () => store.set('cem.s', S);

/* ---------------- Audio: dos motores para poder mezclar ---------------- */
let AC = null, master, limiter;

// "Sin voz" rápido: se cancela lo que está al centro (voz) y se conservan los graves
function karaokeChain(c, input, sum) {
  const dry = c.createGain(); input.connect(dry).connect(sum);
  const wet = c.createGain(); wet.gain.value = 0;
  const split = c.createChannelSplitter(2); input.connect(split);
  const sL = c.createGain(); sL.gain.value = 0.7; const sR = c.createGain(); sR.gain.value = -0.7;
  split.connect(sL, 0); split.connect(sR, 1);
  const side = c.createGain(); sL.connect(side); sR.connect(side);
  const mL = c.createGain(); mL.gain.value = 0.5; const mR = c.createGain(); mR.gain.value = 0.5;
  split.connect(mL, 0); split.connect(mR, 1);
  const mid = c.createGain(); mL.connect(mid); mR.connect(mid);
  const b1 = c.createBiquadFilter(); b1.type = 'lowpass'; b1.frequency.value = 110; b1.Q.value = 0.707;
  const b2 = c.createBiquadFilter(); b2.type = 'lowpass'; b2.frequency.value = 110; b2.Q.value = 0.707;
  mid.connect(b1).connect(b2);
  const mono = c.createGain(); mono.channelCount = 2; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
  side.connect(mono); b2.connect(mono);
  mono.connect(wet).connect(sum);
  return { dry, wet };
}

class Engine {
  constructor() {
    this.audio = new Audio(); this.audio.preload = 'auto';
    this.song = null; this.url = null;
    this.audio.addEventListener('play', onPlayState);
    this.audio.addEventListener('pause', onPlayState);
    this.audio.addEventListener('ended', () => onEnded(this));
    this.audio.addEventListener('error', () => { if (this.song && P.cur === this) { toast('No se pudo reproducir «' + this.song.title + '».', 4000); setTimeout(() => P.next(true), 600); } });
  }
  build() {
    if (this.built) return; this.built = true;
    const c = AC;
    this.srcNode = c.createMediaElementSource(this.audio);
    this.norm = c.createGain();
    const sum = c.createGain();
    this.srcNode.connect(this.norm);
    this.kar = karaokeChain(c, this.norm, sum);
    this.low = c.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 250;
    this.mid = c.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 1;
    this.high = c.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 4000;
    this.xf = c.createGain();
    sum.connect(this.low).connect(this.mid).connect(this.high).connect(this.xf).connect(master);
    this.applyFx();
  }
  applyFx() {
    if (!this.built) return;
    const t = AC.currentTime;
    for (const b of ['low', 'mid', 'high']) this[b].gain.value = S.eq[b];
    this.kar.dry.gain.setTargetAtTime(S.novoice ? 0 : 1, t, 0.04);
    this.kar.wet.gain.setTargetAtTime(S.novoice ? 1 : 0, t, 0.04);
    this.applyNorm();
  }
  applyNorm() {
    if (!this.built) return;
    const s = this.song; let g = 1;
    if (s && S.level && s.lufs != null) {
      let db = Math.max(-12, Math.min(9, -14 - s.lufs));
      if (s.peak > 0) db = Math.min(db, -20 * Math.log10(s.peak) - 0.5); // que no se pase de 0 dB
      g = Math.pow(10, db / 20);
    }
    this.norm.gain.setTargetAtTime(g, AC.currentTime, 0.05);
  }
  setSong(song) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.song = song; this.url = URL.createObjectURL(song.blob);
    this.audio.src = this.url; this.audio.load();
    this.applyNorm();
  }
}
const engines = [new Engine(), new Engine()];

function ensureAudio() {
  if (AC) return AC;
  AC = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  master = AC.createGain(); master.gain.value = S.vol / 100;
  limiter = AC.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.1;
  master.connect(limiter).connect(AC.destination);
  engines.forEach((e) => e.build());
  return AC;
}

/* ---------------- Biblioteca (estado) ---------------- */
const songs = new Map();          // id -> canción
let lists = store.get('cem.lists', []); // [{id,name,ids:[]}]
let openList = null;              // id de la lista abierta en "Listas"
const saveLists = () => store.set('cem.lists', lists);
const arts = new Map();           // id -> url de carátula
const artUrl = (s) => { if (!s || !s.cover) return ICON.logo; if (!arts.has(s.id)) arts.set(s.id, URL.createObjectURL(s.cover)); return arts.get(s.id); };

/* ---------------- Reproductor (cola, mezcla, aleatorio, repetir) ---------------- */
const P = {
  cur: null, queue: [], idx: -1, base: [], fading: false, fadeTimer: 0, old: null,
  get song() { return this.cur && this.cur.song; },
  playing() { return engines.some((e) => e.song && !e.audio.paused); },

  start(ids, i) { // empezar una cola nueva
    this.base = ids.slice();
    const first = ids[i];
    if (S.shuffle) { this.queue = shuffled(ids, first); this.idx = 0; } else { this.queue = ids.slice(); this.idx = i; }
    this.goTo(this.idx, 0);
  },
  nextIdx(auto) {
    if (!this.queue.length) return -1;
    if (auto && S.repeat === 'one') return this.idx;
    const n = this.idx + 1;
    if (n < this.queue.length) return n;
    return S.repeat === 'all' ? 0 : -1;
  },
  next(auto) {
    const n = this.nextIdx(auto);
    if (n < 0) { if (auto) this.stopAll(); return; }
    this.goTo(n, auto ? S.xfade : Math.min(S.xfade, 1.2));
  },
  prev() {
    if (!this.cur) return;
    if (this.cur.audio.currentTime > 3 || this.queue.length < 2) { this.cur.audio.currentTime = 0; return; }
    let p = this.idx - 1; if (p < 0) p = S.repeat === 'all' ? this.queue.length - 1 : 0;
    this.goTo(p, Math.min(S.xfade, 1.2));
  },
  stopAll() { this.endFade(); engines.forEach((e) => e.audio.pause()); },
  toggle() {
    if (!this.cur) return;
    if (this.cur.audio.paused) { ensureAudio(); (AC.state !== 'running' ? AC.resume() : Promise.resolve()).then(() => this.cur.audio.play().catch(() => {})); }
    else { this.endFade(); this.cur.audio.pause(); }
  },
  endFade() { // termina una mezcla en curso de golpe
    clearTimeout(this.fadeTimer); this.fading = false;
    if (this.old) { this.old.audio.pause(); this.old = null; }
    if (this.cur && this.cur.built) { this.cur.xf.gain.cancelScheduledValues(AC.currentTime); this.cur.xf.gain.value = 1; }
  },
  async goTo(i, fade) {
    const song = songs.get(this.queue[i]);
    if (!song) { this.queue.splice(i, 1); if (this.queue.length) return this.goTo(Math.min(i, this.queue.length - 1), 0); return; }
    ensureAudio();
    this.endFade();
    const old = this.cur && !this.cur.audio.paused ? this.cur : null;
    const nw = engines.find((e) => e !== this.cur) || engines[0];
    if (!old && this.cur) this.cur.audio.pause();
    this.idx = i;
    nw.setSong(song);
    const secs = old ? Math.max(0, Math.min(fade, (old.audio.duration - old.audio.currentTime) || fade, (song.dur || 99) / 3)) : 0;
    const t = AC.currentTime;
    nw.xf.gain.cancelScheduledValues(t); nw.xf.gain.value = secs > 0.05 ? 0 : 1;
    this.cur = nw;
    if (AC.state !== 'running') { try { await AC.resume(); } catch {} }
    nw.audio.currentTime = 0;
    try { await nw.audio.play(); } catch {}
    if (old && secs > 0.05) {
      const N = 64, fin = new Float32Array(N), fout = new Float32Array(N);
      for (let k = 0; k < N; k++) { const x = k / (N - 1); fin[k] = Math.sin(x * Math.PI / 2); fout[k] = Math.cos(x * Math.PI / 2); }
      const t0 = AC.currentTime;
      nw.xf.gain.setValueCurveAtTime(fin, t0, secs);
      old.xf.gain.cancelScheduledValues(t0); old.xf.gain.setValueCurveAtTime(fout, t0, secs);
      this.old = old; this.fading = true;
      this.fadeTimer = setTimeout(() => { if (this.old === old) { old.audio.pause(); this.old = null; } this.fading = false; }, secs * 1000 + 150);
    } else if (old) { old.audio.pause(); }
    onSongChange();
  },
  seekFrac(f) { const a = this.cur && this.cur.audio; if (a && a.duration) a.currentTime = f * a.duration; },
  insertNext(id) { if (this.idx < 0) return false; this.queue.splice(this.idx + 1, 0, id); return true; },
};
function shuffled(ids, first) {
  const rest = ids.filter((x) => x !== first);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return first != null ? [first, ...rest] : rest;
}
function onEnded(e) { if (e === P.cur && !P.fading) P.next(true); }

// Revisa cada 250 ms (también con la pantalla apagada) si toca empezar la mezcla con la siguiente
setInterval(() => {
  const c = P.cur; if (!c || c.audio.paused || P.fading || S.xfade <= 0) return;
  const d = c.audio.duration; if (!d || !isFinite(d)) return;
  if (d - c.audio.currentTime <= S.xfade + 0.2 && d > S.xfade * 2.2 && P.nextIdx(true) >= 0) P.next(true);
}, 250);

/* ---------------- Pantalla encendida y controles del sistema ---------------- */
let wake = null;
async function updateWakeLock() {
  try {
    if (P.playing() && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    else if (!P.playing() && wake) { await wake.release(); wake = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateWakeLock(); });
function setMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const s = P.song; if (!s) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.artist || 'CEM DJ', artwork: [{ src: new URL(artUrl(s), location.href).href, sizes: '512x512' }] });
    navigator.mediaSession.setActionHandler('play', () => { if (P.cur.audio.paused) P.toggle(); });
    navigator.mediaSession.setActionHandler('pause', () => { if (!P.cur.audio.paused) P.toggle(); });
    navigator.mediaSession.setActionHandler('previoustrack', () => P.prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => P.next(false));
    navigator.mediaSession.setActionHandler('seekto', (d) => { if (d.seekTime != null) P.cur.audio.currentTime = d.seekTime; });
  } catch {}
}

/* ---------------- Análisis (duración y volumen) ---------------- */
function probeDuration(blob) {
  return new Promise((res) => {
    const a = new Audio(), u = URL.createObjectURL(blob);
    const done = (v) => { URL.revokeObjectURL(u); res(v); };
    a.preload = 'metadata'; a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0); a.onerror = () => done(0);
    setTimeout(() => done(0), 8000); a.src = u;
  });
}
const analysisQueue = []; let analyzing = false;
function analyzeSoon(song) { if (!song.analyzed && !analysisQueue.includes(song)) { analysisQueue.push(song); pumpAnalysis(); } }
async function pumpAnalysis() {
  if (analyzing) return; analyzing = true;
  while (analysisQueue.length) {
    const s = analysisQueue.shift();
    try { await analyzeSong(s); } catch {}
    s.analyzed = true;
    DB.put(dbRecord(s)).catch(() => {});
    engines.forEach((e) => { if (e.song === s) e.applyNorm(); });
    renderAll();
    await new Promise((r) => setTimeout(r, 30));
  }
  analyzing = false;
}
async function analyzeSong(s) {
  if (!s.dur) s.dur = await probeDuration(s.blob);
  if (!s.dur || s.dur > 20 * 60) return; // muy largas: se reproducen sin nivelar
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Off(1, 1, 22050); // 22 kHz: gasta menos memoria y alcanza para medir el volumen
  const buf = await ctx.decodeAudioData(await s.blob.arrayBuffer());
  const m = measureLoudness(buf);
  if (m) { s.lufs = m.lufs; s.peak = m.peak; }
}
const dbRecord = (s) => ({ id: s.id, blob: s.blob, name: s.name, size: s.size, title: s.title, artist: s.artist, cover: s.cover || null, dur: s.dur || 0, lufs: s.lufs ?? null, peak: s.peak || 0, analyzed: !!s.analyzed });

/* ---------------- Agregar canciones ---------------- */
const addTarget = () => (currentView === 'lists' && openList ? openList : null);
$('#addBtn').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const target = addTarget();
  let added = 0, dup = 0;
  for (const f of files) {
    if (f.type && !f.type.startsWith('audio/') && !/\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(f.name)) continue;
    let s = [...songs.values()].find((x) => x.name === f.name && x.size === f.size);
    if (s) { dup++; if (target) addToList(target, s.id, true); continue; }
    const tags = await readTags(f);
    const base = f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    s = { id: uid(), blob: f, name: f.name, size: f.size, title: tags.title || base, artist: tags.artist || '', cover: tags.cover || null, dur: 0, analyzed: false };
    songs.set(s.id, s); added++;
    try { await DB.put(dbRecord(s)); } catch { toast('No hay espacio para guardar «' + s.title + '». Se podrá usar solo en esta sesión.', 4500); }
    if (target) addToList(target, s.id, true);
    analyzeSoon(s);
  }
  renderAll();
  toast(added ? `${added} canción(es) agregada(s)` + (dup ? ` · ${dup} ya estaban` : '') : dup ? 'Esas canciones ya estaban agregadas.' : 'No se encontraron archivos de audio.');
};

/* ---------------- Hojas (menús y preguntas) ---------------- */
const sheet = $('#sheet');
function openSheet({ title, text, input, buttons }) {
  return new Promise((resolve) => {
    $('#sheetTitle').textContent = title;
    const tx = $('#sheetText'); tx.hidden = !text; tx.textContent = text || '';
    const inp = $('#sheetInput'); inp.hidden = input == null; inp.value = ''; inp.placeholder = input || '';
    const box = $('#sheetBtns'); box.innerHTML = '';
    let result = null;
    for (const b of buttons) {
      const el = document.createElement('button'); el.className = 'pill' + (b.primary ? ' on' : ''); el.textContent = b.label;
      el.onclick = () => { result = { value: b.value, text: inp.value.trim() }; sheet.close(); };
      box.appendChild(el);
    }
    sheet.onclose = () => resolve(result);
    sheet.showModal();
    if (input != null) setTimeout(() => inp.focus(), 50);
  });
}
const askNewList = async () => {
  const r = await openSheet({ title: 'Nueva lista', input: 'Nombre de la lista', buttons: [{ label: 'Crear', value: 'ok', primary: true }, { label: 'Cancelar', value: 'no' }] });
  if (!r || r.value !== 'ok' || !r.text) return null;
  const l = { id: uid(), name: r.text.slice(0, 40), ids: [] }; lists.push(l); saveLists(); return l;
};

/* ---------------- Listas ---------------- */
function addToList(listId, songId, quiet) {
  const l = lists.find((x) => x.id === listId); if (!l) return;
  if (l.ids.includes(songId)) { if (!quiet) toast('Esa canción ya está en «' + l.name + '».'); return; }
  l.ids.push(songId); saveLists(); if (!quiet) toast('Agregada a «' + l.name + '»');
}
async function chooseListFor(songId) {
  const btns = lists.map((l) => ({ label: l.name, value: l.id }));
  btns.push({ label: '＋ Nueva lista…', value: '__new', primary: true }, { label: 'Cancelar', value: '__no' });
  const r = await openSheet({ title: 'Agregar a una lista', buttons: btns });
  if (!r || r.value === '__no') return;
  let id = r.value;
  if (id === '__new') { const l = await askNewList(); if (!l) return; id = l.id; }
  addToList(id, songId); renderAll();
}
async function songMenu(s, ctxList) {
  const buttons = [{ label: 'Reproducir a continuación', value: 'next', primary: true }, { label: 'Agregar a una lista…', value: 'list' }];
  if (ctxList) buttons.push({ label: 'Quitar de «' + ctxList.name + '»', value: 'rm' });
  buttons.push({ label: 'Eliminar de la biblioteca', value: 'del' }, { label: 'Cancelar', value: 'no' });
  const r = await openSheet({ title: s.title, text: s.artist || '', buttons });
  if (!r) return;
  if (r.value === 'next') { if (P.insertNext(s.id)) toast('Sonará a continuación'); else P.start([s.id], 0); }
  else if (r.value === 'list') chooseListFor(s.id);
  else if (r.value === 'rm') { ctxList.ids = ctxList.ids.filter((i) => i !== s.id); saveLists(); renderAll(); }
  else if (r.value === 'del') {
    const c = await openSheet({ title: '¿Eliminar «' + s.title + '»?', text: 'Se borra de la biblioteca y de todas las listas, solo en este equipo. El archivo original no se toca.', buttons: [{ label: 'Eliminar', value: 'yes', primary: true }, { label: 'Cancelar', value: 'no' }] });
    if (c && c.value === 'yes') {
      if (P.song === s) P.stopAll();
      P.queue = P.queue.filter((i) => i !== s.id);
      songs.delete(s.id); lists.forEach((l) => { l.ids = l.ids.filter((i) => i !== s.id); }); saveLists();
      if (arts.has(s.id)) { URL.revokeObjectURL(arts.get(s.id)); arts.delete(s.id); }
      DB.del(s.id).catch(() => {}); renderAll();
    }
  }
}

/* ---------------- Pintar pantallas ---------------- */
const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
let currentView = 'songs';

function songRow(s, ids, list) {
  const row = document.createElement('div'); row.className = 'row'; row.dataset.id = s.id;
  row.innerHTML = `<img class="th" alt="" loading="lazy"><div class="tx"><div class="nm"></div><div class="sub"></div></div><div class="du"></div>
    ${list ? '<button class="ibtn" data-a="up" aria-label="Subir">▲</button><button class="ibtn" data-a="dn" aria-label="Bajar">▼</button>' : ''}
    <button class="ibtn" data-a="more" aria-label="Más opciones">${ICON.more}</button>`;
  row.querySelector('.th').src = artUrl(s);
  row.querySelector('.nm').textContent = s.title; row.querySelector('.sub').textContent = s.artist || 'Artista desconocido';
  row.querySelector('.du').textContent = s.dur ? fmt(s.dur) : '';
  row.onclick = (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return P.start(ids, ids.indexOf(s.id));
    const a = b.dataset.a;
    if (a === 'more') songMenu(s, list);
    else if (list) { const j = list.ids.indexOf(s.id), k = a === 'up' ? j - 1 : j + 1; if (k >= 0 && k < list.ids.length) { [list.ids[j], list.ids[k]] = [list.ids[k], list.ids[j]]; saveLists(); renderLists(); } }
  };
  return row;
}
function playIds(ids, shuffle) {
  if (!ids.length) return;
  const was = S.shuffle; S.shuffle = shuffle;
  P.start(ids, shuffle ? Math.floor(Math.random() * ids.length) : 0);
  syncModes();
  if (!shuffle) { S.shuffle = was; syncModes(); }
}
function renderSongs() {
  const q = norm($('#search').value.trim());
  let arr = [...songs.values()].sort((a, b) => a.title.localeCompare(b.title, 'es'));
  if (q) arr = arr.filter((s) => norm(s.title + ' ' + s.artist).includes(q));
  const box = $('#songList'); box.innerHTML = '';
  $('#songActions').hidden = !arr.length;
  if (!arr.length) {
    box.innerHTML = songs.size ? '<div class="empty">No hay resultados.</div>' : '<div class="empty">Aquí aparecerá la música de este equipo.<br><button class="pill on" id="emptyAdd">Agregar canciones</button></div>';
    const b = $('#emptyAdd'); if (b) b.onclick = () => $('#fileIn').click();
  }
  const ids = arr.map((s) => s.id);
  arr.forEach((s) => box.appendChild(songRow(s, ids, null)));
  $('#libNote').textContent = songs.size ? `${songs.size} canciones guardadas en este equipo` : '';
  $('#playAll').onclick = () => playIds(ids, false);
  $('#shuffleAll').onclick = () => playIds(ids, true);
}
function renderLists() {
  if (openList && !lists.some((l) => l.id === openList)) openList = null;
  $('#listsHome').hidden = !!openList; $('#listDetail').hidden = !openList;
  if (!openList) {
    const box = $('#listCards'); box.innerHTML = '';
    if (!lists.length) box.innerHTML = '<div class="empty">Todavía no hay listas. Crea una para ordenar la música del culto.</div>';
    lists.forEach((l) => {
      const n = l.ids.filter((i) => songs.has(i)).length;
      const first = songs.get(l.ids.find((i) => songs.has(i)));
      const b = document.createElement('button'); b.className = 'card-row';
      b.innerHTML = '<img class="th" alt=""><div class="tx"><div class="nm"></div><div class="sub"></div></div>';
      b.querySelector('.th').src = artUrl(first); b.querySelector('.nm').textContent = l.name; b.querySelector('.sub').textContent = n + (n === 1 ? ' canción' : ' canciones');
      b.onclick = () => { openList = l.id; renderLists(); window.scrollTo(0, 0); };
      box.appendChild(b);
    });
    return;
  }
  const l = lists.find((x) => x.id === openList);
  $('#listName').textContent = l.name;
  const arr = l.ids.map((i) => songs.get(i)).filter(Boolean), ids = arr.map((s) => s.id);
  const box = $('#listSongs'); box.innerHTML = '';
  if (!arr.length) box.innerHTML = '<div class="empty">Esta lista está vacía.<br>Toca ⋯ en una canción de «Canciones» para agregarla, o usa ＋ arriba para elegir archivos nuevos.</div>';
  arr.forEach((s) => box.appendChild(songRow(s, ids, l)));
  $('#listPlay').onclick = () => playIds(ids, false);
  $('#listShuffle').onclick = () => playIds(ids, true);
  $('#listMore').onclick = async () => {
    const r = await openSheet({ title: l.name, buttons: [{ label: 'Cambiar nombre', value: 'ren', primary: true }, { label: 'Eliminar lista', value: 'del' }, { label: 'Cancelar', value: 'no' }] });
    if (!r) return;
    if (r.value === 'ren') {
      const n = await openSheet({ title: 'Nuevo nombre', input: l.name, buttons: [{ label: 'Guardar', value: 'ok', primary: true }, { label: 'Cancelar', value: 'no' }] });
      if (n && n.value === 'ok' && n.text) { l.name = n.text.slice(0, 40); saveLists(); renderLists(); }
    } else if (r.value === 'del') {
      const c = await openSheet({ title: '¿Eliminar la lista «' + l.name + '»?', text: 'Las canciones no se borran de la biblioteca.', buttons: [{ label: 'Eliminar lista', value: 'yes', primary: true }, { label: 'Cancelar', value: 'no' }] });
      if (c && c.value === 'yes') { lists = lists.filter((x) => x.id !== l.id); saveLists(); openList = null; renderLists(); }
    }
  };
  markCurrent();
}
function markCurrent() {
  const id = P.song && P.song.id;
  $$('.row[data-id]').forEach((r) => r.classList.toggle('cur', r.dataset.id === id));
}
function renderSettings() {
  const total = [...songs.values()].reduce((n, s) => n + s.size, 0);
  $('#storeNote').textContent = songs.size ? `${songs.size} canciones · ${(total / 1048576).toFixed(0)} MB guardados en este equipo` : '';
}
function renderAll() { renderSongs(); renderLists(); renderSettings(); markCurrent(); }
$('#search').oninput = renderSongs;
$('#newList').onclick = async () => { const l = await askNewList(); if (l) { openList = l.id; renderLists(); } };
$('#listBack').onclick = () => { openList = null; renderLists(); };

/* ---------------- Navegación ---------------- */
function showView(v) {
  currentView = v;
  $$('.view').forEach((x) => { x.hidden = x.id !== 'v-' + v; });
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  $('#addBtn').hidden = v === 'settings';
  window.scrollTo(0, 0);
}
$$('#tabs button').forEach((b) => { b.onclick = () => { if (b.dataset.v === 'lists' && currentView === 'lists') { openList = null; renderLists(); } showView(b.dataset.v); }; });

/* ---------------- Mini reproductor y "Reproduciendo" ---------------- */
const np = $('#np');
function openNp() { if (!P.song) return; np.classList.add('open'); np.setAttribute('aria-hidden', 'false'); try { history.pushState({ np: 1 }, ''); } catch {} }
function closeNp(fromPop) { if (!np.classList.contains('open')) return; np.classList.remove('open'); np.setAttribute('aria-hidden', 'true'); if (!fromPop) { try { if (history.state && history.state.np) history.back(); } catch {} } }
window.addEventListener('popstate', () => closeNp(true));
$('#miniMain').onclick = openNp;
$('#npClose').onclick = () => closeNp();
$('#miniPlay').onclick = () => P.toggle();
$('#miniNext').onclick = () => P.next(false);
$('#npPlay').onclick = () => P.toggle();
$('#npNext').onclick = () => P.next(false);
$('#npPrev').onclick = () => P.prev();
$('#npMore').onclick = () => { if (P.song) songMenu(P.song, null); };

function onPlayState() {
  const playing = P.playing();
  $('#miniPlay').innerHTML = playing ? ICON.pause : ICON.play;
  $('#npPlay').innerHTML = playing ? ICON.pause : ICON.play;
  if (playing) setMediaSession();
  updateWakeLock();
}
function onSongChange() {
  const s = P.song;
  $('#mini').hidden = !s;
  if (!s) return;
  $('#miniTitle').textContent = s.title; $('#miniArtist').textContent = s.artist || 'Artista desconocido';
  $('#miniArt').src = artUrl(s); $('#npArt').src = artUrl(s);
  $('#npTitle').textContent = s.title; $('#npArtist').textContent = s.artist || 'Artista desconocido';
  $('#npDur').textContent = fmt(s.dur || (P.cur && P.cur.audio.duration));
  markCurrent(); onPlayState(); setMediaSession();
  if (!s.analyzed) analyzeSoon(s);
}
let seeking = false;
const seek = $('#npSeek');
seek.addEventListener('pointerdown', () => { seeking = true; });
seek.addEventListener('pointerup', () => { seeking = false; });
seek.addEventListener('change', () => { seeking = false; });
seek.oninput = () => P.seekFrac(seek.value / 1000);
(function loop() {
  const a = P.cur && P.cur.audio;
  if (a && P.song) {
    const d = a.duration;
    if (d && isFinite(d)) {
      if (!seeking) seek.value = (a.currentTime / d) * 1000;
      $('#miniProg').style.width = (a.currentTime / d) * 100 + '%';
      $('#npDur').textContent = fmt(d);
    }
    $('#npTime').textContent = fmt(a.currentTime);
  }
  requestAnimationFrame(loop);
})();

/* ---------------- Aleatorio, repetir, voz, mezcla, EQ ---------------- */
function syncModes() {
  $('#npShuffle').classList.toggle('on', S.shuffle);
  $('#npRepeat').classList.toggle('on', S.repeat !== 'off');
  $('#npRepeat').innerHTML = ICON.repeat + (S.repeat === 'one' ? '<span class="one">1</span>' : '');
  $('#npVoice').classList.toggle('on', S.novoice);
  $('#npMix').textContent = S.xfade > 0 ? 'Mezcla: ' + S.xfade + ' s' : 'Mezcla: no';
  $('#npMix').classList.toggle('on', S.xfade > 0);
  $('#xfadeSel').value = String(S.xfade);
  $('#levelChk').checked = S.level; $('#novoiceChk').checked = S.novoice;
  $$('[data-band]').forEach((r) => { r.value = S.eq[r.dataset.band]; });
  $('#vol').value = S.vol;
  saveS();
}
$('#npShuffle').onclick = () => {
  S.shuffle = !S.shuffle;
  if (P.queue.length) { const cur = P.queue[P.idx]; if (S.shuffle) { P.queue = shuffled(P.base, cur); P.idx = 0; } else { P.queue = P.base.slice(); P.idx = Math.max(0, P.queue.indexOf(cur)); } }
  syncModes(); toast(S.shuffle ? 'Aleatorio activado' : 'Aleatorio desactivado', 1500);
};
$('#npRepeat').onclick = () => { S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off'; syncModes(); toast(S.repeat === 'off' ? 'Sin repetir' : S.repeat === 'all' ? 'Repetir toda la lista' : 'Repetir esta canción', 1500); };
function setNoVoice(on, notify) { S.novoice = on; engines.forEach((e) => e.applyFx()); syncModes(); if (on && notify) toast('«Sin voz» rápido: quita lo que está al centro. Funciona mejor en unas canciones que en otras.', 3800); }
$('#npVoice').onclick = () => setNoVoice(!S.novoice, true);
$('#novoiceChk').onchange = (e) => setNoVoice(e.target.checked, true);
$('#npMix').onclick = () => { const o = [0, 3, 6, 10, 15]; S.xfade = o[(o.indexOf(S.xfade) + 1) % o.length]; syncModes(); };
$('#xfadeSel').onchange = (e) => { S.xfade = +e.target.value; syncModes(); };
$('#levelChk').onchange = (e) => { S.level = e.target.checked; engines.forEach((x) => x.applyNorm()); syncModes(); };
$('#npEq').onclick = (e) => { const b = $('#npEqBox'); b.hidden = !b.hidden; e.currentTarget.classList.toggle('on', !b.hidden); };
$$('[data-band]').forEach((r) => {
  r.oninput = () => { S.eq[r.dataset.band] = +r.value; engines.forEach((e) => e.applyFx()); $$(`[data-band="${r.dataset.band}"]`).forEach((o) => { o.value = r.value; }); saveS(); };
  r.ondblclick = () => { r.value = 0; r.oninput(); };
});
$('#vol').oninput = (e) => { S.vol = +e.target.value; if (master) master.gain.value = S.vol / 100; saveS(); };

/* ---------------- Tema, instalación y arranque ---------------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('cem.theme', t); } catch {}
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = t === 'dark' ? '#1a1710' : '#f8f1de';
  $('#darkChk').checked = t === 'dark';
}
$('#darkChk').onchange = (e) => applyTheme(e.target.checked ? 'dark' : 'light');
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
$('#installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#installBtn').hidden = true; };
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });

function paintIcons() {
  $('#addBtn').innerHTML = ICON.plus;
  $('#playAll').innerHTML = ICON.play + ' Reproducir'; $('#shuffleAll').innerHTML = ICON.shuffle + ' Aleatorio';
  $('#newList').innerHTML = ICON.plus + ' Nueva lista';
  $('#listBack').innerHTML = ICON.back;
  $('#listPlay').innerHTML = ICON.play + ' Reproducir'; $('#listShuffle').innerHTML = ICON.shuffle + ' Aleatorio'; $('#listMore').innerHTML = ICON.more;
  $('#miniPlay').innerHTML = ICON.play; $('#miniNext').innerHTML = ICON.next;
  $$('#tabs button').forEach((b) => { b.querySelector('span').innerHTML = ICON[b.dataset.v]; });
  $('#npClose').innerHTML = ICON.down; $('#npMore').innerHTML = ICON.more;
  $('#npShuffle').innerHTML = ICON.shuffle; $('#npPrev').innerHTML = ICON.prev; $('#npPlay').innerHTML = ICON.play; $('#npNext').innerHTML = ICON.next;
  $('#volIcon').innerHTML = ICON.vol;
  $('#npArt').src = ICON.logo; $('#miniArt').src = ICON.logo;
}

(async function start() {
  paintIcons(); applyTheme(document.documentElement.dataset.theme); syncModes();
  try {
    for (const r of await DB.all()) songs.set(r.id, r);
  } catch { toast('Este navegador no permite guardar canciones; solo funcionarán durante esta sesión.', 5000); }
  renderAll();
  songs.forEach((s) => { if (!s.analyzed) analyzeSoon(s); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
