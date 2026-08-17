import { parseKML, haversineKm } from './kmlParser.js';
import { parseFlightAwareJSON } from './flightAwareParser.js';
import { parseNotionCSV } from './notionParser.js';
import { parseNotionFlightPage, resolveRelativePath } from './notionHtmlParser.js';
import * as db from './db.js';
import { createMap, drawFlightPath, drawGreatCircle, fitToLayers, endpointDot, createPlaneMarker } from './mapView.js';
import { lookupAirport, continentFor, averageCoordFor } from './airports.js';
import { WORLD_VIEWBOX, WORLD_LAND_SVG, VISITED_COUNTRY_PATHS, projectLonLat } from './worldGeo.js';
import { createFlightReplay } from './replay.js';

// Affichée en bas de Réglages pour vérifier qu'un appareil a bien rechargé
// la dernière version (utile sur iOS où le service worker peut mettre du
// temps à se mettre à jour) — à faire évoluer en même temps que CACHE_NAME
// dans sw.js, les deux ne sont pas lus depuis une source commune.
const APP_VERSION = 'v23';

const viewRoot = document.getElementById('view-root');
const headerTitle = document.getElementById('header-title');
const tabButtons = [...document.querySelectorAll('.tab')];

// Ouvre le picker fichiers/dossier natif. Sur iOS Safari, réutiliser le même
// <input type="file"> pour plusieurs sélections successives le fait parfois
// se bloquer silencieusement (le .click() suivant ne rouvre plus rien) —
// on recrée donc un input jetable à chaque appel plutôt qu'un input statique
// dans index.html.
function pickFiles({ directory = false } = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.kml,.json,.csv,.html,.htm';
  if (directory) input.webkitdirectory = true;
  // Hors écran plutôt que display:none (hidden) : certaines versions de
  // WebKit ignorent le .click() programmatique d'un input non affiché.
  Object.assign(input.style, { position: 'fixed', top: '-9999px', left: '-9999px' });
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.remove();
    handleFileSelection(files);
  }, { once: true });
  input.click();
}

let flights = []; // in-memory cache of vols KML, triés desc par date
let notionByKey = new Map(); // "NUMEROVOL|YYYY-MM-DD" -> ligne Notion, pour enrichir le détail d'un vol
let mapInstance = null; // tracked so we can .remove() before re-rendering a view with a map
let showOrthodromicOnly = true; // carte "Toutes les traces" : inclure les vols sans trace GPS réelle
let currentReplay = null; // replay en cours sur la page détail, à stopper avant de quitter la vue
let pendingRefresh = false; // le prochain choix de dossier doit d'abord tout effacer (bouton "Rafraîchir")
let statsSubView = 'flights'; // page Stats : 'flights' ou 'airports'
let statsYear = 'all'; // filtre année partagé par les deux sous-vues de la page Stats
let selectedAirport = null; // aéroport choisi dans le détail de la page Stats > Aéroports
let flightSearchQuery = ''; // texte de la barre de recherche, page Liste des vols
let flightPhotoObjectUrls = []; // URLs blob de la galerie photo perso affichée sur le détail de vol, à révoquer au prochain rendu
let flightPlanObjectUrl = null; // URL blob du PDF plan de vol affiché sur le détail de vol, à révoquer au prochain rendu

function notionKeyFor(flight) {
  return `${(flight.flightNumber || '').toUpperCase()}|${flight.date || ''}`;
}

function nFor(flight) {
  return notionByKey.get(notionKeyFor(flight));
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
  if (currentReplay) {
    currentReplay.destroy();
    currentReplay = null;
  }
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

// Variante de infoRow() dont la valeur est un lien hash (ex. vers la fiche
// avion) plutôt qu'un simple texte.
function infoRowLink(label, value, route) {
  if (!value) return '';
  return `<div class="info-row"><span class="k">${escapeHtml(label)}</span><a href="${escapeHtml(route)}" class="info-link">${escapeHtml(value)}</a></div>`;
}

function delayMinutes(schedTs, actualTs) {
  return (schedTs != null && actualTs != null) ? (actualTs - schedTs) / 60000 : null;
}

// Horaires "porte" + décollage/atterrissage d'un vol, toutes sources
// confondues : Notion (STD/ATD, STA/ATA) prime quand il existe (donnée de
// référence saisie par l'utilisateur), sinon on retombe sur ceux du KML/JSON
// importé. Partagé entre le détail de vol et les pages de statistiques.
//
// Piège corrigé ici : Notion encode l'heure locale "comme si" c'était de
// l'UTC (cf. notionParser, pour que fmtHM() — qui lit toujours les
// composants UTC d'un timestamp — restitue l'heure locale telle quelle).
// FlightAware, lui, fournit de vrais epochs UTC. Sans conversion, fmtHM()
// afficherait donc l'heure de Paris en Zulu pour les vols FlightAware sans
// correspondance Notion (et systématiquement pour décollage/atterrissage,
// que Notion n'a jamais) — d'où le décalage à l'affichage. On ramène tout à
// la même convention "heure locale encodée en UTC" avant de renvoyer quoi
// que ce soit.
function flightGateTimes(f) {
  const n = nFor(f);
  const depOffsetMin = airportUtcOffsetMin(f.depTz, n?.depUtcOffsetMin, f.depGateActualAt, f.depGateSchedAt, f.depTakeoffActualAt, f.depTakeoffSchedAt);
  const arrOffsetMin = airportUtcOffsetMin(f.arrTz, n?.arrUtcOffsetMin, f.arrGateActualAt, f.arrGateSchedAt, f.arrLandingActualAt, f.arrLandingSchedAt);
  return {
    n,
    depOffsetMin,
    arrOffsetMin,
    depGateSched: n?.stdAt ?? toLocalNaive(f.depGateSchedAt, depOffsetMin),
    depGateActual: n?.atdAt ?? toLocalNaive(f.depGateActualAt, depOffsetMin),
    arrGateSched: n?.staAt ?? toLocalNaive(f.arrGateSchedAt, arrOffsetMin),
    arrGateActual: n?.ataAt ?? toLocalNaive(f.arrGateActualAt, arrOffsetMin),
    depTakeoffSched: toLocalNaive(f.depTakeoffSchedAt, depOffsetMin),
    depTakeoffActual: toLocalNaive(f.depTakeoffActualAt, depOffsetMin),
    arrLandingSched: toLocalNaive(f.arrLandingSchedAt, arrOffsetMin),
    arrLandingActual: toLocalNaive(f.arrLandingActualAt, arrOffsetMin),
  };
}

function flightDelays(f) {
  const { depGateSched, depGateActual, arrGateSched, arrGateActual } = flightGateTimes(f);
  return {
    depDelayMin: delayMinutes(depGateSched, depGateActual),
    arrDelayMin: delayMinutes(arrGateSched, arrGateActual),
  };
}

// Décalage UTC réel (en minutes) d'un fuseau IANA à un instant donné, DST
// pris en compte : on formate l'instant dans ce fuseau, on relit les
// composants "comme si" c'était de l'UTC, et on mesure l'écart avec le vrai
// instant UTC. Ne nécessite aucune base de données de fuseaux embarquée.
function tzOffsetMinutes(epochMs, timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(dtf.formatToParts(new Date(epochMs)).map((x) => [x.type, x.value]));
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUTC - epochMs) / 60000);
  } catch {
    return null;
  }
}

function fmtUtcOffset(mins) {
  if (mins == null) return null;
  const sign = mins < 0 ? '−' : '+';
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60), m = abs % 60;
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

// Décalage d'un aéroport : calculé depuis son fuseau IANA (FlightAware,
// précis et sensible au DST) si dispo, sinon replié sur le "(GMT+X)" que
// Notion affiche déjà pré-calculé pour cette date-là.
function airportUtcOffsetMin(tz, notionOffsetMin, ...refEpochs) {
  if (tz) {
    const ref = refEpochs.find((e) => e != null);
    if (ref != null) {
      const computed = tzOffsetMinutes(ref, tz);
      if (computed != null) return computed;
    }
  }
  return notionOffsetMin ?? null;
}

