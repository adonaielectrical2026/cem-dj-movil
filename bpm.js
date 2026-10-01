'use strict';
/* ============================================================
   Detección de BPM y de golpes (beat tracking)
   1) computeOnset: "fuerza de ataque" de toda la pista (subida de energía, en toda la banda y en graves).
   2) bpmFromOnset: periodicidad por autocorrelación con un prior de tempo musical; refinamiento parabólico.
   3) trackBeats: programación dinámica (Ellis, 2007) que elige la secuencia de golpes que cae sobre los ataques
      fuertes y se mantiene cerca del tempo, pero puede seguir pequeñas variaciones (música en vivo).
   La octava (mitad/doble) puede ser ambigua: la interfaz ofrece ½ y ×2.
   ============================================================ */
const BPM_MIN = 55, BPM_MAX = 190;
const ONSET_HOP = 256;
const ONSET_LAG = 0.0; // segundos que el ataque real precede al fotograma de máxima subida (calibrado con pistas de prueba)

function computeOnset(buffer) {
  const sr = buffer.sampleRate;
  const hop = ONSET_HOP;
  const frames = Math.floor(buffer.length / hop);
  if (frames < 400) return null;

  const chans = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chans.push(buffer.getChannelData(c));

  const aLow = 1 - Math.exp((-2 * Math.PI * 180) / sr); // pasa-bajos de un polo (~180 Hz)
  let lp = 0;
  const eFull = new Float32Array(frames);
  const eLow = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sf = 0, sl = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i++) {
      let x = 0;
      for (const ch of chans) x += ch[base + i];
      x /= chans.length;
      lp += aLow * (x - lp);
      sf += x * x;
      sl += lp * lp;
    }
    eFull[f] = Math.sqrt(sf / hop);
    eLow[f] = Math.sqrt(sl / hop);
  }
  const norm = (arr) => {
    let m = 0;
    for (const v of arr) if (v > m) m = v;
    if (m > 0) for (let i = 0; i < arr.length; i++) arr[i] /= m;
  };
  norm(eFull); norm(eLow);

  // Onset: subida de la energía en escala logarítmica (insensible al volumen)
  const K = 60;
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const d1 = Math.log1p(K * eFull[f]) - Math.log1p(K * eFull[f - 1]);
    const d2 = Math.log1p(K * eLow[f]) - Math.log1p(K * eLow[f - 1]);
    onset[f] = Math.max(0, d1) + Math.max(0, d2);
  }
  // Se resta la media local (~1 s) para quedarse solo con los picos
  const fps = sr / hop;
  const win = Math.max(3, Math.round(fps));
  const clean = new Float32Array(frames);
  let run = 0;
  for (let f = 0; f < frames; f++) {
    run += onset[f];
    if (f >= win) run -= onset[f - win];
    clean[f] = Math.max(0, onset[f] - run / Math.min(f + 1, win));
  }
  return { clean, fps, frames };
}

function bpmFromOnset(on) {
  const { fps, frames } = on;
  // Se analizan hasta 120 s, saltando la introducción si la pista es larga
  const len = Math.min(frames, Math.floor(120 * fps));
  const s0 = frames > len ? Math.min(Math.floor(frames * 0.15), frames - len) : 0;
  const clean = on.clean.subarray(s0, s0 + len);
  const n = clean.length;

  const lagMin = Math.floor((fps * 60) / BPM_MAX);
  const lagMax = Math.ceil((fps * 60) / BPM_MIN);
  const lagLimit = Math.min(lagMax * 2 + 2, n - 2);
  const ac = new Float32Array(lagLimit + 2);
  for (let lag = lagMin; lag <= lagLimit; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += clean[i] * clean[i - lag];
    ac[lag] = s / (n - lag);
  }

  // Pico + armónico del doble de lag, ponderado por un prior de tempo (log-gaussiana centrada en ~100 BPM)
  let best = -1, bestLag = 0, sum = 0, cnt = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (fps * 60) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 100) / 0.85, 2));
    const s = (ac[lag] + 0.5 * (ac[lag * 2] || 0)) * prior;
    sum += s; cnt++;
    if (s > best) { best = s; bestLag = lag; }
  }
  if (bestLag === 0 || best <= 0) return { bpm: 0, confidence: 0 };

  let lagRefined = bestLag;
  const y0 = ac[bestLag - 1], y1 = ac[bestLag], y2 = ac[bestLag + 1];
  const den = y0 - 2 * y1 + y2;
  if (den < 0) lagRefined = bestLag + (0.5 * (y0 - y2)) / den;
  return { bpm: Math.round(((fps * 60) / lagRefined) * 10) / 10, confidence: best / (sum / cnt) };
}

// Compatibilidad: BPM directamente desde el audio
function detectBpm(buffer) {
  const on = computeOnset(buffer);
  return on ? bpmFromOnset(on) : { bpm: 0, confidence: 0 };
}

// Secuencia de golpes (en segundos) para una pista con el tempo dado
function trackBeats(on, bpm) {
  if (!on || !(bpm > 0)) return new Float32Array(0);
  const { clean, fps, frames } = on;

  let sum = 0, sq = 0;
  for (let i = 0; i < frames; i++) { sum += clean[i]; sq += clean[i] * clean[i]; }
  const mean = sum / frames;
  const sd = Math.sqrt(Math.max(1e-12, sq / frames - mean * mean));
  const o = new Float32Array(frames);
  for (let i = 0; i < frames; i++) o[i] = clean[i] / sd;

  const tau = (fps * 60) / bpm;                       // periodo ideal en fotogramas
  const pMin = Math.max(1, Math.round(tau / 2)), pMax = Math.round(tau * 2);
  const ALPHA = 100;                                  // rigidez del tempo: más alto = más constante
  const pen = new Float32Array(pMax + 1);
  for (let p = pMin; p <= pMax; p++) pen[p] = ALPHA * Math.pow(Math.log(p / tau), 2);

  const C = new Float32Array(frames);
  const back = new Int32Array(frames).fill(-1);
  for (let t = 0; t < frames; t++) {
    let best = 0, bp = -1;
    const pLim = Math.min(pMax, t);
    for (let p = pMin; p <= pLim; p++) {
      const v = C[t - p] - pen[p];
      if (v > best) { best = v; bp = t - p; }
    }
    C[t] = o[t] + best;
    back[t] = bp;
  }

  // El último golpe es el de mayor puntuación en los últimos dos periodos
  let tEnd = frames - 1, bestC = -Infinity;
  for (let t = Math.max(0, frames - pMax - 1); t < frames; t++) if (C[t] > bestC) { bestC = C[t]; tEnd = t; }
  const idx = [];
  for (let t = tEnd; t >= 0; t = back[t]) { idx.push(t); if (back[t] < 0) break; }
  idx.reverse();
  const out = new Float32Array(idx.length);
  for (let i = 0; i < idx.length; i++) out[i] = Math.max(0, (idx[i] * ONSET_HOP) / (on.fps * ONSET_HOP) - ONSET_LAG);
  return out;
}
