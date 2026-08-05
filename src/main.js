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
let lastFrameTime = 0;

// ── Giroscopio ────────────────────────────────────────────────
const deviceQuat = new THREE.Quaternion();
const _euler     = new THREE.Euler();
const _corrQ     = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _screenQ   = new THREE.Quaternion();
const _zAxis     = new THREE.Vector3(0, 0, 1);
let orientationReady = false;

// ── Movimiento adelante/atrás ─────────────────────────────────
// ESTRATEGIA: en lugar de mover la cámara (que deriva con el acelerómetro),
// movemos el PORTAL hacia/desde la cámara. El efecto visual es idéntico.

// Velocidad de movimiento del portal (m/s, eje cámara→portal)
// + = portal se aleja (usuario "retrocede")
// - = portal se acerca (usuario "avanza")
let portalVelocity = 0;

// Fuente de movimiento activa: 'touch' | 'accel' | null
let moveIntent = null; // 'forward' | 'backward' | null (de touch)
const MOVE_SPEED_TOUCH = 0.8; // m/s con toque

// Acelerómetro
let lastFwdAcc = 0;
const ACC_DEAD_ZONE = 0.9; // m/s² - ignorar ruido por debajo de esto

// ═══════════════════════════════════════════════════════════════
// INICIO
// ═══════════════════════════════════════════════════════════════
showStatus('Listo para comenzar');
btnOpen.style.display = 'block';
btnOpen.addEventListener('click', launch, { once: true });

// ═══════════════════════════════════════════════════════════════
// PASO 1 – Permisos + Cámara
// ═══════════════════════════════════════════════════════════════
async function launch() {
  btnOpen.style.display = 'none';
  showStatus('Solicitando permisos...');
  spinOn();

  // iOS 13+: permisos de sensores
  if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') {
        showError('Activa el giroscopio en Ajustes > Safari > Movimiento y orientación.');
        return;
      }
    } catch (e) { /* En algunas versiones no lanza error, ignorar */ }
  }

  if (typeof DeviceMotionEvent?.requestPermission === 'function') {
    try {
      await DeviceMotionEvent.requestPermission();
    } catch (e) { /* Opcional, ignorar si falla */ }
  }

  // Abrir cámara trasera
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: window.innerWidth },
        height: { ideal: window.innerHeight }
      },
      audio: false
    });
  } catch (e) {
    showError(
      `No se pudo acceder a la cámara.\n\n` +
      `Error: ${e.name}\n${e.message}\n\n` +
      `• Acepta el permiso de cámara cuando aparezca.\n` +
      `• Verifica que el sitio sea HTTPS.\n` +
      `• En Ajustes del teléfono, dale permiso de cámara a Chrome/Safari.`
    );
    return;
  }

  cameraBg.srcObject = stream;
  cameraBg.style.display = 'block';
  await new Promise(r => { cameraBg.onloadedmetadata = r; });

  // Three.js
  initThree();

  // Sensores
  window.addEventListener('deviceorientation', onOrientation, true);
  window.addEventListener('devicemotion',      onMotion,      true);

  // Controles táctiles (mitad inferior = adelante, mitad superior = atrás)
  setupTouchControls();

  // Mostrar experiencia
  spinOff();
  splash.style.display = 'none';
  hud.style.display = 'block';
  btnPlace.style.display = 'block';

  showHud('Cargando modelos...');
  await loadPortal();
  showHud('Pulsa "Colocar portal" y luego muévete hacia él');

  btnPlace.addEventListener('click', placePortal, { once: true });
  renderer.setAnimationLoop(renderLoop);
}

// ═══════════════════════════════════════════════════════════════
// Three.js setup
// ═══════════════════════════════════════════════════════════════
function initThree() {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha:     true,
    stencil:   true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  scene = new THREE.Scene();

  // Cámara SIEMPRE en el origen — solo rota
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 0, 0);
  scene.add(camera);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(2, 5, 3);
  scene.add(sun);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// ═══════════════════════════════════════════════════════════════
