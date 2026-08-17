// Thin helpers around Leaflet for drawing flight paths.

export function createMap(container, options = {}) {
  const map = L.map(container, {
    zoomControl: true,
    attributionControl: true,
    ...options,
  });
  // Voyager plutôt que Dark Matter : moins "vide et noir", toujours discret
  // derrière les tracés. Variante "nolabels" : sans elle, les noms de ville
  // s'accumulent sous les dizaines de routes qui se croisent sur la carte
  // "Toutes les traces" et rendent le fond illisible — les tracés portent
  // déjà leur info au survol.
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);
  return map;
}

export function endpointDot(latlng, color) {
  return L.circleMarker(latlng, {
    radius: 5,
    color: '#0b0f1a',
    weight: 1.5,
    fillColor: color,
    fillOpacity: 1,
  });
}

export function drawFlightPath(map, flight, color = '#4da3ff') {
  const latlngs = flight.points.map((p) => [p.lat, p.lon]);
  const line = L.polyline(latlngs, { color, weight: 2.5, opacity: 0.9 }).addTo(map);
  endpointDot(latlngs[0], '#4ade80').addTo(map).bindTooltip(flight.depIata || 'Départ');
  endpointDot(latlngs[latlngs.length - 1], '#f87171').addTo(map).bindTooltip(flight.arrIata || 'Arrivée');
  return line;
}

export function fitToLayers(map, layers, padding = 32) {
  const group = L.featureGroup(layers);
  map.fitBounds(group.getBounds(), { padding: [padding, padding] });
}

// Points intermédiaires le long du grand cercle reliant deux coordonnées
// (formule usuelle de navigation, cf. Aviation Formulary / Movable Type
// geodesy). Sert à tracer une route "orthodromique" réaliste sur la carte
// (courbe) plutôt qu'un segment droit, pour les vols sans trace GPS.
export function greatCirclePoints(lat1, lon1, lat2, lon2, steps = 64) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1), lambda1 = toRad(lon1);
  const phi2 = toRad(lat2), lambda2 = toRad(lon2);
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((phi2 - phi1) / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin((lambda2 - lambda1) / 2) ** 2
  ));
  if (!d) return [[lat1, lon1]];
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(phi1) * Math.cos(lambda1) + B * Math.cos(phi2) * Math.cos(lambda2);
    const y = A * Math.cos(phi1) * Math.sin(lambda1) + B * Math.cos(phi2) * Math.sin(lambda2);
    const z = A * Math.sin(phi1) + B * Math.sin(phi2);
    pts.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
  }
  return pts;
}

// Marqueur "avion" pour le replay : une flèche SVG (pas un emoji, dont
// l'orientation par défaut varie selon les plateformes) dont on tourne
// uniquement l'élément interne — jamais le div positionné par Leaflet
// (qui porte déjà son propre transform: translate3d pour le placement).
export function createPlaneMarker(map, color = '#4da3ff') {
  const icon = L.divIcon({
    className: 'replay-plane-icon',
    html: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 1 L19 21 L12 16.5 L5 21 Z" fill="${color}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
  const marker = L.marker([0, 0], { icon, interactive: false, zIndexOffset: 1000 }).addTo(map);
  return {
    marker,
    setPose(lat, lon, bearingDeg) {
      marker.setLatLng([lat, lon]);
      const svg = marker.getElement()?.querySelector('svg');
      if (svg) svg.style.transform = `rotate(${bearingDeg}deg)`;
    },
  };
}

export function drawGreatCircle(map, lat1, lon1, lat2, lon2, color = '#4da3ff', opts = {}) {
  const latlngs = greatCirclePoints(lat1, lon1, lat2, lon2);
  return L.polyline(latlngs, {
    color, weight: 2, opacity: 0.65, dashArray: '2 7', lineCap: 'round', ...opts,
  }).addTo(map);
}