// Décale un vrai epoch UTC (FlightAware) pour qu'il se lise, une fois passé
// à fmtHM() (qui lit les composants UTC), comme l'heure locale de
// l'aéroport — même convention que les timestamps Notion. `offsetMin` doit
// avoir été calculé sur un epoch UTC non converti (cf. airportUtcOffsetMin),
// jamais sur une valeur déjà décalée par cette fonction.
function toLocalNaive(trueUtcMs, offsetMin) {
  if (trueUtcMs == null || offsetMin == null) return trueUtcMs;
  return trueUtcMs + offsetMin * 60000;
}

// Ligne "programmé → réel" avec code couleur de retard et badge UTC — pour
// les sections Départ/Arrivée du détail de vol.
function phaseTimeRow(label, schedTs, actualTs, offsetMin) {
  if (schedTs == null && actualTs == null) return '';
  const schedStr = schedTs != null ? fmtHM(schedTs) : null;
  const actualStr = actualTs != null ? fmtHM(actualTs) : null;
  const info = delayInfo(delayMinutes(schedTs, actualTs));
  let valueHtml = (schedStr && actualStr && schedStr !== actualStr)
    ? `<span class="time-sched-inline">${schedStr}</span> → <span class="${info ? info.cls : ''}">${actualStr}</span>`
    : (actualStr || schedStr);
  const offsetLabel = fmtUtcOffset(offsetMin);
  if (offsetLabel) valueHtml += ` <span class="utc-badge">${offsetLabel}</span>`;
  return `<div class="info-row"><span class="k">${escapeHtml(label)}</span><span>${valueHtml}</span></div>`;
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
  } else if (route.startsWith('#/aircraft/')) {
    const registration = decodeURIComponent(route.slice('#/aircraft/'.length));
    renderAircraftDetail(registration);
  } else if (route === '#/map') {
    renderAllMap();
  } else if (route === '#/stats') {
    renderStats();
  } else if (route === '#/settings') {
    renderSettings();
  } else {
    renderFlightsList();
  }
}

// ---------- Views ----------

// Texte normalisé (majuscules, sans espaces) dans lequel chercher : numéro de
// vol, compagnie, et itinéraire écrit "collé" façon "CDGNCE" pour qu'une
// recherche de ce type matche sans que l'utilisateur ait à connaître le
// séparateur utilisé à l'affichage.
function flightSearchHaystack(f) {
  const route = `${f.depIata || ''}${f.arrIata || ''}`;
  return [f.flightNumber, f.airline, route].join(' ').toUpperCase();
}

function matchesFlightSearch(f, query) {
  if (!query) return true;
  return flightSearchHaystack(f).includes(query);
}

function flightCardHtml(f) {
  return `
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

// Liste de flight-card avec en-têtes de mois, partagée entre la liste
// principale (page Vols) et la liste de vols de la fiche avion.
function flightListHtml(flightsSorted) {
  let html = '';
  let lastMonth = null;
  for (const f of flightsSorted) {
    const monthKey = f.date ? f.date.slice(0, 7) : 'inconnu';
    if (monthKey !== lastMonth) {
      html += `<div class="month-header">${f.date ? fmtMonthHeader(f.date) : 'Date inconnue'}</div>`;
      lastMonth = monthKey;
    }
    html += flightCardHtml(f);
  }
  return html;
}

function wireFlightCards(root) {
  root.querySelectorAll('.flight-card').forEach((card) => {
    card.addEventListener('click', () => navigate('#/flight/' + encodeURIComponent(card.dataset.id)));
  });
}

function renderFlightsList() {
  headerTitle.textContent = 'FlighTim';
  const displayFlights = buildDisplayFlights();

  if (displayFlights.length === 0) {
    viewRoot.innerHTML = `
      <div class="empty-state">
        <span class="big-emoji">✈️</span>
        <div>Aucun vol importé pour l'instant.</div>
        <button class="primary" id="import-empty-btn">Importer mes données</button>
      </div>`;
    document.getElementById('import-empty-btn').addEventListener('click', () => pickFiles({ directory: true }));
    return;
  }

  viewRoot.innerHTML = `
    <div class="search-bar">
      <span class="search-icon">&#128269;</span>
      <input type="search" id="flight-search-input" placeholder="Numéro de vol, compagnie, itinéraire (ex. CDGNCE)…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" value="${escapeHtml(flightSearchQuery)}">
    </div>
    <div id="flights-list"></div>`;

  const listEl = document.getElementById('flights-list');

  function renderList() {
    const query = flightSearchQuery.trim().toUpperCase();
    const filtered = displayFlights.filter((f) => matchesFlightSearch(f, query));

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="no-results">Aucun vol ne correspond à « ${escapeHtml(flightSearchQuery.trim())} ».</div>`;
      return;
    }

    listEl.innerHTML = flightListHtml(filtered);
    wireFlightCards(listEl);
  }

  const searchInput = document.getElementById('flight-search-input');
  searchInput.addEventListener('input', () => {
    flightSearchQuery = searchInput.value;
    renderList();
  });

  renderList();
}

