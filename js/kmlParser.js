// Parses .kml flight-track exports (FlightRadar24 "point track" style and
// FlightAware "line track" style) into a normalized flight object.

const AIRLINES = {
  AF: 'Air France', KL: 'KLM', TO: 'Transavia France', TVF: 'Transavia France',
  EK: 'Emirates', PG: 'Bangkok Airways', TR: 'Scoot', UO: 'Hong Kong Express',
  VN: 'Vietnam Airlines', WY: 'Oman Air', GQ: 'Big Blue Air',
};

function guessAirline(flightNumber) {
  const m = /^([A-Z]{1,3})\d+/.exec(flightNumber || '');
  return m ? AIRLINES[m[1]] || null : null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractLabelTime(html, label) {
  const re = new RegExp(`title="${escapeRegex(label)}">[^<]*</span>\\s*<span title="([^"]+)"`);
  const m = re.exec(html);
  return m ? m[1] : null;
}

function toISOFromUTCString(s) {
  // "2024-06-22 15:55" -> ISO UTC
  if (!s) return null;
  const iso = s.trim().replace(' ', 'T') + ':00Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pathDistanceKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineKm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return total;
}

function decimate(points, maxPoints = 600) {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

function parseFilenameFlightAware(filename) {
  // "AF7322 (AFR7322) Air France Suivi et historique des vols 12-05-2026 (CDG _ LFPG-NCE _ LFMN) - FlightAware.kml"
  const re = /^([A-Za-z]{1,3}\d{1,4})\s*\(([^)]+)\)\s*(.+?)\s+Suivi et historique des vols\s+(\d{2})-(\d{2})-(\d{4})\s*\(([A-Z]{3})\s*_\s*([A-Z0-9]{3,4})-([A-Z]{3})\s*_\s*([A-Z0-9]{3,4})\)/;
  const m = re.exec(filename);
  if (!m) return null;
  const [, flightNumber, callsign, airline, dd, mm, yyyy, depIata, depIcao, arrIata, arrIcao] = m;
  return {
    flightNumber: flightNumber.toUpperCase(),
    callsign,
    airline,
    date: `${yyyy}-${mm}-${dd}`,
    depIata, depIcao, arrIata, arrIcao,
  };
}

function parseFilenameFR24(filename) {
  const m = /^([A-Za-z]{1,3}\d{1,4})[-_][0-9a-f]{6,}\.kml$/i.exec(filename);
  return m ? { flightNumber: m[1].toUpperCase() } : null;
}

function extractFR24Metadata(docDescriptionHtml) {
  if (!docDescriptionHtml) return {};
  const meta = {};
  const depCodeM = /airport\/([a-z0-9]{3,4})\/departures/i.exec(docDescriptionHtml);
  const arrCodeM = /airport\/([a-z0-9]{3,4})\/arrivals/i.exec(docDescriptionHtml);
  if (depCodeM) meta.depIata = depCodeM[1].toUpperCase();
  if (arrCodeM) meta.arrIata = arrCodeM[1].toUpperCase();

  const cityMatches = [...docDescriptionHtml.matchAll(/<h3[^>]*>([A-Za-z0-9]{3,4})<\/h3>\s*([^<]+)</g)];
  if (cityMatches[0]) meta.depName = cityMatches[0][2].trim();
  if (cityMatches[1]) meta.arrName = cityMatches[1][2].trim();

  const aircraftM = /Aircraft[\s\S]*?font-weight: bold;[^"]*">([^<]+)<\/span>/i.exec(docDescriptionHtml);
  if (aircraftM) meta.aircraftType = aircraftM[1].trim();

  const regM = /Registration[\s\S]*?>([A-Z0-9-]{4,8})<\/a>/i.exec(docDescriptionHtml);
  if (regM) meta.registration = regM[1].trim();

  meta.std = toISOFromUTCString(extractLabelTime(docDescriptionHtml, 'Scheduled Time of Departure'));
  meta.atd = toISOFromUTCString(extractLabelTime(docDescriptionHtml, 'Actual Time of Departure'));
  meta.sta = toISOFromUTCString(extractLabelTime(docDescriptionHtml, 'Scheduled Time of Arrival'));
  meta.ata = toISOFromUTCString(extractLabelTime(docDescriptionHtml, 'Actual Time of Arrival'));
  meta.eta = toISOFromUTCString(extractLabelTime(docDescriptionHtml, 'Estimated Time of Arrival'));
  return meta;
}

function parsePointPlacemarks(xmlDoc) {
  const placemarks = [...xmlDoc.querySelectorAll('Placemark')];
  const points = [];
  for (const pm of placemarks) {
    const coordText = pm.querySelector('Point > coordinates')?.textContent?.trim();
    if (!coordText) continue;
    const [lon, lat, alt] = coordText.split(',').map(Number);
    const when = pm.querySelector('TimeStamp > when')?.textContent?.trim() || null;
    const descHtml = pm.querySelector('description')?.textContent || '';
    const altFtM = /Altitude:<\/b><\/span>\s*<span>([-\d,.]+)\s*ft/i.exec(descHtml);
    const speedM = /Speed:<\/b><\/span>\s*<span>([-\d,.]+)\s*kt/i.exec(descHtml);
    const headingM = /Heading:<\/b><\/span>\s*<span>([-\d.]+)/i.exec(descHtml);
    points.push({
      lat, lon,
      alt: altFtM ? Number(altFtM[1].replace(/,/g, '')) : (Number.isFinite(alt) ? alt * 3.28084 : null),
      t: when ? new Date(when).getTime() : null,
      speed: speedM ? Number(speedM[1].replace(/,/g, '')) : null,
      heading: headingM ? Number(headingM[1]) : null,
    });
  }
  return points;
}

function parseLineStrings(xmlDoc) {
  const coordEls = [...xmlDoc.querySelectorAll('LineString > coordinates')];
  const points = [];
  for (const el of coordEls) {
    const text = el.textContent.trim();
    for (const triple of text.split(/\s+/)) {
      if (!triple) continue;
      const [lon, lat, alt] = triple.split(',').map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      points.push({
        lat, lon,
        alt: Number.isFinite(alt) ? alt * 3.28084 : null,
        t: null, speed: null, heading: null,
      });
    }
  }
  return points;
}

export function parseKML(xmlText, filename) {
  const xmlDoc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (xmlDoc.querySelector('parsererror')) {
    throw new Error(`Fichier KML invalide: ${filename}`);
  }

  let rawPoints = parsePointPlacemarks(xmlDoc);
  let source = 'fr24';
  if (rawPoints.length === 0) {
    rawPoints = parseLineStrings(xmlDoc);
    source = 'flightaware';
  }
  if (rawPoints.length < 2) {
    throw new Error(`Aucune trace exploitable dans ${filename}`);
  }

  const docName = xmlDoc.querySelector('Document > name')?.textContent?.trim() || null;
  const fnFromFile = source === 'flightaware'
    ? parseFilenameFlightAware(filename)
    : parseFilenameFR24(filename);

  let flightNumber = fnFromFile?.flightNumber
    || (docName ? docName.split('/')[0].trim().toUpperCase() : null)
    || filename.replace(/\.[^.]+$/, '');
  let callsign = fnFromFile?.callsign || (docName && docName.includes('/') ? docName.split('/')[1].trim() : null);

  const meta = source === 'fr24'
    ? extractFR24Metadata(xmlDoc.querySelector('Document > description')?.textContent)
    : {};

  const firstT = rawPoints.find(p => p.t)?.t || null;
  const lastPointWithT = [...rawPoints].reverse().find(p => p.t)?.t || null;

  const startTime = meta.atd || meta.std || (firstT ? new Date(firstT).toISOString() : null);
  const endTime = meta.ata || meta.eta || meta.sta || (lastPointWithT ? new Date(lastPointWithT).toISOString() : null);

  let date = fnFromFile?.date || null;
  if (!date) {
    const ref = startTime || (firstT ? new Date(firstT).toISOString() : null);
    date = ref ? ref.slice(0, 10) : null;
  }

  const distanceKm = pathDistanceKm(rawPoints);
  const maxAltitude = rawPoints.reduce((m, p) => (p.alt != null && p.alt > m ? p.alt : m), 0);
  const maxSpeed = rawPoints.reduce((m, p) => (p.speed != null && p.speed > m ? p.speed : m), 0);

  const depIata = meta.depIata || fnFromFile?.depIata || null;
  const arrIata = meta.arrIata || fnFromFile?.arrIata || null;
  const airline = fnFromFile?.airline || guessAirline(flightNumber);

  return {
    id: filename,
    flightNumber,
    callsign,
    airline,
    aircraftType: meta.aircraftType || null,
    registration: meta.registration || null,
    depIata, depIcao: fnFromFile?.depIcao || null, depName: meta.depName || null,
    arrIata, arrIcao: fnFromFile?.arrIcao || null, arrName: meta.arrName || null,
    date,
    startTime,
    endTime,
    distanceKm: Math.round(distanceKm),
    maxAltitude: Math.round(maxAltitude),
    maxSpeed: maxSpeed ? Math.round(maxSpeed) : null,
    source,
    sourceFile: filename,
    points: decimate(rawPoints),
  };
}
