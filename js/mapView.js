// Thin helpers around Leaflet for drawing flight paths.

export function createMap(container, options = {}) {
  const map = L.map(container, {
    zoomControl: true,
    attributionControl: true,
    ...options,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
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