// Prépare le canvas une seule fois (taille, échelle DPR) et renvoie une
// fonction draw(progress) redessinable à chaque frame du replay — pas de
// redimensionnement du canvas à chaque appel, juste un clear + retracé, pour
// rester fluide à 60 fps.
function setupAltitudeChart(canvas, points) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height;
  const alts = points.map((p) => p.alt ?? 0);
  const maxA = Math.max(...alts, 1);
  const yFor = (a) => h - (a / maxA) * (h - 8) - 4;

  return function draw(progress = null) {
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    alts.forEach((a, i) => {
      const x = (i / (alts.length - 1 || 1)) * w;
      const y = yFor(a);
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

    if (progress == null) return;
    const idxF = progress * (alts.length - 1);
    const i0 = Math.floor(idxF), i1 = Math.min(i0 + 1, alts.length - 1);
    const a = alts[i0] + (alts[i1] - alts[i0]) * (idxF - i0);
    const x = progress * w, y = yFor(a);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.strokeStyle = 'rgba(148,163,184,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#4da3ff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
  };
}

function renderFlightDetail(id) {
  // Révoque les URLs blob de la galerie photo du rendu précédent (page
  // quittée ou vol différent) avant d'en créer éventuellement de nouvelles.
  flightPhotoObjectUrls.forEach((u) => URL.revokeObjectURL(u));
  flightPhotoObjectUrls = [];
  if (flightPlanObjectUrl) { URL.revokeObjectURL(flightPlanObjectUrl); flightPlanObjectUrl = null; }

  const f = buildDisplayFlights().find((x) => x.id === id);
  headerTitle.textContent = f ? f.flightNumber : 'Vol';

  if (!f) {
    viewRoot.innerHTML = `<button class="back-btn" id="back-btn">&#8249; Vols</button><div class="empty-state">Vol introuvable.</div>`;
    document.getElementById('back-btn').addEventListener('click', () => navigate('#/flights'));
    return;
  }

  const duration = fmtDuration(f.startTime, f.endTime);
  const {
    n, depOffsetMin, arrOffsetMin,
    depGateSched, depGateActual, arrGateSched, arrGateActual,
    depTakeoffSched, depTakeoffActual, arrLandingSched, arrLandingActual,
  } = flightGateTimes(f);
  const hasGateTimes = depGateActual != null || arrGateActual != null;
  const registration = f.registration || n?.registration || null;

  // Photo(s) perso jointe(s) à ce vol dans Notion (prioritaire, souvenir du
  // vol lui-même) plutôt que la photo générique de l'appareil via
  // FlightAware — les deux sources ne se mélangent jamais dans la galerie.
  const personalPhotoBlobs = n?.photoBlobs?.length ? n.photoBlobs : (n?.photoBlob ? [n.photoBlob] : []);
  const photos = personalPhotoBlobs.length
    ? personalPhotoBlobs.map((blob) => ({ kind: 'personal', blob }))
    : (f.photoUrl ? [{ kind: 'flightaware', url: f.photoUrl }] : []);

  const flightPlanBlob = n?.flightPlanBlob || null;

  const depDelayMin = delayMinutes(depGateSched, depGateActual);
  const arrDelayMin = delayMinutes(arrGateSched, arrGateActual);
  const primaryDelay = arrDelayMin != null
    ? delayInfo(arrDelayMin, { arrival: true })
    : (depDelayMin != null ? delayInfo(depDelayMin, { arrival: false }) : null);

  const arrDayOffset = dayOffset(depGateActual ?? depGateSched, arrGateActual ?? arrGateSched);
  const avgSpeedKmh = (f.distanceKm && f.startTime && f.endTime)
    ? Math.round(f.distanceKm / ((new Date(f.endTime) - new Date(f.startTime)) / 3600000))
    : null;

  const depDelayInfo = delayInfo(depDelayMin, { arrival: false });
  const arrDelayInfo = delayInfo(arrDelayMin, { arrival: true });

  const depRows = [
    phaseTimeRow('Heure (porte)', depGateSched, depGateActual, depOffsetMin),
    phaseTimeRow('Décollage', depTakeoffSched, depTakeoffActual, depOffsetMin),
    infoRow('Porte', f.depGate || n?.depGate),
    infoRow('Terminal', f.depTerminal),
    infoRow('Piste', f.depRunway || n?.depRunway),
    infoRow('Embarquement', (n?.boardingStartAt || n?.boardingEndAt) ? `${n.boardingStartAt ? fmtHM(n.boardingStartAt) : '—'} → ${n.boardingEndAt ? fmtHM(n.boardingEndAt) : '—'}` : null),
    infoRow('Taxi avant décollage', n?.departureTaxiTime ? n.departureTaxiTime + ' min' : null),
  ].join('');

  const arrRows = [
    phaseTimeRow('Heure (porte)', arrGateSched, arrGateActual, arrOffsetMin),
    phaseTimeRow('Atterrissage', arrLandingSched, arrLandingActual, arrOffsetMin),
    infoRow('Porte', f.arrGate || n?.arrGate),
    infoRow('Terminal', f.arrTerminal),
    infoRow('Piste', f.arrRunway || n?.arrRunway),
  ].join('');

  // Carburant planifié (dispatch) -> CO2 estimé : ~3,16 kg de CO2 par kg de
  // kérosène brûlé (facteur d'émission standard pour le Jet A-1).
  const co2Tonnes = f.fuelBurnLbs != null ? (f.fuelBurnLbs * 0.453592 * 3.16) / 1000 : null;

  const hasRealTrack = !!(f.points && f.points.length >= 2);
  const depCoord = f.depCoord ?? null; // vols virtuels (Notion-only) uniquement
  const arrCoord = f.arrCoord ?? null;
  const canShowMap = hasRealTrack || (depCoord && arrCoord);

  const heroTimes = hasGateTimes ? `
    <div class="hero-time-block">
      <div class="hero-time">${fmtHM(depGateActual) ?? '—'}</div>
      ${(depGateSched != null && depGateSched !== depGateActual) ? `<div class="hero-time-sched">${fmtHM(depGateSched)}</div>` : ''}
    </div>` : '';
  const heroTimesArr = hasGateTimes ? `
    <div class="hero-time-block">
      <div class="hero-time">${fmtHM(arrGateActual) ?? '—'}${arrDayOffset > 0 ? `<sup class="day-badge">+${arrDayOffset}</sup>` : ''}</div>
      ${(arrGateSched != null && arrGateSched !== arrGateActual) ? `<div class="hero-time-sched">${fmtHM(arrGateSched)}</div>` : ''}
    </div>` : '';

  viewRoot.innerHTML = `
    <button class="back-btn" id="back-btn">&#8249; Vols</button>
    ${canShowMap ? '<div id="flight-map"></div>' : ''}
    ${hasRealTrack ? `
    <div class="replay-bar">
      <button class="replay-play" id="replay-play" aria-label="Lecture">&#9654;</button>
      <input type="range" id="replay-seek" min="0" max="1000" value="0" step="1" />
      <span class="replay-time" id="replay-time">--:--</span>
      <div class="replay-speeds" id="replay-speeds">
        <button type="button" data-speed="60">1 min/s</button>
        <button type="button" data-speed="300" class="active">5 min/s</button>
        <button type="button" data-speed="900">15 min/s</button>
      </div>
    </div>` : ''}

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
    ${n?.notes ? `<div class="note-card"><div class="note-card-label">Note</div>${escapeHtml(n.notes)}</div>` : ''}

    ${depRows ? `
    <div class="leg-card leg-dep">
      <div class="leg-header">
        <span class="leg-icon">&#128747;</span>
        <span class="leg-title">Départ</span>
        <span class="leg-airport">${escapeHtml(f.depIata || '???')}${f.depName ? ' · ' + escapeHtml(f.depName) : ''}</span>
      </div>
      <div class="info-list">${depRows}</div>
    </div>` : ''}

    ${arrRows ? `
    <div class="leg-card leg-arr">
      <div class="leg-header">
        <span class="leg-icon">&#128748;</span>
        <span class="leg-title">Arrivée</span>
        <span class="leg-airport">${escapeHtml(f.arrIata || '???')}${f.arrName ? ' · ' + escapeHtml(f.arrName) : ''}</span>
      </div>
      <div class="info-list">${arrRows}</div>
    </div>` : ''}

    ${flightPlanBlob ? `
    <div class="flightplan-card">
      <button type="button" class="secondary" id="flightplan-toggle">&#128196; Plan de vol${n.flightPlanName ? ' · ' + escapeHtml(n.flightPlanName) : ''}</button>
      <div class="flightplan-viewer" id="flightplan-viewer" hidden>
        <iframe id="flightplan-frame" title="Plan de vol"></iframe>
      </div>
    </div>` : ''}

    ${photos.length ? `
    <div class="aircraft-photo" id="aircraft-photo-wrap">
      <div class="aircraft-photo-track" id="aircraft-photo-track">
        ${photos.map((p, i) => `
        <div class="aircraft-photo-slide" data-idx="${i}">
          <img data-idx="${i}" alt="${p.kind === 'personal' ? `Photo du vol${photos.length > 1 ? ' ' + (i + 1) + '/' + photos.length : ''}` : "Photo de l'appareil"}" loading="lazy" />
          <div class="aircraft-photo-fallback">Photo indisponible${p.kind === 'flightaware' ? ' hors ligne' : ''}</div>
        </div>`).join('')}
      </div>
      ${photos.length > 1 ? `
      <span class="aircraft-photo-count" id="aircraft-photo-count">1/${photos.length}</span>
      <div class="aircraft-photo-dots" id="aircraft-photo-dots">
        ${photos.map((_, i) => `<button type="button" class="dot${i === 0 ? ' active' : ''}" data-idx="${i}" aria-label="Photo ${i + 1}"></button>`).join('')}
      </div>` : ''}
      ${photos[0].kind === 'flightaware' ? '<span class="aircraft-photo-credit">Photo : FlightAware</span>' : ''}
    </div>` : ''}

    <div class="stat-grid">
      <div class="stat-tile"><div class="label">Retard départ</div><div class="value${depDelayInfo ? ' ' + depDelayInfo.cls : ''}">${fmtSignedDelay(depDelayMin) ?? '—'}</div></div>
      <div class="stat-tile"><div class="label">Retard arrivée</div><div class="value${arrDelayInfo ? ' ' + arrDelayInfo.cls : ''}">${fmtSignedDelay(arrDelayMin) ?? '—'}</div></div>
      <div class="stat-tile"><div class="label">Durée</div><div class="value">${duration || '—'}</div></div>
      <div class="stat-tile"><div class="label">Distance${f.isVirtual ? ' (approx.)' : ''}</div><div class="value">${f.distanceKm ? f.distanceKm + ' km' : '—'}</div></div>
      <div class="stat-tile"><div class="label">Vitesse moyenne</div><div class="value">${avgSpeedKmh ? avgSpeedKmh + ' km/h' : '—'}</div></div>
      <div class="stat-tile"><div class="label">Altitude max</div><div class="value">${f.maxAltitude ? f.maxAltitude.toLocaleString('fr-FR') + ' ft' : '—'}</div></div>
      ${f.fuelBurnGallons != null ? `<div class="stat-tile"><div class="label">Carburant (plan de vol)</div><div class="value">${f.fuelBurnGallons.toLocaleString('fr-FR')} gal</div></div>` : ''}
      ${co2Tonnes != null ? `<div class="stat-tile"><div class="label">CO&#8322; estimé</div><div class="value">${co2Tonnes.toLocaleString('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} t</div></div>` : ''}
    </div>

    ${(f.points && f.points.length >= 2) ? '<canvas id="alt-chart"></canvas>' : ''}

    <div class="info-list">
      ${infoRow('Appareil', f.aircraftType)}
      ${registration ? infoRowLink('Immatriculation', registration, '#/aircraft/' + encodeURIComponent(registration)) : ''}
      ${infoRow('Indicatif', f.callsign)}
      ${infoRow('Cabine', n?.cabin)}
      ${infoRow('Siège', n?.seats && n?.seatType ? `${n.seats} · ${n.seatType}` : (n?.seats || n?.seatType))}
      ${infoRow('Bloc prévu / réel', (n?.scheduledBlockTime || n?.actualBlockTime) ? `${n.scheduledBlockTime || '—'} / ${n.actualBlockTime || '—'}` : null)}
      ${infoRow('Vitesse max', f.maxSpeed ? f.maxSpeed + ' kt' : null)}
      ${infoRow('Fichier source', f.sourceFile)}
    </div>
  `;

  document.getElementById('back-btn').addEventListener('click', () => navigate('#/flights'));

  if (flightPlanBlob) {
    const toggleBtn = document.getElementById('flightplan-toggle');
    const viewer = document.getElementById('flightplan-viewer');
    const frame = document.getElementById('flightplan-frame');
    const label = `Plan de vol${n.flightPlanName ? ' · ' + escapeHtml(n.flightPlanName) : ''}`;
    toggleBtn.addEventListener('click', () => {
      const opening = viewer.hidden;
      viewer.hidden = !opening;
      toggleBtn.innerHTML = opening ? '&#128196; Masquer le plan de vol' : `&#128196; ${label}`;
      // Le blob PDF n'est chargé dans l'iframe qu'à la première ouverture,
      // pas au rendu de la page : pas de coût pour les vols qu'on ne consulte
      // jamais.
      if (opening && !frame.src) {
        flightPlanObjectUrl = URL.createObjectURL(flightPlanBlob);
        // #view=FitH (paramètre PDF Open standard, supporté par le
        // visualiseur PDF de WebKit) : sans ça, le visualiseur PDF intégré
        // d'iOS affiche parfois la page à sa largeur native au lieu de
        // l'ajuster à l'iframe, ce qui force un défilement horizontal et
        // perturbe la navigation entre pages.
        frame.src = flightPlanObjectUrl + '#view=FitH';
      }
    });
  }

  if (photos.length) {
    const track = document.getElementById('aircraft-photo-track');
    track.querySelectorAll('img').forEach((img) => {
      const p = photos[Number(img.dataset.idx)];
      // Écouteur posé avant d'assigner src : si le chargement échoue (hors
      // ligne, lien mort, format non supporté par le navigateur...) on
      // bascule sur le texte de repli pour cette photo, sans affecter les
      // autres photos de la galerie.
      img.addEventListener('error', () => {
        img.closest('.aircraft-photo-slide')?.classList.add('is-fallback');
      });
      if (p.kind === 'personal') {
        const url = URL.createObjectURL(p.blob);
        flightPhotoObjectUrls.push(url);
        img.src = url;
      } else {
        img.src = p.url;
      }
    });
  }

  if (photos.length > 1) {
    const track = document.getElementById('aircraft-photo-track');
    const dots = [...document.getElementById('aircraft-photo-dots').querySelectorAll('.dot')];
    const countEl = document.getElementById('aircraft-photo-count');
    const setActive = (idx) => {
      dots.forEach((d, i) => d.classList.toggle('active', i === idx));
      countEl.textContent = `${idx + 1}/${photos.length}`;
    };
    dots.forEach((dot) => {
      dot.addEventListener('click', () => {
        track.scrollTo({ left: Number(dot.dataset.idx) * track.clientWidth, behavior: 'smooth' });
      });
    });
    let scrollTimeout;
    track.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        setActive(Math.round(track.scrollLeft / track.clientWidth));
      }, 60);
    });
  }

  if (hasRealTrack) {
    mapInstance = createMap('flight-map');
    const line = drawFlightPath(mapInstance, f);
    fitToLayers(mapInstance, [line]);

    const drawAlt = f.points.some((p) => p.alt != null)
      ? setupAltitudeChart(document.getElementById('alt-chart'), f.points)
      : null;

    const planeMarker = createPlaneMarker(mapInstance);
    const playBtn = document.getElementById('replay-play');
    const seekEl = document.getElementById('replay-seek');
    const timeEl = document.getElementById('replay-time');
    const speedBtns = [...document.querySelectorAll('#replay-speeds button')];

    currentReplay = createFlightReplay(f.points, {
      speed: 300,
      onFrame: (pose, { playing }) => {
        planeMarker.setPose(pose.lat, pose.lon, pose.bearingDeg);
        if (drawAlt) drawAlt(pose.progress);
        seekEl.value = String(Math.round(pose.progress * 1000));
        playBtn.innerHTML = playing ? '&#10074;&#10074;' : '&#9654;';
        timeEl.textContent = pose.tMs != null ? fmtHM(pose.tMs) : `${Math.round(pose.progress * 100)}%`;
      },
    });

    playBtn.addEventListener('click', () => currentReplay.toggle());
    seekEl.addEventListener('input', () => currentReplay.seek(Number(seekEl.value) / 1000));
    speedBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        speedBtns.forEach((b) => b.classList.toggle('active', b === btn));
        currentReplay.setSpeed(Number(btn.dataset.speed));
      });
    });
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

