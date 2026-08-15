// Parse les exports CSV Notion ("Flight History") pour enrichir les vols
// importés depuis les KML : cabine, siège, portes, pistes, horaires
// programmés/réels, etc. La jointure avec un vol KML se fait par
// numéro de vol + date (cf notionKeyFor dans app.js), pas par nom de
// fichier, puisque les deux exports (Flight Tracker / Notion) n'ont
// aucun identifiant commun.

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Parseur CSV RFC4180 minimal (guillemets, virgules et retours à la ligne
// dans les champs) : Notion peut exporter des propriétés multi-valeurs
// contenant des virgules, un simple split(',') casserait ces lignes.
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function parseCSVObjects(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
    return obj;
  });
}

function clean(value) {
  const v = (value || '').trim();
  return v || null;
}

// Notion exporte les relations (aéroport, immatriculation...) sous la forme
// "LFPG (https://app.notion.com/p/...)" -> on ne garde que le code.
function stripNotionLink(value) {
  if (!value) return null;
  const m = /^([^\s(]+)\s*\(/.exec(value.trim());
  return clean(m ? m[1] : value);
}

function parseNotionDate(value) {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(value || '');
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

function to24h(hStr, minStr, ampm) {
  let h = Number(hStr);
  const min = Number(minStr);
  if (ampm) {
    const isPM = ampm.toUpperCase() === 'PM';
    if (isPM && h < 12) h += 12;
    if (!isPM && h === 12) h = 0;
  }
  return { h, min };
}

// Notion exporte les propriétés date+heure sous deux formats selon la config
// de la vue ("April 19, 2026 17:45" ou "19/04/2026 5:45 PM"), toujours suivis
// d'un fuseau entre parenthèses ("(GMT+2)"). On ignore ce fuseau : STD/ATD (ou
// STA/ATA) d'un même vol partagent toujours le même décalage, donc l'écart
// entre les deux reste juste même sans le convertir en UTC réel. On encode le
// résultat via Date.UTC() pour obtenir un timestamp stable, comparable et
// facile à reformater (getUTCHours/getUTCMinutes) sans dérive de fuseau local.
// Extrait le décalage horaire entre parenthèses ("(GMT+2)", "(GMT-5)") que
// parseNotionDateTime ignore pour le calcul de durée/retard, mais qu'on veut
// pouvoir afficher tel quel (écart par rapport à l'heure Zulu) côté détail
// de vol. STD/ATD partagent toujours le même décalage (aéroport de départ),
// idem STA/ATA (aéroport d'arrivée), donc un seul appel par côté suffit.
export function parseNotionUtcOffsetMinutes(value) {
  const m = /GMT\s*([+-]\d{1,2})(?::?(\d{2}))?/i.exec(value || '');
  if (!m) return null;
  const h = Number(m[1]);
  const mins = m[2] ? Number(m[2]) : 0;
  return (h < 0 ? -1 : 1) * (Math.abs(h) * 60 + mins);
}

export function parseNotionDateTime(value) {
  if (!value) return null;
  let m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(value);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) return null;
    const { h, min } = to24h(m[4], m[5], m[6]);
    return Date.UTC(Number(m[3]), month - 1, Number(m[2]), h, min);
  }
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(value);
  if (m) {
    const { h, min } = to24h(m[4], m[5], m[6]);
    return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), h, min);
  }
  return null;
}

const SIMPLE_FIELDS = {
  carrier: 'Carrier',
  cabin: 'Cabin',
  seatType: 'Seat Type',
  seats: 'Seats',
  depGate: 'Dep Gate',
  arrGate: 'Arr Gate',
  depRunway: 'Dep.Runway',
  arrRunway: 'Arr Runway',
  std: 'STD',
  sta: 'STA',
  atd: 'ATD',
  ata: 'ATA',
  atl: 'ATL',
  att: 'ATT',
  scheduledBlockTime: 'Scheduled Block Time',
  actualBlockTime: 'Actual Block Time',
  boardingStart: 'Boarding Start Time',
  boardingEnd: 'Boarding End Time',
  departureTaxiTime: 'Departure Taxi Time',
};

// Renvoie un tableau de vols Notion, ou `null` si ce CSV n'est pas un export
// "Flight History" (pas de colonnes Flight/Date) -> permet de scanner un
// dossier Notion complet (Aircraft.csv, Airports.csv...) sans se tromper.
export function parseNotionCSV(text, filename) {
  const rows = parseCSVObjects(text);
  if (rows.length === 0) return null;

  const headerKeys = Object.keys(rows[0]);
  const findKey = (name) => headerKeys.find((h) => h.toLowerCase() === name.toLowerCase());
  const flightKey = findKey('Flight');
  const dateKey = findKey('Date');
  if (!flightKey || !dateKey) return null;

  const keyFor = Object.fromEntries(
    Object.entries(SIMPLE_FIELDS).map(([field, header]) => [field, findKey(header)])
  );
  const registrationKey = findKey('Registration');
  const depAirportKey = findKey('Departure Airport');
  const arrAirportKey = findKey('Arrival Airport');

  const out = [];
  for (const row of rows) {
    const flightNumber = clean(row[flightKey])?.toUpperCase();
    const date = parseNotionDate(row[dateKey]);
    if (!flightNumber || !date) continue;

    const rec = { key: `${flightNumber}|${date}`, flightNumber, date, sourceFile: filename };
    rec.registration = stripNotionLink(row[registrationKey]);
    rec.depAirport = stripNotionLink(row[depAirportKey]);
    rec.arrAirport = stripNotionLink(row[arrAirportKey]);
    for (const field of Object.keys(SIMPLE_FIELDS)) {
      rec[field] = clean(row[keyFor[field]]);
    }
    rec.stdAt = parseNotionDateTime(rec.std);
    rec.atdAt = parseNotionDateTime(rec.atd);
    rec.staAt = parseNotionDateTime(rec.sta);
    rec.ataAt = parseNotionDateTime(rec.ata);
    rec.boardingStartAt = parseNotionDateTime(rec.boardingStart);
    rec.boardingEndAt = parseNotionDateTime(rec.boardingEnd);
    rec.depUtcOffsetMin = parseNotionUtcOffsetMinutes(rec.std || rec.atd);
    rec.arrUtcOffsetMin = parseNotionUtcOffsetMinutes(rec.sta || rec.ata);
    out.push(rec);
  }
  return out;
}
