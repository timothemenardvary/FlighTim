// Vue 3D du profil de vol (position + altitude), fiche de vol uniquement.
// Ce n'est pas une carte géographique : projection tangente locale centrée
// sur le vol (valable à l'échelle d'une route, pas d'un globe), altitude
// fortement exagérée pour rester lisible face à des distances horizontales
// de centaines de km — sert à visualiser le profil montée / croisière /
// descente, pas à naviguer. Three.js est vendorisé en local (vendor/three/)
// pour rester hors-ligne, comme le reste de l'app.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';

const KM_PER_DEG_LAT = 111.32;
const FT_TO_KM = 0.0003048;

// Construit la vue 3D dans `container` (déjà dimensionné en CSS) à partir
// des points de trace (lat/lon/alt) d'un vol. Renvoie { resize, destroy }
// ou `null` si moins de 2 points exploitables. `destroy()` doit être appelé
// en quittant la fiche de vol pour libérer le contexte WebGL (Safari en
// limite le nombre simultané).
export function createFlight3DView(container, points) {
  const valid = points.filter((p) => p.lat != null && p.lon != null);
  if (valid.length < 2) return null;

  const centerLat = valid.reduce((s, p) => s + p.lat, 0) / valid.length;
  const centerLon = valid.reduce((s, p) => s + p.lon, 0) / valid.length;
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180);

  const projected = valid.map((p) => ({
    x: (p.lon - centerLon) * kmPerDegLon,
    z: -(p.lat - centerLat) * KM_PER_DEG_LAT,
    altKm: Math.max(p.alt ?? 0, 0) * FT_TO_KM,
  }));

  const horizontalExtent = Math.max(...projected.map((p) => Math.hypot(p.x, p.z)), 1);
  const maxAltKm = Math.max(...projected.map((p) => p.altKm), 0.1);
  // Vise une hauteur de profil ~35% de l'étendue horizontale : assez pour
  // que la montée/descente se voie, pas assez pour écraser la géométrie.
  const exaggeration = (horizontalExtent * 0.35) / maxAltKm;

  const curvePoints = projected.map((p) => new THREE.Vector3(p.x, p.altKm * exaggeration, p.z));

  const scene = new THREE.Scene();

  const width = container.clientWidth || 300;
  const height = container.clientHeight || 300;
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100000);
  const boundingRadius = horizontalExtent * 1.3;
  camera.position.set(boundingRadius * 0.6, boundingRadius * 0.55, boundingRadius * 0.9);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const controlsTargetY = maxAltKm * exaggeration * 0.3;
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, controlsTargetY, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = boundingRadius * 0.2;
  controls.maxDistance = boundingRadius * 3;
  controls.update();

  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(boundingRadius, boundingRadius, boundingRadius);
  scene.add(dirLight);

  // Grille au sol : ancre visuellement l'altitude 0, sans quoi le profil
  // flotte sans repère.
  const grid = new THREE.GridHelper(horizontalExtent * 2.6, 12, 0x4da3ff, 0x2a3448);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  // Tube dégradé (bleu au sol -> or en altitude) plutôt qu'une simple ligne :
  // WebGL ignore linewidth sur la plupart des plateformes (toujours 1px), et
  // le dégradé rend l'altitude lisible sans avoir à lire un axe.
  const curve = new THREE.CatmullRomCurve3(curvePoints);
  const tubeGeo = new THREE.TubeGeometry(
    curve,
    Math.max(curvePoints.length, 32),
    Math.max(horizontalExtent * 0.004, 0.3),
    8,
    false
  );
  const colorLow = new THREE.Color('#4da3ff');
  const colorHigh = new THREE.Color('#facc15');
  const posAttr = tubeGeo.attributes.position;
  const vertexColors = new Float32Array(posAttr.count * 3);
  const maxY = maxAltKm * exaggeration || 1;
  for (let i = 0; i < posAttr.count; i++) {
    const t = Math.min(Math.max(posAttr.getY(i) / maxY, 0), 1);
    const c = colorLow.clone().lerp(colorHigh, t);
    vertexColors[i * 3] = c.r;
    vertexColors[i * 3 + 1] = c.g;
    vertexColors[i * 3 + 2] = c.b;
  }
  tubeGeo.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3));
  const tubeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.1 });
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  scene.add(tube);

  // Repères départ/arrivée au sol, mêmes couleurs que les points de la carte 2D.
  const markerRadius = Math.max(horizontalExtent * 0.01, 0.8);
  const depGeo = new THREE.SphereGeometry(markerRadius, 16, 16);
  const depMat = new THREE.MeshStandardMaterial({ color: '#4ade80' });
  const depMarker = new THREE.Mesh(depGeo, depMat);
  depMarker.position.set(curvePoints[0].x, 0, curvePoints[0].z);
  scene.add(depMarker);

  const arrGeo = new THREE.SphereGeometry(markerRadius, 16, 16);
  const arrMat = new THREE.MeshStandardMaterial({ color: '#f87171' });
  const arrMarker = new THREE.Mesh(arrGeo, arrMat);
  const last = curvePoints[curvePoints.length - 1];
  arrMarker.position.set(last.x, 0, last.z);
  scene.add(arrMarker);

  let frameId = null;
  const animate = () => {
    frameId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };

  return {
    resize,
    destroy() {
      cancelAnimationFrame(frameId);
      controls.dispose();
      renderer.dispose();
      tubeGeo.dispose();
      tubeMat.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      depGeo.dispose();
      depMat.dispose();
      arrGeo.dispose();
      arrMat.dispose();
      renderer.domElement.remove();
    },
  };
}
