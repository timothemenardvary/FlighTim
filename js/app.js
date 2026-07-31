import { parseKML } from './kmlParser.js';
import * as db from './db.js';
import { createMap, drawFlightPath, fitToLayers, endpointDot } from './mapView.js';

const viewRoot = document.getElementById('view-root');
const headerTitle = document.getElementById('header-title');
const folderInput = document.getElementById('folder-input');
const tabButtons = [...document.querySelectorAll('.tab')];

let flights = []; // in-memory cache, sorted desc by date
let mapInstance = null; // tracked so we can .remove() before re-rendering a view with a map

function sortFlights() {
  flights.sort((a, b) => {
    const da = a.date || '';
    const db_ = b.date || '';
    if (da !== db_) return da < db_ ? 1 : -1;
    return (a.startTime || '') < (b.startTime || '') ? 1 : -1;
  });
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

  if (flights.length === 0) {
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
  for (const f of flights) {
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
          <div class="flight-meta">${fmtDate(f.date)}${f.airline ? ' · ' + escapeHtml(f.airline) : ''}</div>
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
  const f = flights.find((x) => x.id === id);
  headerTitle.textContent = f ? f.flightNumber : 'Vol';

  if (!f) {
    viewRoot.innerHTML = `<button class="back-btn" id="back-btn">&#8249; Vols</button><div class="empty-state">Vol introuvable.</div>`;
    document.getElementById('back-btn').addEventListener('click', () => navigate('#/flights'));
    return;
  }

  const duration = fmtDuration(f.startTime, f.endTime);

  viewRoot.innerHTML = `
    <button class="back-btn" id="back-btn">&#8249; Vols</button>
    <div id="flight-map"></div>
    <div class="detail-title">${escapeHtml(cityOrCode(f.depIata, f.depName))} &#8594; ${escapeHtml(cityOrCode(f.arrIata, f.arrName))}</div>
    <div class="detail-sub">${escapeHtml(f.flightNumber)}${f.airline ? ' · ' + escapeHtml(f.airline) : ''} · ${fmtDate(f.date)}</div>

    <div class="stat-grid">
      <div class="stat-tile"><div class="label">Distance</div><div class="value">${f.distanceKm ? f.distanceKm + ' km' : '—'}</div></div>
      <div class="stat-tile"><div class="label">Durée</div><div class="value">${duration || '—'}</div></div>
      <div class="stat-tile"><div class="label">Altitude max</div><div class="value">${f.maxAltitude ? f.maxAltitude.toLocaleString('fr-FR') + ' ft' : '—'}</div></div>
      <div class="stat-tile"><div class="label">Vitesse max</div><div class="value">${f.maxSpeed ? f.maxSpeed + ' kt' : '—'}</div></div>
    </div>

    <canvas id="alt-chart"></canvas>

    <div class="info-list">
      ${f.aircraftType ? `<div class="info-row"><span class="k">Appareil</span><span>${escapeHtml(f.aircraftType)}</span></div>` : ''}
      ${f.registration ? `<div class="info-row"><span class="k">Immatriculation</span><span>${escapeHtml(f.registration)}</span></div>` : ''}
      ${f.callsign ? `<div class="info-row"><span class="k">Indicatif</span><span>${escapeHtml(f.callsign)}</span></div>` : ''}
      <div class="info-row"><span class="k">Fichier source</span><span>${escapeHtml(f.sourceFile)}</span></div>
    </div>
  `;

  document.getElementById('back-btn').addEventListener('click', () => navigate('#/flights'));

  mapInstance = createMap('flight-map');
  const line = drawFlightPath(mapInstance, f);
  fitToLayers(mapInstance, [line]);

  if (f.points.some((p) => p.alt != null)) {
    drawAltitudeChart(document.getElementById('alt-chart'), f.points);
  } else {
    document.getElementById('alt-chart').style.display = 'none';
  }
}

function renderAllMap() {
  headerTitle.textContent = 'Toutes les traces';
  viewRoot.innerHTML = `<div id="all-map" style="height: calc(100vh - var(--header-h) - var(--tabbar-h) - 24px);"></div>`;

  mapInstance = createMap('all-map');
  const layers = [];
  const palette = ['#4da3ff', '#4ade80', '#facc15', '#f472b6', '#a78bfa', '#fb923c'];
  flights.forEach((f, i) => {
    if (!f.points || f.points.length < 2) return;
    const color = palette[i % palette.length];
    const latlngs = f.points.map((p) => [p.lat, p.lon]);
    const line = L.polyline(latlngs, { color, weight: 1.6, opacity: 0.55 }).addTo(mapInstance);
    line.bindTooltip(`${f.flightNumber} · ${f.depIata || '?'} → ${f.arrIata || '?'}`);
    layers.push(line);
  });
  if (layers.length) fitToLayers(mapInstance, layers, 20);
  else mapInstance.setView([20, 0], 2);
}

async function renderSettings() {
  headerTitle.textContent = 'Réglages';
  const lastImport = await db.getMeta('lastImport');
  const folderName = await db.getMeta('folderName');

  viewRoot.innerHTML = `
    <div class="settings-section">
      <h2>Source des données</h2>
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
          FlighTim lit vos exports .kml (FlightRadar24 / FlightAware) directement dans votre navigateur —
          aucune donnée n'est envoyée à un serveur. Les fichiers sont lus localement, puis les traces sont
          stockées sur cet appareil pour un accès hors-ligne.
        </p>
      </div>
    </div>
  `;

  document.getElementById('pick-folder-btn').addEventListener('click', () => folderInput.click());
  document.getElementById('clear-btn').addEventListener('click', async () => {
    if (!confirm('Supprimer tous les vols importés sur cet appareil ?')) return;
    await db.clearFlights();
    await db.setFlightFileStamps({});
    await db.setMeta('lastImport', null);
    await db.setMeta('folderName', null);
    flights = [];
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
    sortFlights();
  }

  await db.setFlightFileStamps(newStamps);
  await db.setMeta('lastImport', Date.now());
  const root = files[0].webkitRelativePath ? files[0].webkitRelativePath.split('/')[0] : null;
  if (root) await db.setMeta('folderName', root);

  document.querySelectorAll('.toast').forEach((t) => t.remove());
  showToast(`${toStore.length} vol(s) importé(s) · ${skipped} inchangé(s)${errors ? ' · ' + errors + ' erreur(s)' : ''}`);
  render();
});

// ---------- Init ----------

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  }
  flights = await db.getAllFlights();
  sortFlights();
  render();
}

init();