// Controles táctiles de movimiento
// ═══════════════════════════════════════════════════════════════
function setupTouchControls() {
  // No capturamos touch en el botón "Colocar portal"
  const canvas = renderer?.domElement;

  document.addEventListener('touchstart', e => {
    if (!portalPlaced) return;
    // Ignorar toques en botones de UI
    if (e.target.tagName === 'BUTTON') return;

    const y = e.touches[0].clientY;
    const midY = window.innerHeight / 2;
    // Mitad inferior → avanzar; mitad superior → retroceder
    moveIntent = y > midY ? 'forward' : 'backward';
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => {
    moveIntent = null;
  }, { passive: true });

  document.addEventListener('touchcancel', () => {
    moveIntent = null;
  }, { passive: true });
}

// ═══════════════════════════════════════════════════════════════
// Giroscopio → Rotación de la cámara
// ═══════════════════════════════════════════════════════════════
function onOrientation(e) {
  if (e.alpha === null) return;
  orientationReady = true;

  const alpha = THREE.MathUtils.degToRad(e.alpha  ?? 0);
  const beta  = THREE.MathUtils.degToRad(e.beta   ?? 0);
  const gamma = THREE.MathUtils.degToRad(e.gamma  ?? 0);
  const angle = THREE.MathUtils.degToRad(
    window.screen?.orientation?.angle ?? window.orientation ?? 0
  );

  _euler.set(beta, alpha, -gamma, 'YXZ');
  deviceQuat.setFromEuler(_euler);
  deviceQuat.multiply(_corrQ);
  _screenQ.setFromAxisAngle(_zAxis, -angle);
  deviceQuat.multiply(_screenQ);

  camera.quaternion.copy(deviceQuat);
}

// ═══════════════════════════════════════════════════════════════
// Acelerómetro → Complemento de movimiento (si event.acceleration disponible)
// ═══════════════════════════════════════════════════════════════
function onMotion(event) {
  if (!portalPlaced || !portalGroup) return;

  // Usar linear acceleration (sin gravedad) — más limpio
  const lin = event.acceleration;
  if (!lin || lin.x === null || lin.x === undefined) return;

  // Dirección de avance en el mundo (horizontal)
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(deviceQuat);
  fwd.y = 0;
  if (fwd.lengthSq() < 0.001) return;
  fwd.normalize();

  // Aceleración del dispositivo → al mundo
  const accWorld = new THREE.Vector3(lin.x ?? 0, lin.y ?? 0, lin.z ?? 0)
    .applyQuaternion(deviceQuat);

  // Componente en la dirección de avance
  const fwdAcc = accWorld.dot(fwd);

  // Zona muerta: ignorar ruido
  if (Math.abs(fwdAcc) < ACC_DEAD_ZONE) {
    lastFwdAcc *= 0.7;
    return;
  }

  // Suavizar con filtro de paso bajo
  lastFwdAcc = lastFwdAcc * 0.5 + fwdAcc * 0.5;

  // Acumular velocidad del portal desde acelerómetro
  // (solo si el toque no está activo para evitar conflicto)
  if (moveIntent === null) {
    portalVelocity += -lastFwdAcc * 0.015; // negativo: avanzar = acercar portal
    portalVelocity = THREE.MathUtils.clamp(portalVelocity, -0.6, 0.6);
  }
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
// Colocar portal en el mundo
// ═══════════════════════════════════════════════════════════════
function placePortal() {
  if (!portalGroup || portalPlaced) return;

  // Dirección hacia la que apunta el teléfono (horizontal)
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(deviceQuat);
  fwd.y = 0;
  fwd.normalize();

  // Portal a 3 metros adelante, centrado en X/Z, base en Y = -1
  // (cámara en Y=0, base del portal a -1m = 1m debajo de los ojos)
  portalGroup.position.set(
    fwd.x * 3.0,
    -1.0,   // base del portal (el portal mide 2.2m, llega a Y=+1.2)
    fwd.z * 3.0
  );

  // El portal mira a la cámara (en el plano horizontal)
  portalGroup.lookAt(0, -1.0, 0); // desde su posición, mira al origen

  scene.add(portalGroup);
  portalPlaced = true;
  btnPlace.style.display = 'none';
  showHud('Camina (toca parte inferior) para avanzar · Parte superior para retroceder');
}

// ═══════════════════════════════════════════════════════════════
// Render loop
// ═══════════════════════════════════════════════════════════════
function renderLoop(timestamp) {
  const dt = lastFrameTime > 0
    ? Math.min((timestamp - lastFrameTime) * 0.001, 0.05) // cap a 50ms
    : 0.016;
  lastFrameTime = timestamp;

  // ── Rotación de cámara por giroscopio ────────────────────
  // (ya se aplica en onOrientation; aquí solo hacemos el leve balanceo si falta)
  if (!orientationReady) {
    const t = timestamp * 0.001;
    camera.rotation.set(Math.sin(t * 0.3) * 0.015, Math.sin(t * 0.2) * 0.03, 0);
  }

  // ── Movimiento del portal ─────────────────────────────────
  if (portalPlaced && portalGroup) {
    // Toque táctil: source of truth cuando se está tocando
    if (moveIntent === 'forward') {
      portalVelocity = THREE.MathUtils.lerp(portalVelocity, -MOVE_SPEED_TOUCH, 0.15);
    } else if (moveIntent === 'backward') {
      portalVelocity = THREE.MathUtils.lerp(portalVelocity, MOVE_SPEED_TOUCH, 0.15);
    } else {
      // Frenar suavemente al soltar
      portalVelocity *= 0.85;
      if (Math.abs(portalVelocity) < 0.002) portalVelocity = 0;
    }

    // Aplicar velocidad al portal a lo largo del eje cámara→portal
    if (Math.abs(portalVelocity) > 0.001) {
      movePortal(portalVelocity * dt);
    }

    // Detectar cruce
    checkCrossing();
  }

  // ── Renderizar ────────────────────────────────────────────
  renderer.clear(true, true, true);
  renderer.render(scene, camera);
}

// ═══════════════════════════════════════════════════════════════
// Mover el portal a lo largo del eje cámara↔portal
// ═══════════════════════════════════════════════════════════════
const _portalWorldPos = new THREE.Vector3();
const _toPortal       = new THREE.Vector3();

function movePortal(delta) {
  // Vector del PORTAL al ORIGEN (donde está la cámara)
  portalGroup.getWorldPosition(_portalWorldPos);
  _toPortal.copy(_portalWorldPos).negate().setY(0).normalize();

  // delta > 0 = portal se aleja (retroceder)
  // delta < 0 = portal se acerca (avanzar)
  // Movemos el portal en la dirección opuesta al delta
  portalGroup.position.addScaledVector(_toPortal, delta);

  // Límites: el portal no puede pasar por el origen ni alejarse más de 8m
  const dist = _portalWorldPos.length();
  if (delta < 0 && dist < 0.4) {
    // portal demasiado cerca: bloquear avance extremo
    portalGroup.position.addScaledVector(_toPortal, -delta); // revertir
    portalVelocity = 0;
  }
  if (delta > 0 && dist > 7.5) {
    portalGroup.position.addScaledVector(_toPortal, -delta); // revertir
    portalVelocity = 0;
  }
}

// ═══════════════════════════════════════════════════════════════
// Detección de cruce del portal
// ═══════════════════════════════════════════════════════════════
const _cp = new THREE.Vector3();
const _pp = new THREE.Vector3();
const _fw = new THREE.Vector3();
const _tp = new THREE.Vector3();

function checkCrossing() {
  camera.getWorldPosition(_cp);         // siempre en el origen
  portalGroup.getWorldPosition(_pp);
  portalGroup.getWorldDirection(_fw);
  _tp.subVectors(_cp, _pp);

  const dist    = _cp.distanceTo(_pp);
  const nowIn   = (_tp.dot(_fw) < 0) && (dist < 4.5);

  if (nowIn && !insidePortal) {
    insidePortal = true;
    onEnterPortal();
  } else if (!nowIn && insidePortal) {
    insidePortal = false;
    onExitPortal();
  }

  // HUD con distancia
  if (!insidePortal && portalPlaced) {
    if (dist < 1.2) {
      showHud('¡Sigue avanzando!');
    } else if (dist < 4.0) {
      showHud(`Portal a ${dist.toFixed(1)}m · Toca la pantalla para moverte`);
    }
  }
}

function onEnterPortal() {
  if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(false);
  cameraBg.style.transition = 'opacity 0.5s ease';
  cameraBg.style.opacity = '0.1';
  showHud('¡Estás dentro! · Parte superior de pantalla para salir');
}

function onExitPortal() {
  if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(true);
  cameraBg.style.transition = 'opacity 0.5s ease';
  cameraBg.style.opacity = '1';
  showHud('Camina hacia el portal para entrar');
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