// ---------- Statistiques ----------

// Regroupe et compte les occurrences par clé (triées desc). `includeUnknown`
// contrôle si les vols sans valeur pour cette clé rejoignent un panier
// "Inconnu(e)" (utile pour voir la complétude des données, ex: compagnies)
// ou sont simplement ignorés (utile pour des stats "réelles", ex: pistes).
function countBy(items, keyFn, { includeUnknown = true } = {}) {
  const map = new Map();
  for (const item of items) {
    const raw = keyFn(item);
    if (!raw) {
      if (!includeUnknown) continue;
      map.set('Inconnu(e)', (map.get('Inconnu(e)') || 0) + 1);
      continue;
    }
    map.set(raw, (map.get(raw) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function avgByGroup(items, keyFn, valueFn) {
  const sums = new Map();
  for (const item of items) {
    const key = keyFn(item) || 'Inconnu(e)';
    const v = valueFn(item);
    if (v == null) continue;
    const cur = sums.get(key) || { sum: 0, n: 0 };
    cur.sum += v;
    cur.n += 1;
    sums.set(key, cur);
  }
  return [...sums.entries()].map(([k, { sum, n }]) => [k, sum / n]).sort((a, b) => b[1] - a[1]);
}

// Couleur de statut (bonne/moyenne/mauvaise) reprise du vocabulaire retard
// déjà utilisé partout ailleurs dans l'app — jamais une teinte catégorielle
// arbitraire, toujours la même sémantique good/warn/bad.
function delayBarColor(min) {
  const info = delayInfo(min);
  if (!info) return 'var(--accent)';
  return info.cls === 'good' ? 'var(--accent-2)' : info.cls === 'warn' ? 'var(--warn)' : 'var(--danger)';
}

// Mini bar chart horizontal en HTML/CSS pur : une seule série par graphique
// (pas de légende nécessaire, cf. dataviz), valeur toujours affichée en
// clair au bout de la barre (jamais la couleur seule qui porte l'info).
// Au-delà de `limit`, les lignes restent dans le DOM mais cachées ; un clic
// sur "+ N autres" les déplie (cf. wireBarChartToggles, à appeler après
// insertion dans le document).
function barChartHtml(rows, { formatValue, colorFor, limit, rowHref } = {}) {
  if (rows.length === 0) return '<p class="stats-empty">Pas assez de données.</p>';
  const maxVal = Math.max(...rows.map(([, v]) => Math.abs(v)), 1);
  const renderRow = ([label, value]) => {
    const pct = Math.min(100, (Math.abs(value) / maxVal) * 100);
    const color = colorFor ? colorFor(value) : 'var(--accent)';
    const valueStr = formatValue ? formatValue(value) : String(value);
    const href = rowHref ? rowHref(label) : null;
    const tag = href ? 'a' : 'div';
    const hrefAttr = href ? ` href="${escapeHtml(href)}"` : '';
    return `
      <${tag} class="bar-row${href ? ' bar-row-link' : ''}"${hrefAttr}>
        <div class="bar-label">${escapeHtml(label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%; background:${color};"></div></div>
        <div class="bar-value">${escapeHtml(valueStr)}</div>
      </${tag}>`;
  };

  const truncated = limit && rows.length > limit;
  const visible = truncated ? rows.slice(0, limit) : rows;
  const extra = truncated ? rows.slice(limit) : [];
  const moreLabel = `+ ${extra.length} autre${extra.length > 1 ? 's' : ''}`;

  return `
    <div class="bar-chart-wrap">
      <div class="bar-chart">${visible.map(renderRow).join('')}</div>
      ${truncated ? `
        <div class="bar-chart-extra" hidden>${extra.map(renderRow).join('')}</div>
        <button type="button" class="bar-toggle" data-more-label="${escapeHtml(moreLabel)}">${escapeHtml(moreLabel)}</button>
      ` : ''}
    </div>`;
}

// À appeler après avoir inséré du HTML contenant des barChartHtml() tronqués
// (limit) : câble le clic sur "+ N autres" pour déplier/replier les lignes
// cachées, sans avoir à re-générer le graphique.
function wireBarChartToggles(root) {
  root.querySelectorAll('.bar-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const extra = btn.previousElementSibling;
      const willShow = extra.hidden;
      extra.hidden = !willShow;
      btn.textContent = willShow ? 'Afficher moins' : btn.dataset.moreLabel;
    });
  });
}

function availableStatsYears(allFlights) {
  const years = new Set();
  for (const f of allFlights) {
    if (f.date) years.add(f.date.slice(0, 4));
  }
  return [...years].sort().reverse();
}

function fmtTotalHours(totalMin) {
  if (!totalMin) return '—';
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  return `${h.toLocaleString('fr-FR')} h ${String(m).padStart(2, '0')}`;
}

function renderStats() {
  headerTitle.textContent = 'Statistiques';
  const allFlights = buildDisplayFlights();
  const years = availableStatsYears(allFlights);
  const flights = statsYear === 'all' ? allFlights : allFlights.filter((f) => f.date && f.date.startsWith(statsYear));

  viewRoot.innerHTML = `
    <div class="stats-filters">
      <div class="segmented" id="stats-tabs">
        <button type="button" data-view="flights" class="${statsSubView === 'flights' ? 'active' : ''}">Vols</button>
        <button type="button" data-view="airports" class="${statsSubView === 'airports' ? 'active' : ''}">Aéroports</button>
        <button type="button" data-view="world" class="${statsSubView === 'world' ? 'active' : ''}">Monde</button>
      </div>
      <select id="stats-year">
        <option value="all" ${statsYear === 'all' ? 'selected' : ''}>Toutes les années</option>
        ${years.map((y) => `<option value="${y}" ${statsYear === y ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
    </div>
    <div id="stats-content"></div>
  `;

  document.getElementById('stats-tabs').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (statsSubView === btn.dataset.view) return;
      statsSubView = btn.dataset.view;
      renderStats();
    });
  });
  document.getElementById('stats-year').addEventListener('change', (e) => {
    statsYear = e.target.value;
    renderStats();
  });

  const content = document.getElementById('stats-content');
  if (flights.length === 0) {
    content.innerHTML = `<div class="empty-state"><span class="big-emoji">📊</span><div>Aucun vol pour cette période.</div></div>`;
    return;
  }
  if (statsSubView === 'airports') renderAirportStats(content, flights);
  else if (statsSubView === 'world') renderWorldStats(content, flights);
  else renderFlightStats(content, flights);
}

// Pays/continents effectivement traversés par cette sélection de vols
// (départ ou arrivée), regroupés par continent — base commune à la tuile
// "Repères" et à l'Atlas de vol (Stats > Monde).
function visitedGeo(flights) {
  const byContinent = new Map(); // continent -> Set<pays>
  for (const f of flights) {
    for (const iata of [f.depIata, f.arrIata]) {
      const country = resolveAirport(iata)?.country;
      if (!country) continue;
      const continent = continentFor(country) || 'Autre';
      if (!byContinent.has(continent)) byContinent.set(continent, new Set());
      byContinent.get(continent).add(country);
    }
  }
  const countries = new Set([...byContinent.values()].flatMap((s) => [...s]));
  return { countries, continents: new Set(byContinent.keys()), byContinent };
}

// Jalons perso (pays/continents visités, appareil favori, vol le plus
// long/court) : tout est déjà dérivable des vols affichés + du référentiel
// aéroports, aucune donnée supplémentaire à importer.
function renderMilestones(flights) {
  const { countries, continents } = visitedGeo(flights);

  const [topAircraftType, topAircraftCount] = countBy(flights, (f) => f.aircraftType, { includeUnknown: false })[0] || [];

  let longest = null, shortest = null;
  for (const f of flights) {
    if (f.distanceKm == null) continue;
    if (!longest || f.distanceKm > longest.distanceKm) longest = f;
    if (!shortest || f.distanceKm < shortest.distanceKm) shortest = f;
  }
  const routeTile = (f, label) => f ? `
    <a class="stat-tile" href="#/flight/${encodeURIComponent(f.id)}">
      <div class="label">${label}</div>
      <div class="value">${escapeHtml(f.depIata || '???')} → ${escapeHtml(f.arrIata || '???')}</div>
      <div class="label">${f.distanceKm.toLocaleString('fr-FR')} km</div>
    </a>` : '';

  return `
    <div class="chart-card">
      <h3>Repères</h3>
      <div class="stat-grid">
        <div class="stat-tile"><div class="label">Pays visités</div><div class="value">${countries.size}</div></div>
        <div class="stat-tile"><div class="label">Continents visités</div><div class="value">${continents.size}</div></div>
        ${topAircraftType ? `<div class="stat-tile"><div class="label">Appareil favori</div><div class="value">${escapeHtml(topAircraftType)}</div><div class="label">${topAircraftCount} vol(s)</div></div>` : ''}
        ${routeTile(longest, 'Vol le plus long')}
        ${routeTile(shortest, 'Vol le plus court')}
      </div>
    </div>`;
}

function renderFlightStats(content, flights) {
  const totalMin = flights.reduce((sum, f) => {
    if (!f.startTime || !f.endTime) return sum;
    const ms = new Date(f.endTime) - new Date(f.startTime);
    return isFinite(ms) && ms > 0 ? sum + ms / 60000 : sum;
  }, 0);

  const byAirline = countBy(flights, (f) => f.airline);
  const delayByAirline = avgByGroup(flights, (f) => f.airline, (f) => {
    const { depDelayMin, arrDelayMin } = flightDelays(f);
    return arrDelayMin ?? depDelayMin;
  });
  const byAircraftType = countBy(flights, (f) => f.aircraftType);
  const byRegistration = countBy(flights, (f) => f.registration || nFor(f)?.registration);

  content.innerHTML = `
    <div class="stat-grid">
      <div class="stat-tile"><div class="label">Vols</div><div class="value">${flights.length}</div></div>
      <div class="stat-tile"><div class="label">Temps de vol total</div><div class="value">${fmtTotalHours(totalMin)}</div></div>
    </div>

    ${renderMilestones(flights)}

    <div class="chart-card">
      <h3>Retard moyen (arrivée) par compagnie</h3>
      ${barChartHtml(delayByAirline, { formatValue: fmtSignedDelay, colorFor: delayBarColor })}
    </div>

    <div class="chart-card">
      <h3>Vols par compagnie</h3>
      ${barChartHtml(byAirline)}
    </div>

    <div class="chart-card">
      <h3>Vols par type d'avion</h3>
      ${barChartHtml(byAircraftType)}
    </div>

    <div class="chart-card">
      <h3>Vols par immatriculation</h3>
      ${barChartHtml(byRegistration, { limit: 12, rowHref: (reg) => reg === 'Inconnu(e)' ? null : '#/aircraft/' + encodeURIComponent(reg) })}
    </div>
  `;
  wireBarChartToggles(content);
}

function renderAirportStats(content, flights) {
  const idx = new Map(); // code -> { dep: [flights...], arr: [flights...] }
  for (const f of flights) {
    if (f.depIata) {
      if (!idx.has(f.depIata)) idx.set(f.depIata, { dep: [], arr: [] });
      idx.get(f.depIata).dep.push(f);
    }
    if (f.arrIata) {
      if (!idx.has(f.arrIata)) idx.set(f.arrIata, { dep: [], arr: [] });
      idx.get(f.arrIata).arr.push(f);
    }
  }

  const totals = [...idx.entries()]
    .map(([code, { dep, arr }]) => [code, dep.length + arr.length])
    .sort((a, b) => b[1] - a[1]);

  if (!selectedAirport || !idx.has(selectedAirport)) {
    selectedAirport = totals.length ? totals[0][0] : null;
  }

  const airportOptions = totals.map(([code]) => {
    const a = resolveAirport(code);
    const label = a ? `${code} · ${a.city}` : code;
    return `<option value="${escapeHtml(code)}" ${code === selectedAirport ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');

  content.innerHTML = `
    <div class="chart-card">
      <h3>Vols par aéroport</h3>
      ${barChartHtml(totals, { limit: 15 })}
    </div>

    ${selectedAirport ? `
    <div class="airport-picker">
      <label class="k" for="airport-select">Détail par aéroport</label>
      <select id="airport-select">${airportOptions}</select>
    </div>
    <div id="airport-detail"></div>
    ` : ''}
  `;
  wireBarChartToggles(content);

  if (selectedAirport) {
    document.getElementById('airport-select').addEventListener('change', (e) => {
      selectedAirport = e.target.value;
      renderAirportStats(content, flights);
    });
    renderAirportDetail(document.getElementById('airport-detail'), idx.get(selectedAirport), selectedAirport);
  }
}

function renderAirportDetail(el, { dep, arr }, code) {
  const a = resolveAirport(code);
  const runwayDep = countBy(dep, (f) => f.depRunway || nFor(f)?.depRunway, { includeUnknown: false });
  const runwayArr = countBy(arr, (f) => f.arrRunway || nFor(f)?.arrRunway, { includeUnknown: false });
  const gates = countBy(dep, (f) => f.depGate || nFor(f)?.depGate, { includeUnknown: false });

  const taxiValues = dep
    .map((f) => Number(nFor(f)?.departureTaxiTime))
    .filter((v) => Number.isFinite(v) && v > 0);
  const taxiAvg = taxiValues.length ? taxiValues.reduce((s, v) => s + v, 0) / taxiValues.length : null;

  el.innerHTML = `
    <div class="airport-title">${escapeHtml(a?.city || code)}</div>
    <div class="airport-sub">${escapeHtml(code)}${a?.name ? ' · ' + escapeHtml(a.name) : ''}</div>

    <div class="stat-grid">
      <div class="stat-tile"><div class="label">Départs</div><div class="value">${dep.length}</div></div>
      <div class="stat-tile"><div class="label">Arrivées</div><div class="value">${arr.length}</div></div>
      <div class="stat-tile"><div class="label">Total</div><div class="value">${dep.length + arr.length}</div></div>
      <div class="stat-tile"><div class="label">Taxi moyen (départ)</div><div class="value">${taxiAvg != null ? Math.round(taxiAvg) + ' min' : '—'}</div></div>
    </div>

    <div class="chart-card">
      <h3>Pistes de décollage</h3>
      ${barChartHtml(runwayDep)}
    </div>
    <div class="chart-card">
      <h3>Pistes d'atterrissage</h3>
      ${barChartHtml(runwayArr)}
    </div>
    <div class="chart-card">
      <h3>Portes d'embarquement</h3>
      ${barChartHtml(gates)}
    </div>
  `;
  wireBarChartToggles(el);
}

const CONTINENT_ORDER = ['Europe', 'Amérique du Nord', 'Amérique du Sud', 'Asie', 'Afrique', 'Océanie', 'Autre'];

// Atlas de vol : carte du monde avec les pays traversés (départ/arrivée) par
// la sélection de vols en cours, en surbrillance. Fond de carte + tracés
// embarqués (worldGeo.js, dérivés de Natural Earth) pour rester hors-ligne.
// Les pays visités trop petits pour un tracé à cette résolution (micro-États)
// sont affichés en pastille, positionnée via les coordonnées de leurs
// aéroports (airports.js).
function renderWorldStats(content, flights) {
  const { countries, continents, byContinent } = visitedGeo(flights);

  const shapes = [];
  for (const country of countries) {
    const path = VISITED_COUNTRY_PATHS[country];
    if (path) {
      shapes.push(`<path class="wm-visited" data-name="${escapeHtml(country)}" tabindex="0" d="${path}"/>`);
      continue;
    }
    const coord = averageCoordFor(country);
    if (!coord) continue;
    const [x, y] = projectLonLat(coord[1], coord[0]);
    shapes.push(`<g class="wm-pin" data-name="${escapeHtml(country)}" tabindex="0" transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><circle r="4"/></g>`);
  }

  const indexHtml = CONTINENT_ORDER
    .filter((c) => byContinent.has(c))
    .map((continent) => {
      const list = [...byContinent.get(continent)].sort((a, b) => a.localeCompare(b, 'fr'));
      return `
        <div class="wm-cont">
          <h3>${escapeHtml(continent)}<span class="count">${list.length}</span></h3>
          <ul>${list.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        </div>`;
    }).join('');

  content.innerHTML = `
    <div class="stat-grid">
      <div class="stat-tile"><div class="label">Pays visités</div><div class="value">${countries.size}</div></div>
      <div class="stat-tile"><div class="label">Continents</div><div class="value">${continents.size}</div></div>
    </div>

    <div class="worldmap-card">
      <div class="worldmap-readout">
        <span class="name empty" id="wm-readout">Survolez un pays</span>
      </div>
      <svg id="wm-svg" viewBox="${WORLD_VIEWBOX}" role="img" aria-label="Carte du monde avec les pays visités en surbrillance">
        <g class="wm-lands">${WORLD_LAND_SVG}</g>
        <g class="wm-visited-layer">${shapes.join('')}</g>
      </svg>
      <div class="worldmap-legend">
        <span><i class="visited-sw"></i>Pays visité</span>
        <span><i class="land-sw"></i>Non visité</span>
        <span><i class="pin-sw"></i>Micro-État (hors échelle)</span>
      </div>
    </div>

    <div class="worldmap-index">${indexHtml}</div>
  `;

  const readout = document.getElementById('wm-readout');
  const setReadout = (name) => {
    if (name) { readout.textContent = name; readout.classList.remove('empty'); }
    else { readout.textContent = 'Survolez un pays'; readout.classList.add('empty'); }
  };
  content.querySelectorAll('.wm-visited, .wm-pin').forEach((el) => {
    const name = el.getAttribute('data-name');
    el.addEventListener('pointerenter', () => setReadout(name));
    el.addEventListener('pointerleave', () => setReadout(null));
    el.addEventListener('focus', () => setReadout(name));
    el.addEventListener('blur', () => setReadout(null));
  });
}

// Fiche avion : accessible depuis une immatriculation cliquée n'importe où
// dans l'app (détail de vol, stats). Regroupe tous les vols enregistrés pour
// cette immatriculation, toutes sources confondues (KML/JSON + Notion).
function renderAircraftDetail(registration) {
  const norm = (registration || '').trim();
  headerTitle.textContent = norm || 'Avion';

  const matched = buildDisplayFlights()
    .filter((f) => ((f.registration || nFor(f)?.registration || '').trim()) === norm)
    .sort(flightSortCompare); // plus récent en premier

  if (!norm || matched.length === 0) {
    viewRoot.innerHTML = `<button class="back-btn" id="back-btn">&#8249; Retour</button><div class="empty-state">Avion introuvable.</div>`;
    document.getElementById('back-btn').addEventListener('click', () => history.back());
    return;
  }

  const aircraftType = matched.map((f) => f.aircraftType).find((t) => t) || null;
  const firstFlight = matched[matched.length - 1];
  const lastFlight = matched[0];

  viewRoot.innerHTML = `
    <button class="back-btn" id="back-btn">&#8249; Retour</button>
    <div class="airport-title">${escapeHtml(norm)}</div>
    <div class="airport-sub">${aircraftType ? escapeHtml(aircraftType) : "Type d'avion inconnu"}</div>

    <div class="stat-grid">
      <div class="stat-tile"><div class="label">Vols</div><div class="value">${matched.length}</div></div>
      <div class="stat-tile"><div class="label">Premier vol</div><div class="value">${firstFlight.date ? fmtDate(firstFlight.date) : '—'}</div></div>
      <div class="stat-tile"><div class="label">Dernier vol</div><div class="value">${lastFlight.date ? fmtDate(lastFlight.date) : '—'}</div></div>
    </div>

    <div id="aircraft-flights"></div>
  `;

  document.getElementById('back-btn').addEventListener('click', () => history.back());

  const listEl = document.getElementById('aircraft-flights');
  listEl.innerHTML = flightListHtml(matched);
  wireFlightCards(listEl);
}

async function renderSettings() {
  headerTitle.textContent = 'Réglages';
  const lastImport = await db.getMeta('lastImport');
  const folderName = await db.getMeta('folderName');

  viewRoot.innerHTML = `
    <div class="settings-section">
      <h2>Dossier de données</h2>
      <div class="settings-card">
        <div class="settings-row"><span class="k">Dossier</span><span>${folderName ? escapeHtml(folderName) : 'Non défini'}</span></div>
        <div class="settings-row"><span class="k">Dernier import</span><span>${lastImport ? new Date(lastImport).toLocaleString('fr-FR') : 'Jamais'}</span></div>
        <div class="settings-row"><span class="k">Traces de vol</span><span>${flights.length}</span></div>
        <div class="settings-row"><span class="k">Vols enrichis (Notion)</span><span>${notionByKey.size}</span></div>
        <div class="settings-actions">
          <button class="primary" id="pick-folder-btn">Choisir le dossier</button>
          <button class="secondary" id="pick-files-btn">Choisir des fichiers</button>
          <button class="secondary" id="refresh-btn">Rafraîchir (efface et réimporte tout)</button>
        </div>
        <p style="margin:10px 0 0; font-size:12px; color:var(--text-dim); line-height:1.4;">
          Choisis directement ton dossier FlighTim (ou tout dossier parent) : l'app scanne récursivement
          tous les sous-dossiers et récupère elle-même les .kml (FlightRadar24), les .json (FlightAware)
          et les exports Notion "Flight History" (··· → Export), au format CSV comme HTML — le reste (PDF,
          tableurs, etc.) est ignoré. Le rapprochement KML/JSON ↔ Notion se fait par numéro de vol + date.
          Avec un export Notion au format HTML, les notes et photos que tu as ajoutées à un vol sont
          récupérées automatiquement et affichées sur sa page de détail.
          "Rafraîchir" vide d'abord toutes les données locales puis réimporte depuis le dossier que tu
          choisis ensuite — utile si des fichiers source ont été modifiés ou supprimés depuis le dernier
          import (un import normal ignore les fichiers inchangés et ne détecte pas les suppressions).
          Sur iOS, il arrive qu'un bouton ne réponde pas du tout au premier essai (bug connu de Safari
          avec les sélecteurs de fichiers) — réessaie une seconde fois, ou utilise l'autre bouton. "Choisir
          des fichiers" demande de sélectionner tous les fichiers du dossier à la main (⌘A / tout
          sélectionner dans l'app Fichiers) plutôt que le dossier lui-même.
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
          FlighTim lit vos exports .kml (FlightRadar24), .json (FlightAware) et vos exports CSV Notion
          directement dans votre navigateur — aucune donnée n'est envoyée à un serveur. Les fichiers sont
          lus localement, puis stockés sur cet appareil pour un accès hors-ligne.
        </p>
        <div class="settings-actions" style="margin-top:12px;">
          <button class="secondary" id="reload-app-btn">Recharger l'app</button>
        </div>
        <p style="margin:10px 0 0; font-size:12px; color:var(--text-dim);">Version ${escapeHtml(APP_VERSION)}</p>
      </div>
    </div>
  `;

  document.getElementById('reload-app-btn').addEventListener('click', async () => {
    // Utile en mode standalone (icône écran d'accueil) : pas de barre
    // d'adresse ni de bouton "recharger" natif si l'app se fige. On
    // désinscrit le service worker et on vide tous les caches avant de
    // recharger — un simple reg.update() + reload() n'offrait aucune
    // garantie sur le moment où la nouvelle version prend effectivement le
    // relais, ce qui pouvait laisser l'appareil bloqué sur une vieille
    // version malgré le bouton.
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = (await window.caches?.keys?.()) ?? [];
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (err) {
      console.warn('Reset avant rechargement échoué', err);
    }
    location.reload();
  });
  document.getElementById('pick-folder-btn').addEventListener('click', () => {
    pendingRefresh = false;
    pickFiles({ directory: true });
  });
  document.getElementById('pick-files-btn').addEventListener('click', () => {
    pendingRefresh = false;
    pickFiles({ directory: false });
  });
  document.getElementById('refresh-btn').addEventListener('click', () => {
    if (!confirm('Effacer toutes les données locales puis tout réimporter depuis le dossier que tu vas choisir ?')) return;
    pendingRefresh = true;
    pickFiles({ directory: true });
  });
  document.getElementById('clear-btn').addEventListener('click', async () => {
    if (!confirm('Supprimer tous les vols et données Notion importés sur cet appareil ?')) return;
    await db.clearFlights();
    await db.clearNotionFlights();
    await db.setFlightFileStamps({});
    await db.setMeta('lastImport', null);
    await db.setMeta('folderName', null);
    flights = [];
    notionByKey = new Map();
    showToast('Données effacées');
    renderSettings();
  });
}

// ---------- Import ----------

// Partagé par les deux sélecteurs (dossier via webkitdirectory, ou fichiers
// à plat) : sur iOS Safari, le picker "dossier" ne répond parfois pas du
// tout (bug connu avec les dossiers iCloud Drive, l'event change ne part
// jamais) — #files-input sert alors de repli fiable, cf Réglages.
async function handleFileSelection(allFiles) {
  const isRefresh = pendingRefresh;
  pendingRefresh = false;

  let traceFiles = allFiles.filter((f) => /\.(kml|json)$/i.test(f.name));
  const csvFiles = allFiles.filter((f) => /\.csv$/i.test(f.name));
  // Pages individuelles d'un export Notion "HTML & Markdown" (une par ligne
  // "Flight History" ayant une note et/ou une photo) : enrichissement
  // optionnel, cf. notionHtmlParser.js. Un export complet contient aussi des
  // centaines de fiches Aircraft/Airports (même motif .html, jamais de
  // propriété Date) : on les exclut ici via le sous-dossier plutôt que de
  // payer une lecture + un DOMParser pour chacune avant de les jeter.
  const notionPageFiles = allFiles.filter((f) => {
    if (!/\.html?$/i.test(f.name)) return false;
    const relPath = f.webkitRelativePath || '';
    return !relPath || /\/Flight History\//i.test(relPath);
  });

  if (traceFiles.length === 0 && csvFiles.length === 0 && notionPageFiles.length === 0) {
    showToast('Aucun fichier .kml, .json, .csv ou .html trouvé dans ce dossier');
    return;
  }

  // "Rafraîchir" : on ne vide les données locales qu'une fois qu'on sait que
  // l'utilisateur a effectivement choisi un dossier avec des fichiers
  // exploitables — jamais avant, pour ne rien perdre si le sélecteur est
  // annulé ou pointe sur un mauvais dossier.
  if (isRefresh) {
    await db.clearFlights();
    await db.clearNotionFlights();
    await db.setFlightFileStamps({});
    flights = [];
    notionByKey = new Map();
  }

  showToast(`Import de ${traceFiles.length + csvFiles.length + notionPageFiles.length} fichier(s)…`, 60000);

  // --- Traces de vol (.kml / .json) ---
  const stamps = await db.getFlightFileStamps();
  const newStamps = { ...stamps };
  const toStore = [];
  let flightsSkipped = 0, flightsErrors = 0;

  for (const file of traceFiles) {
    const stampKey = file.webkitRelativePath || file.name;
    const prevStamp = stamps[stampKey];
    if (prevStamp && prevStamp.size === file.size && prevStamp.lastModified === file.lastModified) {
      flightsSkipped++;
      continue;
    }
    try {
      const text = await file.text();
      const parsed = /\.json$/i.test(file.name)
        ? parseFlightAwareJSON(text, file.name)
        : parseKML(text, file.name);
      toStore.push(parsed);
      newStamps[stampKey] = { size: file.size, lastModified: file.lastModified };
    } catch (err) {
      console.error(err);
      flightsErrors++;
    }
  }

  if (toStore.length) {
    // Le raccourci FlightAware peut exporter le .kml (pauvre) et le .json
    // (riche) d'un même vol sous des noms de fichiers différents (le .json
    // inclut la date, pas le .kml) : on ne peut donc pas dédupliquer sur le
    // nom de fichier. On identifie plutôt les vols en double par numéro de
    // vol + date (comme pour Notion, cf. notionKeyFor) et on ne garde que
    // l'entrée FlightAware JSON, y compris si l'autre a été importée lors
    // d'une session précédente.
    const traceKeyFor = (f) => `${(f.flightNumber || '').toUpperCase()}|${f.date || ''}`;
    const allCandidates = [...flights, ...toStore];
    const richKeys = new Set(
      allCandidates.filter((f) => f.source === 'flightaware-json').map(traceKeyFor)
    );
    const idsToDrop = new Set(
      allCandidates
        .filter((f) => f.source !== 'flightaware-json' && richKeys.has(traceKeyFor(f)))
        .map((f) => f.id)
    );

    const filteredToStore = toStore.filter((f) => !idsToDrop.has(f.id));
    if (idsToDrop.size) await db.deleteFlights(idsToDrop);
    if (filteredToStore.length) await db.putFlights(filteredToStore);

    flights = flights.filter((f) => !idsToDrop.has(f.id));
    for (const f of filteredToStore) {
      const idx = flights.findIndex((x) => x.id === f.id);
      if (idx >= 0) flights[idx] = f; else flights.push(f);
    }
    flights.sort(flightSortCompare);
  }
  await db.setFlightFileStamps(newStamps);

  // --- Détails de vol (.csv Notion) ---
  const allRecords = [];
  let csvIgnored = 0, csvErrors = 0;

  for (const file of csvFiles) {
    try {
      const text = await file.text();
      const records = parseNotionCSV(text, file.name);
      if (records === null) { csvIgnored++; continue; }
      allRecords.push(...records);
    } catch (err) {
      console.error(err);
      csvErrors++;
    }
  }

  for (const r of allRecords) notionByKey.set(r.key, r);

  // --- Notes + photos (.html Notion, export "Export as HTML") ---
  // On enrichit directement les objets déjà dans notionByKey (ceux tout
  // juste parsés ci-dessus, ou déjà en base depuis un import précédent) :
  // une page HTML n'a de sens que si sa ligne "Flight History" (CSV) existe
  // quelque part, ce qui est toujours le cas puisque les deux proviennent du
  // même export.
  const filesByRelPath = new Map(allFiles.map((f) => [f.webkitRelativePath || f.name, f]));
  const touchedKeys = new Set();
  let notesFound = 0, photosFound = 0, flightPlansFound = 0;

  for (const file of notionPageFiles) {
    try {
      const text = await file.text();
      const parsed = parseNotionFlightPage(text, file.name);
      if (!parsed) continue;
      const record = notionByKey.get(parsed.key);
      if (!record) continue; // ligne CSV correspondante absente de cet import

      if (parsed.notes) { record.notes = parsed.notes; notesFound++; }
      if (parsed.photoPaths.length) {
        const basePath = file.webkitRelativePath || file.name;
        const photoFiles = parsed.photoPaths
          .map((relPath) => filesByRelPath.get(resolveRelativePath(basePath, relPath)))
          .filter(Boolean);
        if (photoFiles.length) { record.photoBlobs = photoFiles; delete record.photoBlob; photosFound++; }
      }
      if (parsed.flightPlanPath) {
        const basePath = file.webkitRelativePath || file.name;
        const flightPlanFile = filesByRelPath.get(resolveRelativePath(basePath, parsed.flightPlanPath));
        if (flightPlanFile) {
          record.flightPlanBlob = flightPlanFile;
          record.flightPlanName = parsed.flightPlanName || flightPlanFile.name;
          flightPlansFound++;
        }
      }
      touchedKeys.add(parsed.key);
    } catch (err) {
      console.error(err);
    }
  }

  const recordsToPersist = new Map(allRecords.map((r) => [r.key, r]));
  for (const key of touchedKeys) recordsToPersist.set(key, notionByKey.get(key));
  if (recordsToPersist.size) await db.putNotionFlights([...recordsToPersist.values()]);

  await db.setMeta('lastImport', Date.now());
  const root = allFiles[0]?.webkitRelativePath ? allFiles[0].webkitRelativePath.split('/')[0] : null;
  if (root) await db.setMeta('folderName', root);

  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const summary = [];
  if (traceFiles.length) {
    summary.push(`${toStore.length} vol(s) · ${flightsSkipped} inchangé(s)${flightsErrors ? ' · ' + flightsErrors + ' erreur(s)' : ''}`);
  }
  if (csvFiles.length) {
    summary.push(`${allRecords.length} ligne(s) Notion${csvIgnored ? ' · ' + csvIgnored + ' fichier(s) ignoré(s)' : ''}${csvErrors ? ' · ' + csvErrors + ' erreur(s)' : ''}`);
  }
  if (notesFound || photosFound || flightPlansFound) {
    summary.push(`${notesFound} note(s) · ${photosFound} photo(s) · ${flightPlansFound} plan(s) de vol`);
  }
  showToast(summary.join(' — '));
  render();
}

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
