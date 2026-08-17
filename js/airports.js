// Référentiel aéroports (OACI/ICAO, IATA, ville, coordonnées) embarqué dans
// l'app pour rester 100% hors-ligne / privé (aucun appel réseau). Couvre les
// aéroports effectivement présents dans l'historique de vols de l'utilisateur
// (cf data_other_tools/airports.csv). Sert à :
//  - résoudre en IATA les codes ICAO renvoyés par les exports Notion
//    (relation "Airports"), pour un affichage cohérent avec les vols KML,
//  - fournir des coordonnées pour tracer une route orthodromique quand on
//    n'a pas de trace GPS réelle (vol connu seulement via Notion).
//
// [icao, iata, city, country, name, lat, lon]
const RAW = [
  ['KDCA', 'DCA', 'Washington', 'USA', 'Washington National', 38.8512, -77.0402],
  ['LFPG', 'CDG', 'Paris', 'France', 'Charles de Gaulle', 49.0097, 2.5479],
  ['KIAD', 'IAD', 'Washington', 'USA', 'Dulles', 38.9531, -77.4565],
  ['EHAM', 'AMS', 'Amsterdam', 'Pays-Bas', 'Schiphol', 52.3086, 4.7639],
  ['LEZL', 'SVQ', 'Séville', 'Espagne', 'San Pablo', 37.4180, -5.8931],
  ['KSFO', 'SFO', 'San Francisco', 'USA', 'San Francisco International', 37.6213, -122.3790],
  ['KPHL', 'PHL', 'Philadelphie', 'USA', 'Philadelphia International', 39.8729, -75.2437],
  ['KJFK', 'JFK', 'New York', 'USA', 'John F Kennedy', 40.6413, -73.7781],
  ['OTHH', 'DOH', 'Doha', 'Qatar', 'Hamad International', 25.2731, 51.6086],
  ['VABB', 'BOM', 'Mumbai', 'Inde', 'Chhatrapati Shivaji', 19.0887, 72.8679],
  ['VOMD', 'IXM', 'Madurai', 'Inde', 'Madurai', 9.8345, 78.0934],
  ['OBBI', 'BAH', 'Bahreïn', 'Bahreïn', 'Bahrain International', 26.2708, 50.6336],
  ['EGKK', 'LGW', 'Londres', 'Royaume-Uni', 'Gatwick', 51.1537, -0.1821],
  ['LFPO', 'ORY', 'Paris', 'France', 'Orly', 48.7233, 2.3794],
  ['LEMD', 'MAD', 'Madrid', 'Espagne', 'Adolfo Suárez Barajas', 40.4936, -3.5668],
  ['KRSW', 'RSW', 'Fort Myers', 'USA', 'Southwest Florida International', 26.5362, -81.7552],
  ['EGLL', 'LHR', 'Londres', 'Royaume-Uni', 'Heathrow', 51.4700, -0.4543],
  ['KATL', 'ATL', 'Atlanta', 'USA', 'Hartsfield-Jackson', 33.6407, -84.4277],
  ['KDTW', 'DTW', 'Détroit', 'USA', 'Detroit Metropolitan Wayne Co', 42.2124, -83.3534],
  ['LPPT', 'LIS', 'Lisbonne', 'Portugal', 'Portela', 38.7813, -9.1359],
  ['LFML', 'MRS', 'Marseille', 'France', 'Marseille Provence', 43.4393, 5.2214],
  ['EDDF', 'FRA', 'Francfort', 'Allemagne', 'Frankfurt am Main', 50.0379, 8.5622],
  ['LJLJ', 'LJU', 'Ljubljana', 'Slovénie', 'Brnik', 46.2237, 14.4576],
  ['KMSY', 'MSY', 'La Nouvelle-Orléans', 'USA', 'Louis Armstrong', 29.9934, -90.2580],
  ['KORD', 'ORD', 'Chicago', 'USA', "O'Hare", 41.9742, -87.9073],
  ['KMIA', 'MIA', 'Miami', 'USA', 'Miami International', 25.7959, -80.2870],
  ['LFBD', 'BOD', 'Bordeaux', 'France', 'Bordeaux Mérignac', 44.8283, -0.7156],
  ['CYYZ', 'YYZ', 'Toronto', 'Canada', 'Pearson', 43.6777, -79.6248],
  ['SCEL', 'SCL', 'Santiago', 'Chili', 'Comodoro Arturo Merino Benítez', -33.3930, -70.7858],
  ['KBOS', 'BOS', 'Boston', 'USA', 'Logan', 42.3656, -71.0096],
  ['SCCF', 'CJC', 'Calama', 'Chili', 'El Loa', -22.4981, -68.9036],
  ['MPTO', 'PTY', 'Panama City', 'Panama', 'Tocumen', 9.0714, -79.3835],
  ['SEQM', 'UIO', 'Quito', 'Équateur', 'Mariscal Sucre', -0.1292, -78.3575],
  ['SABE', 'AEP', 'Buenos Aires', 'Argentine', 'Jorge Newbery (Aeroparque)', -34.5592, -58.4156],
  ['SASA', 'SLA', 'Salta', 'Argentine', 'Salta', -24.8425, -65.4861],
  ['SBGR', 'GRU', 'São Paulo', 'Brésil', 'Guarulhos', -23.4356, -46.4731],
  ['SBPS', 'BPS', 'Porto Seguro', 'Brésil', 'Porto Seguro', -16.4386, -39.0808],
  ['LFBO', 'TLS', 'Toulouse', 'France', 'Toulouse Blagnac', 43.6293, 1.3638],
  ['KEWR', 'EWR', 'Newark', 'USA', 'Liberty International', 40.6895, -74.1745],
  ['EDDM', 'MUC', 'Munich', 'Allemagne', 'Franz Josef Strauss', 48.3538, 11.7861],
  ['LSGG', 'GVA', 'Genève', 'Suisse', 'Cointrin', 46.2381, 6.1090],
  ['LEPA', 'PMI', 'Palma de Majorque', 'Espagne', 'Son Sant Joan', 39.5517, 2.7388],
  ['LIML', 'LIN', 'Milan', 'Italie', 'Linate', 45.4451, 9.2767],
  ['EGLC', 'LCY', 'Londres', 'Royaume-Uni', 'London City', 51.5053, 0.0553],
  ['LKPR', 'PRG', 'Prague', 'Tchéquie', 'Václav Havel', 50.1008, 14.2600],
  ['KJAX', 'JAX', 'Jacksonville', 'USA', 'Jacksonville International', 30.4941, -81.6879],
  ['KSEA', 'SEA', 'Seattle', 'USA', 'Seattle-Tacoma', 47.4502, -122.3088],
  ['LEBL', 'BCN', 'Barcelone', 'Espagne', 'El Prat', 41.2971, 2.0785],
  ['LFMN', 'NCE', 'Nice', 'France', "Nice Côte d'Azur", 43.6584, 7.2159],
  ['GCLP', 'LPA', 'Grande Canarie', 'Espagne', 'Gran Canaria', 27.9319, -15.3866],
  ['GCRR', 'ACE', 'Lanzarote', 'Espagne', 'Lanzarote', 28.9455, -13.6052],
  ['EDDB', 'BER', 'Berlin', 'Allemagne', 'Brandenburg', 52.3667, 13.5033],
  ['LFRS', 'NTE', 'Nantes', 'France', 'Nantes Atlantique', 47.1532, -1.6108],
  ['GMMX', 'RAK', 'Marrakech', 'Maroc', 'Ménara', 31.6069, -8.0363],
  ['VHHH', 'HKG', 'Hong Kong', 'Hong Kong', 'Hong Kong International', 22.3080, 113.9185],
  ['VVNB', 'HAN', 'Hanoï', 'Vietnam', 'Nội Bài', 21.2212, 105.8072],
  ['VTBS', 'BKK', 'Bangkok', 'Thaïlande', 'Suvarnabhumi', 13.6900, 100.7501],
  ['VTSG', 'KBV', 'Krabi', 'Thaïlande', 'Krabi', 8.0863, 98.9863],
  ['WSSS', 'SIN', 'Singapour', 'Singapour', 'Changi', 1.3644, 103.9915],
  ['ENGM', 'OSL', 'Oslo', 'Norvège', 'Gardermoen', 60.1939, 11.1004],
  ['LGIR', 'HER', 'Héraklion', 'Grèce', 'Nikos Kazantzakis', 35.3397, 25.1803],
  ['LPPR', 'OPO', 'Porto', 'Portugal', 'Francisco Sá Carneiro', 41.2481, -8.6814],
  ['LIBD', 'BRI', 'Bari', 'Italie', 'Palese Macchie', 41.1389, 16.7606],
  ['OMDB', 'DXB', 'Dubaï', 'Émirats arabes unis', 'Dubai International', 25.2532, 55.3657],
  ['OOMS', 'MCT', 'Mascate', 'Oman', 'Seeb', 23.5933, 58.2844],
  ['LFMT', 'MPL', 'Montpellier', 'France', 'Montpellier Méditerranée', 43.5762, 3.9630],
  ['LFKF', 'FSC', 'Figari', 'France', 'Figari Sud-Corse', 41.5006, 9.0978],
  ['LGAV', 'ATH', 'Athènes', 'Grèce', 'Eleftherios Venizelos', 37.9364, 23.9445],
  ['LGSR', 'JTR', 'Santorin', 'Grèce', 'Santorin', 36.3992, 25.4793],
  ['LIPZ', 'VCE', 'Venise', 'Italie', 'Marco Polo', 45.5053, 12.3519],
  ['KLAS', 'LAS', 'Las Vegas', 'USA', 'McCarran', 36.0840, -115.1537],
  ['KBWI', 'BWI', 'Baltimore', 'USA', 'Baltimore-Washington', 39.1754, -76.6684],
  ['LIRQ', 'FLR', 'Florence', 'Italie', 'Peretola', 43.8100, 11.2051],
  ['KGSP', 'GSP', 'Greenville', 'USA', 'Greenville-Spartanburg', 34.8957, -82.2189],
  ['LGSA', 'CHQ', 'La Canée', 'Grèce', 'Souda', 35.5317, 24.1497],
];

