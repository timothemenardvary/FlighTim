// Parse les pages individuelles d'un export Notion "Export as HTML" (une
// page .html par ligne de la base "Flight History", générée par Notion
// uniquement quand la ligne a du contenu au-delà de ses propriétés : note
// libre et/ou photo jointe). Ce n'est pas la source des vols eux-mêmes —
// seulement un enrichissement optionnel des lignes déjà trouvées via le CSV
// Notion (cf notionParser.js), rapproché par la même clé "NUMERO|YYYY-MM-DD".
//
// Contrairement au texte libre des dates dans le CSV ("April 19, 2026
// 17:45" ou "19/04/2026 5:45 PM" selon la vue), chaque page HTML porte la
// date dans un attribut <time datetime="2026-08-05"> non ambigu.

// Résout un chemin relatif (tel qu'écrit dans un <img src="...">) par
// rapport au chemin (webkitRelativePath) du fichier .html qui le référence,
// pour retrouver le File correspondant dans la sélection de dossier.
export function resolveRelativePath(baseRelPath, relPath) {
  const dir = baseRelPath.split('/').slice(0, -1);
  for (const rawPart of relPath.split('/')) {
    const part = decodeURIComponent(rawPart);
    if (!part || part === '.') continue;
    if (part === '..') dir.pop();
    else dir.push(part);
  }
  return dir.join('/');
}

// Renvoie { key, notes, photoPaths } ou `null` si cette page n'est pas une
// ligne "Flight History" exploitable (page vide, ligne Aircraft/Airports,
// page sans date...).
export function parseNotionFlightPage(html, filename) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const article = doc.querySelector('article.page');
  if (!article) return null;

  const flightNumber = article.querySelector('h1.page-title')?.textContent?.trim()?.toUpperCase();
  if (!flightNumber) return null;

  let date = null;
  for (const row of article.querySelectorAll('table.properties tr.property-row')) {
    if (row.querySelector('th')?.textContent?.trim() !== 'Date') continue;
    const iso = row.querySelector('td time')?.getAttribute('datetime');
    if (iso) date = iso.slice(0, 10);
    break;
  }
  if (!date) return null;

  const body = article.querySelector('.page-body');
  const notes = body
    ? [...body.querySelectorAll('p')].map((p) => p.textContent.trim()).filter(Boolean).join('\n')
    : '';
  const photoPaths = body
    ? [...body.querySelectorAll('figure[data-notion-image] img')].map((img) => img.getAttribute('src')).filter(Boolean)
    : [];

  return {
    key: `${flightNumber}|${date}`,
    notes: notes || null,
    photoPaths,
    sourceFile: filename,
  };
}
