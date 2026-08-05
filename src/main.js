import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ═══════════════════════════════════════════════════════════════
// UI refs
// ═══════════════════════════════════════════════════════════════
const splash    = document.getElementById('splash');
const statusEl  = document.getElementById('status-text');
const spinner   = document.getElementById('spinner');
const btnOpen   = document.getElementById('btn-open');
const errorMsg  = document.getElementById('error-msg');
const hud       = document.getElementById('hud');
const btnPlace  = document.getElementById('btn-place');
const cameraBg  = document.getElementById('camera-bg');

// ═══════════════════════════════════════════════════════════════
// Three.js state
// ═══════════════════════════════════════════════════════════════
let renderer, scene, camera;
let portalGroup = null;
let portalPlaced = false;
let insidePortal = false;

// Orientación del dispositivo
const deviceQuat = new THREE.Quaternion();
const _euler     = new THREE.Euler();
// Corrección para pantalla vertical (Three.js camera mira hacia -Z pero
// el teléfono en vertical natural mira hacia el frente con beta≈90)
const _corrQ     = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _screenQ   = new THREE.Quaternion();
const _zAxis     = new THREE.Vector3(0, 0, 1);
let orientationActive = false;

// ═══════════════════════════════════════════════════════════════
// INICIO
// ═══════════════════════════════════════════════════════════════
showStatus('Listo para comenzar');
btnOpen.style.display = 'block';
btnOpen.addEventListener('click', launch, { once: true });

// ═══════════════════════════════════════════════════════════════
// PASO 1 – Pedir permisos y abrir cámara
// ═══════════════════════════════════════════════════════════════
async function launch() {
  btnOpen.style.display = 'none';
  showStatus('Solicitando acceso a la cámara...');
  spinOn();

  // ── Pedir permiso de orientación (obligatorio en iOS 13+) ──
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') {
        showError('Se necesita permiso de orientación del dispositivo para girar la vista.\nVe a Ajustes > Safari > Movimiento y orientación y actívalo.');
        return;
      }
    } catch (e) {
      showError(`Error de permiso de orientación: ${e.message}`);
      return;
    }
  }

  // ── Abrir cámara trasera ───────────────────────────────────
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },   // cámara trasera
        width:  { ideal: window.innerWidth },
        height: { ideal: window.innerHeight }
      },
      audio: false
    });
  } catch (e) {
    showError(
      `No se pudo acceder a la cámara.\n\nError: ${e.name}\n${e.message}\n\n` +
      `Soluciones:\n• Acepta el permiso de cámara cuando el navegador lo pida.\n` +
      `• Verifica que el sitio esté en HTTPS.\n` +
      `• En Ajustes del teléfono, asegúrate de que Chrome/Safari tenga permiso de cámara.`
    );
    return;
  }

  // Conectar stream al video
  cameraBg.srcObject = stream;
  cameraBg.style.display = 'block';
  await new Promise(r => { cameraBg.onloadedmetadata = r; });

  // ── Inicializar Three.js ────────────────────────────────────
  initThree();

  // ── Escuchar orientación del dispositivo ───────────────────
  window.addEventListener('deviceorientation', onOrientation, true);

  // ── Ocultar splash ─────────────────────────────────────────
  spinOff();
  splash.style.display = 'none';
  hud.style.display = 'block';
  btnPlace.style.display = 'block';

  // ── Cargar portal 3D ───────────────────────────────────────
  showHud('Cargando modelos...');
  await loadPortal();
  showHud('Mueve el teléfono y toca "Colocar portal" para anclarlo');

  // ── Botón de colocar portal ────────────────────────────────
  btnPlace.addEventListener('click', placePortal, { once: true });

  // ── Arrancar render loop ───────────────────────────────────
  renderer.setAnimationLoop(renderLoop);
}

// ═══════════════════════════════════════════════════════════════
// Three.js setup
// ═══════════════════════════════════════════════════════════════
function initThree() {
  renderer = new THREE.WebGLRenderer({
    antialias:  true,
    alpha:      true,    // fondo transparente → se ve el video debajo
    stencil:    true,    // necesario para el efecto portal
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);   // fondo 100% transparente
  renderer.autoClear = false;            // limpiar manualmente (necesario para stencil)
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.01, 100
  );
  scene.add(camera);

  // Luces
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 1.2);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(2, 5, 3);
  scene.add(sun);

  window.addEventListener('resize', onResize);
}

