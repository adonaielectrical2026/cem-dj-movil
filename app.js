'use strict';
/* ============================================================
   CEM DJ móvil: versión sencilla para celular y tablet.
   2 decks, crossfader con mezcla automática, EQ, nivelación de volumen (LUFS), BPM + SYNC,
   "sin voz" rápido, biblioteca y listas guardadas en el propio equipo (IndexedDB).
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
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

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zM9.5 12 18 6v12z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zM11 20h2v3h-2zM1 11h3v2H1zM20 11h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zM16.3 17.7l1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z"/></svg>',
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
  i += 2; // fin del tipo MIME + tipo de imagen
  if (enc === 0 || enc === 3) { while (i < b.length && b[i] !== 0) i++; i++; }
  else { while (i + 1 < b.length && !(b[i] === 0 && b[i + 1] === 0)) i += 2; i += 2; }
  const data = b.subarray(i);
  if (data.length < 100) return null;
  const type = /^image\/(png|jpe?g|webp|gif)$/.test(mime) ? mime : data[0] === 0x89 ? 'image/png' : 'image/jpeg';
  return new Blob([data], { type });
}

/* ---------------- Audio: grafo general ---------------- */
let AC = null, master, limiter;
function ensureAudio() {
  if (AC) return AC;
  AC = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  master = AC.createGain(); master.gain.value = (+$('#master').value) / 100;
  limiter = AC.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.1;
  master.connect(limiter).connect(AC.destination);
  decks.forEach((d) => d.build());
  applyXfade();
  return AC;
}

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

/* ---------------- Biblioteca (estado) ---------------- */
const songs = new Map();          // id -> canción
let lists = store.get('cem.lists', []); // [{id,name,ids:[]}]
let view = 'all';                 // 'all' o id de lista
const saveLists = () => store.set('cem.lists', lists);

/* ---------------- Deck ---------------- */
class Deck {
  constructor(k, idx) {
    this.k = k; this.idx = idx; this.el = $('#deck' + k);
    this.audio = new Audio(); this.audio.preload = 'auto';
    this.song = null; this.url = null; this.coverUrl = null;
    this.queue = null; this.qi = -1; this.seeking = false; this.synced = false; this.noVoice = false;
    this.el.innerHTML = `
      <div class="deck-top">
        <div class="disc"><div class="disc-art"></div></div>
        <div class="deck-info">
          <span class="tag">DECK ${k}</span>
          <div class="title">Elige una canción</div>
          <div class="artist"></div>
          <div class="meta"><span class="time">0:00</span><span>/ <span class="dur">–:––</span></span><span class="bpm badge"></span></div>
        </div>
      </div>
      <input class="seek" type="range" min="0" max="1000" value="0" aria-label="Posición">
      <div class="ctl">
        <button class="btn restart" aria-label="Volver al inicio">${ICON.restart}</button>
        <button class="btn play" aria-label="Reproducir o pausar">${ICON.play}</button>
        <button class="btn sync">SYNC</button>
        <button class="btn novoz">Sin voz</button>
        <button class="btn eqbtn">EQ</button>
      </div>
      <div class="vol"><span>Vol</span><input class="volr" type="range" min="0" max="100" value="100" aria-label="Volumen del deck ${k}"></div>
      <div class="eq" hidden>
        <label>Graves<input type="range" min="-12" max="12" step="0.5" value="0" data-band="low"></label>
        <label>Medios<input type="range" min="-12" max="12" step="0.5" value="0" data-band="mid"></label>
        <label>Agudos<input type="range" min="-12" max="12" step="0.5" value="0" data-band="high"></label>
      </div>`;
    const q = (s) => this.el.querySelector(s);
    this.ui = { art: q('.disc-art'), title: q('.title'), artist: q('.artist'), time: q('.time'), dur: q('.dur'), bpm: q('.bpm'), seek: q('.seek'), play: q('.play'), sync: q('.sync'), novoz: q('.novoz'), eq: q('.eq') };
    this.ui.art.style.backgroundImage = 'url(logo.jpg)';
    this.ui.play.onclick = () => this.toggle();
    q('.restart').onclick = () => { if (this.song) this.audio.currentTime = 0; };
    this.ui.sync.onclick = () => this.sync();
    this.ui.novoz.onclick = () => this.setNoVoice(!this.noVoice);
    q('.eqbtn').onclick = (e) => { this.ui.eq.hidden = !this.ui.eq.hidden; e.currentTarget.classList.toggle('on', !this.ui.eq.hidden); };
    q('.volr').oninput = (e) => { if (this.fader) this.fader.gain.value = e.target.value / 100; };
    this.el.querySelectorAll('[data-band]').forEach((r) => {
      r.oninput = () => { if (this[r.dataset.band]) this[r.dataset.band].gain.value = +r.value; };
      r.ondblclick = () => { r.value = 0; r.oninput(); };
    });
    const s = this.ui.seek;
    s.addEventListener('pointerdown', () => { this.seeking = true; });
    s.addEventListener('pointerup', () => { this.seeking = false; });
    s.oninput = () => { if (this.audio.duration) this.audio.currentTime = (s.value / 1000) * this.audio.duration; };
    this.audio.addEventListener('play', () => this.onState());
    this.audio.addEventListener('pause', () => this.onState());
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('loadedmetadata', () => { this.ui.dur.textContent = fmt(this.audio.duration); });
    this.audio.addEventListener('error', () => { if (this.song) toast('No se pudo reproducir «' + this.song.title + '». Prueba con otro formato (MP3 o M4A).', 4500); });
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
    this.fader = c.createGain(); this.fader.gain.value = this.el.querySelector('.volr').value / 100;
    this.xf = c.createGain();
    sum.connect(this.low).connect(this.mid).connect(this.high).connect(this.fader).connect(this.xf).connect(master);
    this.el.querySelectorAll('[data-band]').forEach((r) => { this[r.dataset.band].gain.value = +r.value; });
    this.setNoVoice(this.noVoice, true);
    this.applyNorm();
  }

