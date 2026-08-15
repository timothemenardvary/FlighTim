// Parse le JSON "trackpollBootstrap" d'une page de suivi FlightAware
// (récupéré via un raccourci qui dump l'objet JS embarqué dans la page, cf
// Réglages). Contrairement au KML basique généré à partir de la même page,
// cette structure donne directement accès aux aéroports complets (IATA/ICAO/
// ville), à l'avion, à la compagnie, à quatre phases horaires (portes de
// départ/arrivée + décollage/atterrissage, chacune en scheduled/estimated/
// actual) et à un point GPS par relevé radar avec vrai horodatage + vitesse
// sol — aucune de ces infos n'est récupérable depuis le KML scrappé.

import { pathDistanceKm, decimate } from './kmlParser.js';

function unixToISO(sec) {
  return sec != null ? new Date(sec * 1000).toISOString() : null;
}

// Les horodatages "actual" ne sont pas toujours renseignés par FlightAware
// (vol pas encore terminé, ou juste non recalé) : on retombe sur estimated
// puis scheduled, dans cet ordre de fiabilité.
function pickTime(...unixSecCandidates) {
  for (const s of unixSecCandidates) {
    if (s != null) return unixToISO(s);
  }
  return null;
}

function cityFromLocation(friendlyLocation) {
  if (!friendlyLocation) return null;
  return friendlyLocation.split(',')[0].trim() || null;
}

function toMs(sec) {
  return sec != null ? sec * 1000 : null;
}

// FlightAware préfixe ses noms de fuseau d'un ":" (ex: ":Europe/Paris") —
// format hérité de l'API POSIX tzset, à retirer avant de passer le nom à Intl.
function cleanTz(tz) {
  return tz ? tz.replace(/^:/, '') : null;
}

export function parseFlightAwareJSON(text, filename) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`JSON invalide : ${filename}`);
  }

  const flightsObj = data?.flights;
  const key = flightsObj ? Object.keys(flightsObj)[0] : null;
  const flight = key ? flightsObj[key] : null;
  if (!flight) {
    throw new Error(`Structure FlightAware inattendue dans ${filename}`);
  }

  const rawPoints = (flight.track || [])
    .filter((p) => Array.isArray(p.coord) && p.coord.length === 2)
    .map((p) => ({
      lat: p.coord[1],
      lon: p.coord[0],
      alt: p.alt != null ? p.alt * 100 : null, // "centaines de pieds" FlightAware -> pieds
      t: p.timestamp != null ? p.timestamp * 1000 : null,
      speed: p.gs ?? null, // déjà en nœuds
      heading: null, // absent du flux ; le replay recalcule un cap entre points consécutifs
    }));
  if (rawPoints.length < 2) {
    throw new Error(`Aucune trace exploitable dans ${filename}`);
  }

  const gateDep = flight.gateDepartureTimes || {};
  const gateArr = flight.gateArrivalTimes || {};
  const takeoff = flight.takeoffTimes || {};
  const landing = flight.landingTimes || {};

  // Temps de "bloc" (portes) pour rester cohérent avec la sémantique de
  // startTime/endTime côté FR24 (STD/ATD, STA/ATA) ; repli sur décollage /
  // premier-dernier point GPS si les portes ne sont pas renseignées.
  const startTime = pickTime(gateDep.actual, gateDep.estimated, gateDep.scheduled, takeoff.actual)
    || (rawPoints[0].t ? new Date(rawPoints[0].t).toISOString() : null);
  const endTime = pickTime(gateArr.actual, gateArr.estimated, gateArr.scheduled, landing.actual)
    || (rawPoints[rawPoints.length - 1].t ? new Date(rawPoints[rawPoints.length - 1].t).toISOString() : null);

  const dateRef = pickTime(takeoff.actual, takeoff.estimated, takeoff.scheduled) || startTime;
  const date = dateRef ? dateRef.slice(0, 10) : null;

  // iataIdent (ex: "AF1801") est la forme utilisée par Notion pour le
  // rapprochement ; ident/displayIdent est souvent la forme ICAO ("AFR1801").
  const flightNumber = (flight.codeShare?.iataIdent || flight.ident || flight.displayIdent || '')
    .toUpperCase() || filename.replace(/\.[^.]+$/, '');
  const callsign = flight.ident || null;

  const maxAltitude = rawPoints.reduce((m, p) => (p.alt != null && p.alt > m ? p.alt : m), 0);
  const maxSpeed = rawPoints.reduce((m, p) => (p.speed != null && p.speed > m ? p.speed : m), 0);

  return {
    id: filename,
    flightNumber,
    callsign,
    airline: flight.airline?.fullName || null,
    aircraftType: flight.aircraft?.friendlyType || flight.aircraft?.type || null,
    registration: flight.aircraft?.tail || null,
    depIata: flight.origin?.iata || null,
    depIcao: flight.origin?.icao || null,
    depName: cityFromLocation(flight.origin?.friendlyLocation),
    arrIata: flight.destination?.iata || null,
    arrIcao: flight.destination?.icao || null,
    arrName: cityFromLocation(flight.destination?.friendlyLocation),
    date,
    startTime,
    endTime,
    // Phases détaillées pour l'affichage Départ/Arrivée : portes et
    // décollage/atterrissage à part (repli sur estimated si actual absent,
    // comme pour startTime/endTime plus haut).
    depGateSchedAt: toMs(gateDep.scheduled),
    depGateActualAt: toMs(gateDep.actual ?? gateDep.estimated),
    depTakeoffSchedAt: toMs(takeoff.scheduled),
    depTakeoffActualAt: toMs(takeoff.actual ?? takeoff.estimated),
    arrGateSchedAt: toMs(gateArr.scheduled),
    arrGateActualAt: toMs(gateArr.actual ?? gateArr.estimated),
    arrLandingSchedAt: toMs(landing.scheduled),
    arrLandingActualAt: toMs(landing.actual ?? landing.estimated),
    depTz: cleanTz(flight.origin?.TZ),
    arrTz: cleanTz(flight.destination?.TZ),
    depGate: flight.origin?.gate || null,
    arrGate: flight.destination?.gate || null,
    depTerminal: flight.origin?.terminal || null,
    arrTerminal: flight.destination?.terminal || null,
    depRunway: flight.runways?.origin || null,
    arrRunway: flight.runways?.destination || null,
    distanceKm: Math.round(pathDistanceKm(rawPoints)),
    maxAltitude: Math.round(maxAltitude),
    maxSpeed: maxSpeed ? Math.round(maxSpeed) : null,
    // Carburant planifié (dispatch, donc trip + réserve + dégagement — pas
    // uniquement le carburant brûlé en vol) : seule donnée dispo pour estimer
    // une empreinte CO2, cf. app.js. Absent des sources KML/Notion.
    fuelBurnGallons: flight.flightPlan?.fuelBurn?.gallons ?? null,
    fuelBurnLbs: flight.flightPlan?.fuelBurn?.pounds ?? null,
    // Photo (contributions utilisateurs FlightAware) : URL externe, chargée
    // à l'affichage seulement — app.js prévoit un repli si hors-ligne.
    photoUrl: flight.relatedThumbnails?.[0]?.thumbnail || null,
    source: 'flightaware-json',
    sourceFile: filename,
    points: decimate(rawPoints),
  };
}
