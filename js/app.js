import { parseKML, haversineKm } from './kmlParser.js';
import { parseNotionCSV } from './notionParser.js';
import * as db from './db.js';
import { createMap, drawFlightPath, drawGreatCircle, fitToLayers, endpointDot } from './mapView.js';
import { lookupAirport } from './airports.js';

const viewRoot = document.getElementById('view-root');
const headerTitle = document.getElementById('header-title');
const folderInput = document.getElementById('folder-input');
const notionInput = document.getElementById('notion-input');
const tabButtons = [...document.querySelectorAll('.tab')];

let flights = []; // in-memory cache of vols KML, triés desc par date
let notionByKey = new Map(); // "NUMEROVOL|YYYY-MM-DD" -> ligne Notion, pour enrichir le détail d'un vol
let mapInstance = null; // tracked so we can .remove() before re-rendering a view with a map
let showOrthodromicOnly = true; // carte "Toutes les traces" : inclure les vols sans trace GPS réelle

function notionKeyFor(flight) {
  return `${(flight.flightNumber || '').toUpperCase()}|${flight.date || ''}`;
}

function resolveAirport(code) {
  return lookupAirport(code);
}

// Un vol présent dans l'export Notion mais sans trace KML correspondante
// (ex: vol pas encore/plus enregistré par FlightRadar24) est tout de même
// affiché, sous une forme "virtuelle" : pas de trace GPS ni d'altitude, mais
// route/horaires/retard/distance (à vol d'oiseau) calculés depuis Notion.
function virtualFlightFromNotion(key, n) {
  const dep = resolveAirport(n.depAirport);
  const arr = resolveAirport(n.arrAirport);
  const startTime = n.atdAt ?? n.stdAt ?? null;
  const endTime = n.ataAt ?? n.staAt ?? null;
  return {
    id: 'notion:' + key,
    isVirtual: true,
    flightNumber: n.flightNumber,
    airline: n.carrier || null,
    date: n.date,
    startTime: startTime != null ? new Date(startTime).toISOString() : null,
    endTime: endTime != null ? new Date(endTime).toISOString() : null,
    depIata: dep?.iata || n.depAirport || null,
    arrIata: arr?.iata || n.arrAirport || null,
    depName: dep?.city || null,
    arrName: arr?.city || null,
    depCoord: dep ? [dep.lat, dep.lon] : null,
    arrCoord: arr ? [arr.lat, arr.lon] : null,
    distanceKm: (dep && arr) ? Math.round(haversineKm(dep.lat, dep.lon, arr.lat, arr.lon)) : null,
    maxAltitude: null,
    maxSpeed: null,
    aircraftType: null,
    registration: n.registration || null,
    callsign: null,
    sourceFile: n.sourceFile,
    points: null,
  };
}

function flightSortCompare(a, b) {
  const da = a.date || '', db_ = b.date || '';
  if (da !== db_) return da < db_ ? 1 : -1;
  return (a.startTime || '') < (b.startTime || '') ? 1 : -1;
}

// Liste affichée dans l'app : vols KML + vols Notion sans trace KML
// correspondante (dédupliqués par numéro de vol + date), triés par date.
function buildDisplayFlights() {
  const matchedKeys = new Set(flights.map(notionKeyFor));
  const virtuals = [];
  for (const [key, n] of notionByKey) {
    if (matchedKeys.has(key)) continue;
    virtuals.push(virtualFlightFromNotion(key, n));
  }
  return [...flights, ...virtuals].sort(flightSortCompare);
}

function destroyMap() {
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
}