  load(song, queue = null, qi = -1, autoplay = false) {
    ensureAudio();
    if (this.url) URL.revokeObjectURL(this.url);
    if (this.coverUrl) URL.revokeObjectURL(this.coverUrl);
    this.audio.pause();
    this.song = song; this.queue = queue; this.qi = qi;
    this.url = URL.createObjectURL(song.blob);
    this.audio.src = this.url; this.audio.load();
    this.audio.playbackRate = 1; this.synced = false; this.ui.sync.classList.remove('on');
    this.coverUrl = song.cover ? URL.createObjectURL(song.cover) : null;
    this.ui.art.style.backgroundImage = `url(${this.coverUrl || 'logo.jpg'})`;
    this.ui.title.textContent = song.title;
    this.ui.artist.textContent = song.artist || '';
    this.ui.dur.textContent = fmt(song.dur); this.ui.time.textContent = '0:00'; this.ui.seek.value = 0;
    this.showBpm();
    this.applyNorm();
    this.onState();
    renderLib();
    if (autoplay) this.play();
    else if (!song.analyzed) analyzeSoon(song);
  }

  showBpm() {
    const s = this.song; const r = this.audio.playbackRate;
    this.ui.bpm.textContent = s && s.bpm ? Math.round(s.bpm * r) + ' BPM' + (Math.abs(r - 1) > 0.002 ? ` (${r > 1 ? '+' : ''}${((r - 1) * 100).toFixed(1)}%)` : '') : (s && !s.analyzed ? 'analizando…' : '');
  }

  applyNorm() {
    if (!this.norm) return;
    const s = this.song; let g = 1;
    if (s && $('#autoLevel').checked && s.lufs != null) {
      let db = Math.max(-12, Math.min(9, -14 - s.lufs));
      if (s.peak > 0) db = Math.min(db, -20 * Math.log10(s.peak) - 0.5); // que no se pase de 0 dB
      g = Math.pow(10, db / 20);
    }
    this.norm.gain.setTargetAtTime(g, AC.currentTime, 0.05);
  }

  async play() {
    if (!this.song) return toast('Elige una canción para el deck ' + this.k);
    ensureAudio();
    if (AC.state !== 'running') await AC.resume();
    try { await this.audio.play(); } catch {}
  }
  pause() { this.audio.pause(); }
  toggle() { if (this.audio.paused) this.play(); else this.pause(); }

  onState() {
    const playing = !!this.song && !this.audio.paused;
    this.el.classList.toggle('playing', playing);
    this.ui.play.innerHTML = playing ? ICON.pause : ICON.play;
    if (playing) { lastDeck = this; setMediaSession(this); }
    updateWakeLock();
  }

  onEnded() {
    this.onState();
    if (!$('#autoNext').checked || !this.queue) return;
    const next = this.queue[this.qi + 1]; const s = next && songs.get(next);
    if (s) this.load(s, this.queue, this.qi + 1, true);
  }

