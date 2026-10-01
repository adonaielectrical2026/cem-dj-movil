'use strict';
/* ============================================================
   Medición de sonoridad (volumen percibido) según ITU-R BS.1770 / EBU R128:
   - filtro "K" (realce de agudos + corte de graves) para parecerse al oído humano
   - bloques de 400 ms con solapamiento de 75 %
   - doble compuerta: se descartan silencios (-70 LUFS) y pasajes mucho más bajos que el promedio (-10 LU)
   Devuelve { lufs, peak } o null si la pista es silencio o muy corta.
   ============================================================ */
function kWeighting(fs) {
  // Etapa 1: realce de agudos (high shelf)
  const f1 = 1681.974450955533, G = 3.999843853973347, Q1 = 0.7071752369554196;
  let K = Math.tan((Math.PI * f1) / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q1 + K * K;
  const hs = {
    b0: (Vh + (Vb * K) / Q1 + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q1 + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q1 + K * K) / a0
  };
  // Etapa 2: pasa-altos (RLB)
  const f2 = 38.13547087602444, Q2 = 0.5003270373238773;
  K = Math.tan((Math.PI * f2) / fs);
  a0 = 1 + K / Q2 + K * K;
  const hp = { a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q2 + K * K) / a0 };
  return { hs, hp };
}

function measureLoudness(buffer) {
  const fs = buffer.sampleRate;
  const sub = Math.floor(fs * 0.1); // sub-bloques de 100 ms
  const nSub = Math.floor(buffer.length / sub);
  if (nSub < 4) return null;

  const { hs, hp } = kWeighting(fs);
  const energy = new Float64Array(nSub);
  let peak = 0;

  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    const x = buffer.getChannelData(c);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // estado etapa 1
    let z1 = 0, z2 = 0, w1 = 0, w2 = 0; // estado etapa 2
    for (let b = 0; b < nSub; b++) {
      let sum = 0;
      for (let i = b * sub, end = i + sub; i < end; i++) {
        const s = x[i];
        const as = s < 0 ? -s : s;
        if (as > peak) peak = as;
        const y = hs.b0 * s + hs.b1 * x1 + hs.b2 * x2 - hs.a1 * y1 - hs.a2 * y2;
        x2 = x1; x1 = s; y2 = y1; y1 = y;
        const w = y - 2 * z1 + z2 - hp.a1 * w1 - hp.a2 * w2;
        z2 = z1; z1 = y; w2 = w1; w1 = w;
        sum += w * w;
      }
      energy[b] += sum;
    }
  }

  // Bloques de 400 ms (4 sub-bloques), avance de 100 ms
  const ms = [];
  for (let i = 0; i + 4 <= nSub; i++) ms.push((energy[i] + energy[i + 1] + energy[i + 2] + energy[i + 3]) / (4 * sub));
  const loud = (m) => -0.691 + 10 * Math.log10(m);

  const abs = ms.filter((m) => m > 0 && loud(m) > -70);
  if (!abs.length) return null;
  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const rel = loud(mean(abs)) - 10;
  const gated = abs.filter((m) => loud(m) > rel);
  if (!gated.length) return null;
  return { lufs: Math.round(loud(mean(gated)) * 10) / 10, peak };
}
