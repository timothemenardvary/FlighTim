// Moteur de "replay" d'un vol : interpole une position (lat/lon/altitude/cap)
// le long des points GPS en fonction du temps réel de vol (quand les points
// sont horodatés, cf. source FR24) ou, à défaut, uniformément le long du
// tracé (source FlightAware, sans horodatage par point). Ce module ne touche
// à rien du DOM, de Leaflet ni du Canvas : app.js applique le rendu (marqueur,
// graphique, libellés) via le callback onFrame à chaque frame.

function toRad(d) { return (d * Math.PI) / 180; }
function toDeg(r) { return (r * 180) / Math.PI; }

function bearingBetween(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1), phi2 = toRad(lat2), dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Interpolation angulaire par le plus court chemin (évite un cap qui fait un
// tour complet quand il franchit 0°/360°).
function lerpAngle(a, b, f) {
  return a + (((b - a + 540) % 360) - 180) * f;
}

// `speed` = secondes de vol "rejouées" par seconde réelle (ex: 300 = 5 min de
// vol par seconde d'animation). Pour un tracé sans horodatage par point, sert
// juste de facteur relatif sur une durée nominale arbitraire.
export function createFlightReplay(points, { onFrame, speed = 300 } = {}) {
  const n = points.length;
  const hasRealTimes = points.every((p) => p.t != null);
  const t0 = hasRealTimes ? points[0].t : 0;
  const tEnd = hasRealTimes ? points[n - 1].t : n - 1;
  const totalMs = hasRealTimes ? Math.max(tEnd - t0, 1000) : null;
  const fallbackDurationMs = 60000;

  // offsets[i] = position (0..1) du point i le long de la timeline de replay
  const offsets = points.map((p, i) => (
    hasRealTimes ? (p.t - t0) / (tEnd - t0 || 1) : i / (n - 1 || 1)
  ));

  let progress = 0;
  let playing = false;
  let rafId = null;
  let lastTs = null;
  let currentSpeed = speed;

  function segmentAt(p) {
    if (p <= 0) return { i: 0, j: Math.min(1, n - 1), f: 0 };
    if (p >= 1) return { i: Math.max(0, n - 2), j: n - 1, f: 1 };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= p) lo = mid; else hi = mid;
    }
    const span = offsets[hi] - offsets[lo] || 1;
    return { i: lo, j: hi, f: (p - offsets[lo]) / span };
  }

  function poseAt(p) {
    const { i, j, f } = segmentAt(p);
    const a = points[i], b = points[j];
    const alt0 = a.alt ?? b.alt ?? 0, alt1 = b.alt ?? a.alt ?? 0;
    const bearingDeg = (a.heading != null && b.heading != null)
      ? lerpAngle(a.heading, b.heading, f)
      : bearingBetween(a.lat, a.lon, b.lat, b.lon);
    return {
      progress: p,
      lat: a.lat + (b.lat - a.lat) * f,
      lon: a.lon + (b.lon - a.lon) * f,
      alt: alt0 + (alt1 - alt0) * f,
      bearingDeg,
      tMs: hasRealTimes ? a.t + (b.t - a.t) * f : null,
    };
  }

  function emit() {
    onFrame(poseAt(progress), { playing });
  }

  function tick(ts) {
    if (!playing) return;
    if (lastTs == null) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;
    const duration = hasRealTimes ? totalMs : fallbackDurationMs;
    progress += (dt * currentSpeed) / duration;
    if (progress >= 1) {
      progress = 1;
      playing = false;
      emit();
      return;
    }
    emit();
    rafId = requestAnimationFrame(tick);
  }

  function play() {
    if (playing) return;
    if (progress >= 1) progress = 0;
    playing = true;
    lastTs = null;
    rafId = requestAnimationFrame(tick);
  }
  function pause() {
    playing = false;
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  }
  function toggle() { if (playing) pause(); else play(); }
  function seek(p) {
    pause();
    progress = Math.min(1, Math.max(0, p));
    emit();
  }
  function setSpeed(s) { currentSpeed = s; }
  function destroy() { pause(); }

  emit(); // état initial (progress 0, avion au départ)

  return {
    play, pause, toggle, seek, setSpeed, destroy,
    get playing() { return playing; },
    hasRealTimes,
  };
}