  sync() {
    const o = decks[1 - this.idx];
    if (this.synced) { this.audio.playbackRate = 1; this.synced = false; this.ui.sync.classList.remove('on'); this.showBpm(); return; }
    if (!this.song || !o.song) return toast('Carga una canción en cada deck para sincronizar.');
    if (!this.song.bpm || !o.song.bpm) return toast('Todavía no se detectó el BPM de las dos canciones.');
    const target = o.song.bpm * o.audio.playbackRate;
    const base = target / this.song.bpm;
    const r = [base, base / 2, base * 2].sort((a, b) => Math.abs(Math.log(a)) - Math.abs(Math.log(b)))[0];
    if (r < 0.8 || r > 1.25) return toast('Los tempos son muy distintos para sincronizar.');
    this.audio.playbackRate = r; this.synced = true; this.ui.sync.classList.add('on'); this.showBpm();
  }

  setNoVoice(on, silent) {
    this.noVoice = on; this.ui.novoz.classList.toggle('on', on);
    if (!this.kar) return;
    const t = AC.currentTime;
    this.kar.dry.gain.setTargetAtTime(on ? 0 : 1, t, 0.04);
    this.kar.wet.gain.setTargetAtTime(on ? 1 : 0, t, 0.04);
    if (on && !silent) toast('«Sin voz» rápido: quita lo que está al centro. Funciona mejor en unas canciones que en otras.', 3500);
  }

  tick() {
    const a = this.audio, d = a.duration;
    this.ui.time.textContent = fmt(a.currentTime);
    if (d && isFinite(d)) {
      if (!this.seeking) this.ui.seek.value = (a.currentTime / d) * 1000;
      this.el.classList.toggle('ending', !a.paused && d - a.currentTime < 10);
    }
  }
}

const decks = [new Deck('A', 0), new Deck('B', 1)];
let lastDeck = decks[0];

/* ---------------- Mezclador ---------------- */
let xf = 0, mixRaf = 0;
function applyXfade() {
  const a = Math.cos((xf * Math.PI) / 2), b = Math.sin((xf * Math.PI) / 2);
  if (decks[0].xf) { decks[0].xf.gain.setTargetAtTime(a, AC.currentTime, 0.01); decks[1].xf.gain.setTargetAtTime(b, AC.currentTime, 0.01); }
  $('#mixBtn').textContent = xf < 0.5 ? 'Mezclar A → B' : 'Mezclar B → A';
}
function setXf(v) { xf = Math.max(0, Math.min(1, v)); $('#xfade').value = Math.round(xf * 1000); applyXfade(); }
$('#xfade').oninput = (e) => { cancelAnimationFrame(mixRaf); setXf(e.target.value / 1000); };
$('#master').oninput = (e) => { if (master) master.gain.value = e.target.value / 100; store.set('cem.master', +e.target.value); };
$('#mixBtn').onclick = () => {
  ensureAudio(); cancelAnimationFrame(mixRaf);
  const to = xf < 0.5 ? 1 : 0, dTo = decks[to], dFrom = decks[1 - to];
  if (!dTo.song) return toast('Carga una canción en el deck ' + dTo.k + ' primero.');
  if (dTo.audio.paused) dTo.play();
  const secs = +$('#mixSecs').value, t0 = performance.now(), x0 = xf;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / (secs * 1000));
    setXf(x0 + (to - x0) * k);
    if (k < 1) mixRaf = requestAnimationFrame(step); else dFrom.pause();
  };
  mixRaf = requestAnimationFrame(step);
};
$('#autoLevel').onchange = (e) => { store.set('cem.autoLevel', e.target.checked); decks.forEach((d) => d.applyNorm()); };
$('#autoNext').onchange = (e) => store.set('cem.autoNext', e.target.checked);
$('#autoLevel').checked = store.get('cem.autoLevel', true);
$('#autoNext').checked = store.get('cem.autoNext', true);
$('#master').value = store.get('cem.master', 90);

(function loop() { decks.forEach((d) => d.tick()); requestAnimationFrame(loop); })();

/* ---------------- Pantalla encendida y controles del sistema ---------------- */
let wake = null;
async function updateWakeLock() {
  const any = decks.some((d) => d.song && !d.audio.paused);
  try {
    if (any && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    else if (!any && wake) { await wake.release(); wake = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateWakeLock(); });
function setMediaSession(d) {
  if (!('mediaSession' in navigator) || !d.song) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: d.song.title, artist: d.song.artist || 'CEM DJ', artwork: [{ src: d.coverUrl || new URL('icon-512.png', location.href).href, sizes: '512x512' }] });
    navigator.mediaSession.setActionHandler('play', () => lastDeck.play());
    navigator.mediaSession.setActionHandler('pause', () => lastDeck.pause());
  } catch {}
}