// ═══════════════════════════════════════════════════════════════
// Giroscopio → cámara Three.js
// ═══════════════════════════════════════════════════════════════
function onOrientation(e) {
  if (e.alpha === null) return;  // algunos dispositivos dan null
  orientationActive = true;

  const alpha  = THREE.MathUtils.degToRad(e.alpha  ?? 0);
  const beta   = THREE.MathUtils.degToRad(e.beta   ?? 0);
  const gamma  = THREE.MathUtils.degToRad(e.gamma  ?? 0);

  // Orientación del screen (landscape/portrait)
  const orient = THREE.MathUtils.degToRad(
    window.screen?.orientation?.angle ?? window.orientation ?? 0
  );

  // Construir quaternion de orientación del dispositivo
  _euler.set(beta, alpha, -gamma, 'YXZ');
  deviceQuat.setFromEuler(_euler);
  deviceQuat.multiply(_corrQ);
  _screenQ.setFromAxisAngle(_zAxis, -orient);
  deviceQuat.multiply(_screenQ);

  camera.quaternion.copy(deviceQuat);
}

// ═══════════════════════════════════════════════════════════════
// Cargar portal 3D
// ═══════════════════════════════════════════════════════════════
async function loadPortal() {
  const loader = new GLTFLoader();
  const { buildPortalGroup } = await import('./portal.js');
  portalGroup = await buildPortalGroup(loader);
}

// ═══════════════════════════════════════════════════════════════
// Colocar portal (fijarlo 2.5m adelante de donde mira el teléfono)
// ═══════════════════════════════════════════════════════════════
function placePortal() {
  if (!portalGroup || portalPlaced) return;

  // Dirección hacia donde mira la cámara en ese momento
  const dir = new THREE.Vector3(0, 0, -1);
  dir.applyQuaternion(camera.quaternion);
  dir.y = 0;          // mantener en plano horizontal
  dir.normalize();

  // Posición de la cámara (en escena 3D la cámara está en el origen)
  const origin = new THREE.Vector3(0, 0, 0);
  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);

  // Colocar a 2.5m adelante, "en el suelo"
  portalGroup.position.copy(camPos).addScaledVector(dir, 2.5);
  portalGroup.position.y = -1.5; // simular altura del suelo (aprox 1.5m abajo)

  // Que el portal mire de vuelta a la cámara
  const lookAt = new THREE.Vector3(camPos.x, portalGroup.position.y, camPos.z);
  portalGroup.lookAt(lookAt);

  scene.add(portalGroup);
  portalPlaced = true;
  btnPlace.style.display = 'none';
  showHud('Acércate al portal para entrar');
}

// ═══════════════════════════════════════════════════════════════
// Render loop
// ═══════════════════════════════════════════════════════════════
function renderLoop() {
  // Si el giroscopio no disparó eventos aún, dar un toque suave de balanceo
  if (!orientationActive) {
    const t = performance.now() * 0.001;
    camera.rotation.set(
      Math.sin(t * 0.3) * 0.02,
      Math.sin(t * 0.2) * 0.04,
      0
    );
  }

  // Limpiar: color + depth + stencil
  renderer.clear(true, true, true);

  // Detectar cruce del portal si ya fue colocado
  if (portalPlaced && portalGroup) checkCrossing();

  renderer.render(scene, camera);
}

// ═══════════════════════════════════════════════════════════════
// Detección de cruce del portal
// ═══════════════════════════════════════════════════════════════
const _cp = new THREE.Vector3();
const _pp = new THREE.Vector3();
const _fw = new THREE.Vector3();
const _tp = new THREE.Vector3();

function checkCrossing() {
  camera.getWorldPosition(_cp);
  portalGroup.getWorldPosition(_pp);
  portalGroup.getWorldDirection(_fw);
  _tp.subVectors(_cp, _pp);

  const inside = (_tp.dot(_fw) < 0) && (_cp.distanceTo(_pp) < 3.0);

  if (inside && !insidePortal) {
    insidePortal = true;
    if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(false);
    showHud('Dentro del portal · Retrocede para salir');
  } else if (!inside && insidePortal) {
    insidePortal = false;
    if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(true);
    showHud('Acércate al portal para entrar');
  }
}

// ═══════════════════════════════════════════════════════════════
// Resize
// ═══════════════════════════════════════════════════════════════
function onResize() {
  if (!camera || !renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ═══════════════════════════════════════════════════════════════
// Helpers UI
// ═══════════════════════════════════════════════════════════════
function showStatus(msg) { statusEl.textContent = msg; }
function showHud(msg)    { hud.textContent = msg; }
function spinOn()        { spinner.classList.add('on'); }
function spinOff()       { spinner.classList.remove('on'); }
function showError(msg) {
  spinOff();
  showStatus('');
  errorMsg.style.display = 'block';
  errorMsg.textContent = msg;
  btnOpen.textContent = 'Reintentar';
  btnOpen.style.display = 'block';
  btnOpen.addEventListener('click', () => location.reload(), { once: true });
}