function showToast(msg, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(dateStr) {
  if (!dateStr) return 'Date inconnue';
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function fmtMonthHeader(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function fmtDuration(startISO, endISO) {
  if (!startISO || !endISO) return null;
  const ms = new Date(endISO) - new Date(startISO);
  if (!isFinite(ms) || ms <= 0) return null;
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

function cityOrCode(iata, name) {
  if (name && iata) return `${name} (${iata})`;
  return iata || name || '???';
}

function fmtHM(ts) {
  if (ts == null) return null;
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// Compare les dates calendaires (encodées via Date.UTC, cf notionParser) de
// deux horaires pour savoir si l'arrivée tombe le lendemain (ou plus tard) du
// départ, sans se soucier de l'heure elle-même.
function dayOffset(baseTs, ts) {
  if (baseTs == null || ts == null) return 0;
  const a = new Date(baseTs), b = new Date(ts);
  const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const db_ = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((db_ - da) / 86400000);
}

function fmtDelayMin(min) {
  if (min == null) return null;
  const abs = Math.round(Math.abs(min));
  const h = Math.floor(abs / 60), m = abs % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

// Écart signé pour une tuile KPI ("+12 min", "−3 min", "0 min").
function fmtSignedDelay(min) {
  if (min == null) return null;
  const rounded = Math.round(min);
  if (rounded === 0) return '0 min';
  return (rounded < 0 ? '−' : '+') + fmtDelayMin(rounded);
}

// Seuils inspirés des standards aériens (retard "officiel" à partir de 15 min) :
// à l'heure jusqu'à 5 min, avertissement jusqu'à 30 min, retard marqué au-delà.
function delayInfo(min, { arrival = false } = {}) {
  if (min == null) return null;
  if (min < -5) return { cls: 'good', label: `En avance de ${fmtDelayMin(min)}` };
  if (min <= 5) return { cls: 'good', label: 'À l’heure' };
  if (min <= 30) return { cls: 'warn', label: `Retard de ${fmtDelayMin(min)}${arrival ? ' à l’arrivée' : ' au départ'}` };
  return { cls: 'bad', label: `Retard de ${fmtDelayMin(min)}${arrival ? ' à l’arrivée' : ' au départ'}` };
}

function infoRow(label, value) {
  if (!value) return '';
  return `<div class="info-row"><span class="k">${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
}

// ---------- Router ----------

function currentRoute() {
  return location.hash || '#/flights';
}

function navigate(route) {
  if (location.hash === route) render();
  else location.hash = route;
}

window.addEventListener('hashchange', render);

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => navigate(btn.dataset.route));
});

function setActiveTab(route) {
  const base = '#/' + route.slice(2).split('/')[0];
  tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.route === base));
}

function render() {
  const route = currentRoute();
  setActiveTab(route);
  destroyMap();
  viewRoot.classList.toggle('map-view', route === '#/map');

  if (route.startsWith('#/flight/')) {
    const id = decodeURIComponent(route.slice('#/flight/'.length));
    renderFlightDetail(id);
  } else if (route === '#/map') {
    renderAllMap();
  } else if (route === '#/settings') {
    renderSettings();
  } else {
    renderFlightsList();
  }
}

// ---------- Views ----------

function renderFlightsList() {
  headerTitle.textContent = 'FlighTim';
  const displayFlights = buildDisplayFlights();

  if (displayFlights.length === 0) {
    viewRoot.innerHTML = `
      <div class="empty-state">
        <span class="big-emoji">✈️</span>
        <div>Aucun vol importé pour l'instant.</div>
        <button class="primary" id="import-empty-btn">Importer le dossier KML</button>
      </div>`;
    document.getElementById('import-empty-btn').addEventListener('click', () => folderInput.click());
    return;
  }

  let html = '';
  let lastMonth = null;
  for (const f of displayFlights) {
    const monthKey = f.date ? f.date.slice(0, 7) : 'inconnu';
    if (monthKey !== lastMonth) {
      html += `<div class="month-header">${f.date ? fmtMonthHeader(f.date) : 'Date inconnue'}</div>`;
      lastMonth = monthKey;
    }
    html += `
      <div class="flight-card" data-id="${escapeHtml(f.id)}">
        <div class="route">
          <div class="route-cities">
            <span>${escapeHtml(f.depIata || '???')}</span>
            <span class="route-arrow">&#9992;</span>
            <span>${escapeHtml(f.arrIata || '???')}</span>
            <span class="flight-number-badge">${escapeHtml(f.flightNumber)}</span>
          </div>
          <div class="flight-meta">${fmtDate(f.date)}${f.airline ? ' · ' + escapeHtml(f.airline) : ''}${f.isVirtual ? ' · sans trace GPS' : ''}</div>
        </div>
        <div class="chevron">&#8250;</div>
      </div>`;
  }
  viewRoot.innerHTML = html;

  viewRoot.querySelectorAll('.flight-card').forEach((card) => {
    card.addEventListener('click', () => navigate('#/flight/' + encodeURIComponent(card.dataset.id)));
  });
}

function drawAltitudeChart(canvas, points) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height;
  const alts = points.map((p) => p.alt ?? 0);
  const maxA = Math.max(...alts, 1);
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  alts.forEach((a, i) => {
    const x = (i / (alts.length - 1 || 1)) * w;
    const y = h - (a / maxA) * (h - 8) - 4;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(77,163,255,0.9)');
  grad.addColorStop(1, 'rgba(77,163,255,0.9)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(77,163,255,0.12)';
  ctx.fill();
}

function renderFlightDetail(id) {
  const f = buildDisplayFlights().find((x) => x.id === id);
  headerTitle.textContent = f ? f.flightNumber : 'Vol';

  if (!f) {
    viewRoot.innerHTML = `<button class="back-btn" id="back-btn">&#8249; Vols</button><div class="empty-state">Vol introuvable.</div>`;
    document.getElementById('back-btn').addEventListener('click', () => navigate('#/flights'));
    return;
  }

  const duration = fmtDuration(f.startTime, f.endTime);
  const n = notionByKey.get(notionKeyFor(f));

  // Heure "actual" affichée en priorité (ATD/ATA), avec repli sur la
  // programmée (STD/STA) si le vol n'a pas encore d'heure réelle, puis sur
  // les horaires KML (déjà en UTC réel) si aucune donnée Notion n'existe.
  const depSched = n?.stdAt ?? null;
  const depActual = n?.atdAt ?? n?.stdAt ?? null;
  const arrSched = n?.staAt ?? null;
  const arrActual = n?.ataAt ?? n?.staAt ?? null;
  const hasNotionTimes = depActual != null || arrActual != null;

  const depDelayMin = (n?.atdAt != null && n?.stdAt != null) ? (n.atdAt - n.stdAt) / 60000 : null;
  const arrDelayMin = (n?.ataAt != null && n?.staAt != null) ? (n.ataAt - n.staAt) / 60000 : null;
  const primaryDelay = arrDelayMin != null
    ? delayInfo(arrDelayMin, { arrival: true })
    : (depDelayMin != null ? delayInfo(depDelayMin, { arrival: false }) : null);

  const arrDayOffset = dayOffset(depActual ?? depSched, arrActual ?? arrSched);
  const avgSpeedKmh = (f.distanceKm && f.startTime && f.endTime)
    ? Math.round(f.distanceKm / ((new Date(f.endTime) - new Date(f.startTime)) / 3600000))
    : null;

  const depDelayInfo = delayInfo(depDelayMin, { arrival: false });
  const arrDelayInfo = delayInfo(arrDelayMin, { arrival: true });

  const hasRealTrack = !!(f.points && f.points.length >= 2);
  const depCoord = f.depCoord ?? null; // vols virtuels (Notion-only) uniquement
  const arrCoord = f.arrCoord ?? null;
  const canShowMap = hasRealTrack || (depCoord && arrCoord);

  const heroTimes = hasNotionTimes ? `
    <div class="hero-time-block">
      <div class="hero-time">${fmtHM(depActual) ?? '—'}</div>
      ${(depSched != null && depSched !== depActual) ? `<div class="hero-time-sched">${fmtHM(depSched)}</div>` : ''}
    </div>` : '';
  const heroTimesArr = hasNotionTimes ? `
    <div class="hero-time-block">
      <div class="hero-time">${fmtHM(arrActual) ?? '—'}${arrDayOffset > 0 ? `<sup class="day-badge">+${arrDayOffset}</sup>` : ''}</div>
      ${(arrSched != null && arrSched !== arrActual) ? `<div class="hero-time-sched">${fmtHM(arrSched)}</div>` : ''}
    </div>` : '';

  viewRoot.innerHTML = `
    <button class="back-btn" id="back-btn">&#8249; Vols</button>
    ${canShowMap ? '<div id="flight-map"></div>' : ''}

    <div class="hero">
      <div class="hero-endpoint">
        <div class="hero-code">${escapeHtml(f.depIata || '???')}</div>
        ${f.depName ? `<div class="hero-city">${escapeHtml(f.depName)}</div>` : ''}
        ${heroTimes}
      </div>
      <div class="hero-middle">
        <div class="hero-flightnum">${escapeHtml(f.flightNumber)}${f.airline ? ' · ' + escapeHtml(f.airline) : ''}</div>
        <div class="hero-line"><span class="dot"></span><span class="line"></span><span class="plane">&#9992;</span><span class="line"></span><span class="dot"></span></div>
        <div class="hero-duration">${duration || '—'}</div>
      </div>
      <div class="hero-endpoint right">
        <div class="hero-code">${escapeHtml(f.arrIata || '???')}</div>
        ${f.arrName ? `<div class="hero-city">${escapeHtml(f.arrName)}</div>` : ''}
        ${heroTimesArr}
      </div>
    </div>
    <div class="hero-date">${fmtDate(f.date)}</div>
    ${primaryDelay ? `<div class="status-pill ${primaryDelay.cls}">${primaryDelay.label}</div>` : ''}

    <div class="stat-grid">
      <div class="stat-tile"><div class="label">Retard départ</div><div class="value${depDelayInfo ? ' ' + depDelayInfo.cls : ''}">${fmtSignedDelay(depDelayMin) ?? '—'}</div></div>
      <div class="stat-tile"><div class="label">Retard arrivée</div><div class="value${arrDelayInfo ? ' ' + arrDelayInfo.cls : ''}">${fmtSignedDelay(arrDelayMin) ?? '—'}</div></div>
      <div class="stat-tile"><div class="label">Durée</div><div class="value">${duration || '—'}</div></div>
      <div class="stat-tile"><div class="label">Distance${f.isVirtual ? ' (approx.)' : ''}</div><div class="value">${f.distanceKm ? f.distanceKm + ' km' : '—'}</div></div>
      <div class="stat-tile"><div class="label">Vitesse moyenne</div><div class="value">${avgSpeedKmh ? avgSpeedKmh + ' km/h' : '—'}</div></div>
      <div class="stat-tile"><div class="label">Altitude max</div><div class="value">${f.maxAltitude ? f.maxAltitude.toLocaleString('fr-FR') + ' ft' : '—'}</div></div>
    </div>

    ${(f.points && f.points.length >= 2) ? '<canvas id="alt-chart"></canvas>' : ''}

    <div class="info-list">
      ${infoRow('Appareil', f.aircraftType)}
      ${infoRow('Immatriculation', f.registration || n?.registration)}
      ${infoRow('Indicatif', f.callsign)}
      ${infoRow('Vitesse max', f.maxSpeed ? f.maxSpeed + ' kt' : null)}
      ${infoRow('Fichier source', f.sourceFile)}
    </div>

    ${n ? `
      <div class="section-label">Notion</div>
      <div class="info-list">
        ${infoRow('Cabine', n.cabin)}
        ${infoRow('Siège', n.seats && n.seatType ? `${n.seats} · ${n.seatType}` : (n.seats || n.seatType))}
        ${infoRow('Portes dép. / arr.', (n.depGate || n.arrGate) ? `${n.depGate || '—'} → ${n.arrGate || '—'}` : null)}
        ${infoRow('Pistes dép. / arr.', (n.depRunway || n.arrRunway) ? `${n.depRunway || '—'} → ${n.arrRunway || '—'}` : null)}
        ${infoRow('Embarquement', (n.boardingStartAt || n.boardingEndAt) ? `${n.boardingStartAt ? fmtHM(n.boardingStartAt) : '—'} → ${n.boardingEndAt ? fmtHM(n.boardingEndAt) : '—'}` : null)}
        ${infoRow('Bloc prévu / réel', (n.scheduledBlockTime || n.actualBlockTime) ? `${n.scheduledBlockTime || '—'} / ${n.actualBlockTime || '—'}` : null)}
        ${infoRow('Taxi départ', n.departureTaxiTime ? n.departureTaxiTime + ' min' : null)}
      </div>
    ` : ''}
  `;

  document.getElementById('back-btn').addEventListener('click', () => navigate('#/flights'));

  if (hasRealTrack) {
    mapInstance = createMap('flight-map');
    const line = drawFlightPath(mapInstance, f);
    fitToLayers(mapInstance, [line]);
    if (f.points.some((p) => p.alt != null)) {
      drawAltitudeChart(document.getElementById('alt-chart'), f.points);
    }
  } else if (canShowMap) {
    mapInstance = createMap('flight-map');
    const line = drawGreatCircle(mapInstance, depCoord[0], depCoord[1], arrCoord[0], arrCoord[1]);
    endpointDot(depCoord, '#4ade80').addTo(mapInstance).bindTooltip(f.depIata || 'Départ');
    endpointDot(arrCoord, '#f87171').addTo(mapInstance).bindTooltip(f.arrIata || 'Arrivée');
    fitToLayers(mapInstance, [line]);
  }
}

function renderAllMap() {
  headerTitle.textContent = 'Toutes les traces';
  const displayFlights = buildDisplayFlights();
  const orthodromicCount = displayFlights.filter((f) => !(f.points && f.points.length >= 2)).length;

  viewRoot.innerHTML = `
    <label class="map-filter">
      <input type="checkbox" id="toggle-orthodromic" ${showOrthodromicOnly ? 'checked' : ''} ${orthodromicCount ? '' : 'disabled'} />
      <span>Vols sans trace GPS (route orthodromique)${orthodromicCount ? ' · ' + orthodromicCount : ''}</span>
    </label>
    <div id="all-map"></div>
  `;

  document.getElementById('toggle-orthodromic').addEventListener('change', (e) => {
    showOrthodromicOnly = e.target.checked;
    destroyMap();
    renderAllMap();
  });

  mapInstance = createMap('all-map');
  const layers = [];
  const palette = ['#4da3ff', '#4ade80', '#facc15', '#f472b6', '#a78bfa', '#fb923c'];
  displayFlights.forEach((f, i) => {
    const color = palette[i % palette.length];
    const hasRealTrack = f.points && f.points.length >= 2;

    if (hasRealTrack) {
      const latlngs = f.points.map((p) => [p.lat, p.lon]);
      const line = L.polyline(latlngs, { color, weight: 1.6, opacity: 0.55 }).addTo(mapInstance);
      line.bindTooltip(`${f.flightNumber} · ${f.depIata || '?'} → ${f.arrIata || '?'}`);
      layers.push(line);
      return;
    }

    if (!showOrthodromicOnly) return;
    const dep = resolveAirport(f.depIata);
    const arr = resolveAirport(f.arrIata);
    if (!dep || !arr) return;
    const line = drawGreatCircle(mapInstance, dep.lat, dep.lon, arr.lat, arr.lon, color, { weight: 1.6, opacity: 0.55 });
    line.bindTooltip(`${f.flightNumber} · ${f.depIata || '?'} → ${f.arrIata || '?'} (orthodromique)`);
    layers.push(line);
  });
  if (layers.length) fitToLayers(mapInstance, layers, 20);
  else mapInstance.setView([20, 0], 2);
}

async function renderSettings() {
  headerTitle.textContent = 'Réglages';
  const lastImport = await db.getMeta('lastImport');
  const folderName = await db.getMeta('folderName');
  const notionLastImport = await db.getMeta('notionLastImport');
  const notionFolderName = await db.getMeta('notionFolderName');

  viewRoot.innerHTML = `
    <div class="settings-section">
      <h2>Traces de vol (KML)</h2>
      <div class="settings-card">
        <div class="settings-row"><span class="k">Dossier</span><span>${folderName ? escapeHtml(folderName) : 'Non défini'}</span></div>
        <div class="settings-row"><span class="k">Vols importés</span><span>${flights.length}</span></div>
        <div class="settings-row"><span class="k">Dernier import</span><span>${lastImport ? new Date(lastImport).toLocaleString('fr-FR') : 'Jamais'}</span></div>
        <div class="settings-actions">
          <button class="primary" id="pick-folder-btn">Choisir le dossier KML</button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Détails de vol (Notion)</h2>
      <div class="settings-card">
        <div class="settings-row"><span class="k">Dossier</span><span>${notionFolderName ? escapeHtml(notionFolderName) : 'Non défini'}</span></div>
        <div class="settings-row"><span class="k">Vols enrichis</span><span>${notionByKey.size}</span></div>
        <div class="settings-row"><span class="k">Dernier import</span><span>${notionLastImport ? new Date(notionLastImport).toLocaleString('fr-FR') : 'Jamais'}</span></div>
        <div class="settings-actions">
          <button class="primary" id="pick-notion-btn">Choisir le dossier Notion</button>
        </div>
        <p style="margin:10px 0 0; font-size:12px; color:var(--text-dim); line-height:1.4;">
          Exporte ta base Notion "Flight History" en CSV (··· → Export) dans un dossier, puis sélectionne ce
          dossier ici. Le rapprochement avec les traces KML se fait par numéro de vol + date.
        </p>
      </div>
    </div>

    <div class="settings-section">
      <h2>Données</h2>
      <div class="settings-card">
        <div class="settings-actions">
          <button class="secondary danger" id="clear-btn">Effacer toutes les données</button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h2>À propos</h2>
      <div class="settings-card">
        <p style="margin:0; font-size:13px; color:var(--text-dim); line-height:1.5;">
          FlighTim lit vos exports .kml (FlightRadar24 / FlightAware) et vos exports CSV Notion
          directement dans votre navigateur — aucune donnée n'est envoyée à un serveur. Les fichiers sont
          lus localement, puis stockés sur cet appareil pour un accès hors-ligne.
        </p>
      </div>
    </div>
  `;

  document.getElementById('pick-folder-btn').addEventListener('click', () => folderInput.click());
  document.getElementById('pick-notion-btn').addEventListener('click', () => notionInput.click());
  document.getElementById('clear-btn').addEventListener('click', async () => {
    if (!confirm('Supprimer tous les vols et données Notion importés sur cet appareil ?')) return;
    await db.clearFlights();
    await db.clearNotionFlights();
    await db.setFlightFileStamps({});
    await db.setMeta('lastImport', null);
    await db.setMeta('folderName', null);
    await db.setMeta('notionLastImport', null);
    await db.setMeta('notionFolderName', null);
    flights = [];
    notionByKey = new Map();
    showToast('Données effacées');
    renderSettings();
  });
}

// ---------- Import ----------

folderInput.addEventListener('change', async () => {
  const files = [...folderInput.files].filter((f) => /\.kml$/i.test(f.name));
  folderInput.value = '';
  if (files.length === 0) {
    showToast('Aucun fichier .kml trouvé dans ce dossier');
    return;
  }

  showToast(`Import de ${files.length} fichier(s)…`, 60000);
  const stamps = await db.getFlightFileStamps();
  const newStamps = { ...stamps };
  const toStore = [];
  let skipped = 0, errors = 0;

  for (const file of files) {
    const stampKey = file.webkitRelativePath || file.name;
    const prevStamp = stamps[stampKey];
    if (prevStamp && prevStamp.size === file.size && prevStamp.lastModified === file.lastModified) {
      skipped++;
      continue;
    }
    try {
      const text = await file.text();
      const parsed = parseKML(text, file.name);
      toStore.push(parsed);
      newStamps[stampKey] = { size: file.size, lastModified: file.lastModified };
    } catch (err) {
      console.error(err);
      errors++;
    }
  }

  if (toStore.length) {
    await db.putFlights(toStore);
    for (const f of toStore) {
      const idx = flights.findIndex((x) => x.id === f.id);
      if (idx >= 0) flights[idx] = f; else flights.push(f);
    }
    flights.sort(flightSortCompare);
  }

  await db.setFlightFileStamps(newStamps);
  await db.setMeta('lastImport', Date.now());
  const root = files[0].webkitRelativePath ? files[0].webkitRelativePath.split('/')[0] : null;
  if (root) await db.setMeta('folderName', root);

  document.querySelectorAll('.toast').forEach((t) => t.remove());
  showToast(`${toStore.length} vol(s) importé(s) · ${skipped} inchangé(s)${errors ? ' · ' + errors + ' erreur(s)' : ''}`);
  render();
});

notionInput.addEventListener('change', async () => {
  const files = [...notionInput.files].filter((f) => /\.csv$/i.test(f.name));
  notionInput.value = '';
  if (files.length === 0) {
    showToast('Aucun fichier .csv trouvé dans ce dossier');
    return;
  }

  showToast(`Import Notion de ${files.length} fichier(s)…`, 60000);
  const allRecords = [];
  let ignoredFiles = 0, errors = 0;

  for (const file of files) {
    try {
      const text = await file.text();
      const records = parseNotionCSV(text, file.name);
      if (records === null) { ignoredFiles++; continue; }
      allRecords.push(...records);
    } catch (err) {
      console.error(err);
      errors++;
    }
  }

  if (allRecords.length) {
    await db.putNotionFlights(allRecords);
    for (const r of allRecords) notionByKey.set(r.key, r);
  }

  await db.setMeta('notionLastImport', Date.now());
  const root = files[0].webkitRelativePath ? files[0].webkitRelativePath.split('/')[0] : null;
  if (root) await db.setMeta('notionFolderName', root);

  document.querySelectorAll('.toast').forEach((t) => t.remove());
  showToast(`${allRecords.length} ligne(s) Notion importée(s)`
    + (ignoredFiles ? ` · ${ignoredFiles} fichier(s) ignoré(s) (pas un export de vols)` : '')
    + (errors ? ` · ${errors} erreur(s)` : ''));
  render();
});

// ---------- Init ----------

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  }
  flights = await db.getAllFlights();
  flights.sort(flightSortCompare);
  const notionRecords = await db.getAllNotionFlights();
  notionByKey = new Map(notionRecords.map((r) => [r.key, r]));
  render();
}

init();