/* ---------------- Análisis (duración, volumen, BPM) ---------------- */
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
    decks.forEach((d) => { if (d.song === s) { d.applyNorm(); d.showBpm(); d.ui.dur.textContent = fmt(s.dur || d.audio.duration); } });
    renderLib();
    await new Promise((r) => setTimeout(r, 30));
  }
  analyzing = false;
}
async function analyzeSong(s) {
  if (!s.dur) s.dur = await probeDuration(s.blob);
  if (!s.dur || s.dur > 20 * 60) return; // muy largas: se reproducen sin analizar
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Off(1, 1, 22050); // 22 kHz: gasta menos memoria y alcanza para volumen y ritmo
  const buf = await ctx.decodeAudioData(await s.blob.arrayBuffer());
  const m = measureLoudness(buf);
  if (m) { s.lufs = m.lufs; s.peak = m.peak; }
  const on = computeOnset(buf);
  const r = on ? bpmFromOnset(on) : null;
  if (r && r.bpm > 0) s.bpm = r.bpm;
}
const dbRecord = (s) => ({ id: s.id, blob: s.blob, name: s.name, size: s.size, title: s.title, artist: s.artist, cover: s.cover || null, dur: s.dur || 0, bpm: s.bpm || 0, lufs: s.lufs ?? null, peak: s.peak || 0, analyzed: !!s.analyzed });

/* ---------------- Agregar canciones ---------------- */
$('#addBtn').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  let added = 0, dup = 0;
  for (const f of files) {
    if (f.type && !f.type.startsWith('audio/') && !/\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(f.name)) continue;
    if ([...songs.values()].some((s) => s.name === f.name && s.size === f.size)) { dup++; continue; }
    const tags = await readTags(f);
    const base = f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    const s = { id: uid(), blob: f, name: f.name, size: f.size, title: tags.title || base, artist: tags.artist || '', cover: tags.cover || null, dur: 0, analyzed: false };
    songs.set(s.id, s); added++;
    try { await DB.put(dbRecord(s)); } catch { toast('No hay espacio para guardar «' + s.title + '». Se podrá usar solo en esta sesión.', 4500); }
    if (view !== 'all' && view) addToList(view, s.id, true);
    analyzeSoon(s);
  }
  renderLib();
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
      const el = document.createElement('button'); el.className = 'btn' + (b.primary ? ' on' : ''); el.textContent = b.label;
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
  addToList(id, songId); renderLib();
}
async function songMenu(s) {
  const inList = view !== 'all' ? lists.find((l) => l.id === view) : null;
  const buttons = [{ label: 'Agregar a una lista…', value: 'list', primary: true }];
  if (inList) buttons.push({ label: 'Quitar de «' + inList.name + '»', value: 'rm' });
  buttons.push({ label: 'Eliminar de la biblioteca', value: 'del' }, { label: 'Cancelar', value: 'no' });
  const r = await openSheet({ title: s.title, text: s.artist || '', buttons });
  if (!r) return;
  if (r.value === 'list') chooseListFor(s.id);
  else if (r.value === 'rm') { inList.ids = inList.ids.filter((i) => i !== s.id); saveLists(); renderLib(); }
  else if (r.value === 'del') {
    const c = await openSheet({ title: '¿Eliminar «' + s.title + '»?', text: 'Se borra de la biblioteca y de todas las listas, solo en este equipo. El archivo original no se toca.', buttons: [{ label: 'Eliminar', value: 'yes', primary: true }, { label: 'Cancelar', value: 'no' }] });
    if (c && c.value === 'yes') {
      decks.forEach((d) => { if (d.song === s) { d.pause(); } });
      songs.delete(s.id); lists.forEach((l) => { l.ids = l.ids.filter((i) => i !== s.id); }); saveLists();
      DB.del(s.id).catch(() => {}); renderLib();
    }
  }
}