const BY_CODE = new Map();
for (const [icao, iata, city, country, name, lat, lon] of RAW) {
  const entry = { icao, iata, city, country, name, lat, lon };
  BY_CODE.set(icao, entry);
  if (iata) BY_CODE.set(iata, entry);
}

export function lookupAirport(code) {
  if (!code) return null;
  return BY_CODE.get(String(code).trim().toUpperCase()) || null;
}

// Continent par pays, pour les jalons perso (Stats > Vols) — couvre
// uniquement les pays présents dans RAW ci-dessus.
const CONTINENT_BY_COUNTRY = {
  'Allemagne': 'Europe',
  'Argentine': 'Amérique du Sud',
  'Bahreïn': 'Asie',
  'Brésil': 'Amérique du Sud',
  'Canada': 'Amérique du Nord',
  'Chili': 'Amérique du Sud',
  'Émirats arabes unis': 'Asie',
  'Équateur': 'Amérique du Sud',
  'Espagne': 'Europe',
  'France': 'Europe',
  'Grèce': 'Europe',
  'Hong Kong': 'Asie',
  'Inde': 'Asie',
  'Italie': 'Europe',
  'Maroc': 'Afrique',
  'Norvège': 'Europe',
  'Oman': 'Asie',
  'Panama': 'Amérique du Nord',
  'Pays-Bas': 'Europe',
  'Portugal': 'Europe',
  'Qatar': 'Asie',
  'Royaume-Uni': 'Europe',
  'Singapour': 'Asie',
  'Slovénie': 'Europe',
  'Suisse': 'Europe',
  'Tchéquie': 'Europe',
  'Thaïlande': 'Asie',
  'USA': 'Amérique du Nord',
  'Vietnam': 'Asie',
};

export function continentFor(country) {
  if (!country) return null;
  return CONTINENT_BY_COUNTRY[country] || null;
}

// Coordonnées moyennes des aéroports d'un pays — utilisé par l'Atlas de vol
// (Stats > Monde) pour placer une pastille sur les pays trop petits pour
// avoir un tracé exploitable dans le fond de carte basse résolution
// (micro-États : Bahreïn, Hong Kong, Singapour...).
export function averageCoordFor(country) {
  const matches = RAW.filter(([, , , c]) => c === country);
  if (!matches.length) return null;
  const lat = matches.reduce((sum, [, , , , , lat]) => sum + lat, 0) / matches.length;
  const lon = matches.reduce((sum, [, , , , , , lon]) => sum + lon, 0) / matches.length;
  return [lat, lon];
}