/* ---------------- Pintar la biblioteca ---------------- */
const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function currentSongs() {
  const q = norm($('#search').value.trim());
  let arr;
  if (view === 'all') arr = [...songs.values()].sort((a, b) => a.title.localeCompare(b.title, 'es'));
  else { const l = lists.find((x) => x.id === view); arr = l ? l.ids.map((i) => songs.get(i)).filter(Boolean) : []; }
  return q ? arr.filter((s) => norm(s.title + ' ' + s.artist).includes(q)) : arr;
}
function renderLib() {
  if (view !== 'all' && !lists.some((l) => l.id === view)) view = 'all';
  const chips = $('#chips'); chips.innerHTML = '';
  const mk = (label, id) => { const c = document.createElement('button'); c.className = 'chip' + (view === id ? ' on' : ''); c.textContent = label; c.onclick = () => { view = id; renderLib(); }; chips.appendChild(c); };
  mk('Todas', 'all'); lists.forEach((l) => mk(l.name + ' (' + l.ids.filter((i) => songs.has(i)).length + ')', l.id));
  const nl = document.createElement('button'); nl.className = 'chip'; nl.textContent = '＋ Lista'; nl.onclick = async () => { const l = await askNewList(); if (l) { view = l.id; renderLib(); } }; chips.appendChild(nl);

  const list = lists.find((l) => l.id === view);
  $('#libTitle').textContent = list ? list.name : 'Biblioteca';
  const arr = currentSongs(), rows = $('#rows'); rows.innerHTML = '';
  if (!arr.length) {
    rows.innerHTML = `<div class="empty">${songs.size ? (list && !$('#search').value ? 'Esta lista está vacía. Toca ⋯ en una canción de «Todas» para agregarla.' : 'No hay resultados.') : 'Toca «Agregar canciones» para elegir la música de este equipo.'}</div>`;
  }
  arr.forEach((s, i) => {
    const row = document.createElement('div'); row.className = 'row-s' + (decks.some((d) => d.song === s) ? ' cur' : '');
    const sub = [fmt(s.dur), s.bpm ? Math.round(s.bpm) + ' BPM' : (s.analyzed ? '' : 'analizando…'), s.artist].filter(Boolean).join(' · ');
    row.innerHTML = `<div class="tx"><div class="nm"></div><div class="sub"></div></div>
      <button class="btn" data-a="A">A</button><button class="btn" data-a="B">B</button>
      ${list ? '<button class="btn" data-a="up" aria-label="Subir">▲</button><button class="btn" data-a="dn" aria-label="Bajar">▼</button>' : ''}
      <button class="btn" data-a="more" aria-label="Más opciones">${ICON.more}</button>`;
    row.querySelector('.nm').textContent = s.title; row.querySelector('.sub').textContent = sub;
    row.querySelector('.tx').onclick = () => { const d = decks.find((x) => !x.song) || decks.find((x) => x.audio.paused) || decks[0]; loadFromView(d, s, arr); };
    row.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation(); const a = b.dataset.a;
        if (a === 'A' || a === 'B') loadFromView(decks[a === 'A' ? 0 : 1], s, arr);
        else if (a === 'more') songMenu(s);
        else if (list && !$('#search').value) { const j = list.ids.indexOf(s.id), k = a === 'up' ? j - 1 : j + 1; if (k >= 0 && k < list.ids.length) { [list.ids[j], list.ids[k]] = [list.ids[k], list.ids[j]]; saveLists(); renderLib(); } }
      };
    });
    rows.appendChild(row);
  });
  const total = [...songs.values()].reduce((n, s) => n + s.size, 0);
  $('#libNote').textContent = songs.size ? `${songs.size} canciones guardadas en este equipo · ${(total / 1048576).toFixed(0)} MB` : '';
  if (list && $('#search').value) $('#libNote').textContent += ' · (para reordenar, borra la búsqueda)';
}
function loadFromView(deck, s, arr) {
  const inList = view !== 'all';
  const ids = arr.map((x) => x.id);
  if (deck.song && !deck.audio.paused) {
    openSheet({ title: 'El deck ' + deck.k + ' está sonando', text: '¿Cambiar «' + deck.song.title + '» por «' + s.title + '»?', buttons: [{ label: 'Sí, cambiar', value: 'y', primary: true }, { label: 'Cancelar', value: 'n' }] })
      .then((r) => { if (r && r.value === 'y') deck.load(s, inList ? ids : null, ids.indexOf(s.id), false); });
    return;
  }
  deck.load(s, inList ? ids : null, ids.indexOf(s.id), false);
}
$('#search').oninput = renderLib;

/* ---------------- Tema, instalación y arranque ---------------- */
function paintTheme() { $('#themeBtn').innerHTML = document.documentElement.dataset.theme === 'dark' ? ICON.sun : ICON.moon; }
$('#themeBtn').onclick = () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t; try { localStorage.setItem('cem.theme', t); } catch {} paintTheme();
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = t === 'dark' ? '#1a1710' : '#f8f1de';
};
paintTheme();

let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
$('#installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#installBtn').hidden = true; };
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });

(async function start() {
  try {
    for (const r of await DB.all()) songs.set(r.id, { ...r, bpm: r.bpm || 0 });
  } catch { toast('Este navegador no permite guardar canciones; solo funcionarán durante esta sesión.', 5000); }
  renderLib();
  songs.forEach((s) => { if (!s.analyzed) analyzeSoon(s); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
