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

// ── Orientación del dispositivo (giroscopio) ──
const deviceQuat = new THREE.Quaternion();
const _euler     = new THREE.Euler();
const _corrQ     = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // corregir eje para pantalla vertical
const _screenQ   = new THREE.Quaternion();
const _zAxis     = new THREE.Vector3(0, 0, 1);
let orientationReady = false;

// ── Posición de la cámara en el mundo 3D ──────────────────────
// El usuario empieza de pie, "1.5 metros de alto", mirando hacia -Z
const camWorldPos = new THREE.Vector3(0, 1.5, 0);

// ── Movimiento por acelerómetro ───────────────────────────────
let moveVelocity  = 0;          // m/s en dirección de avance
const MOVE_SCALE  = 0.5;        // sensibilidad
const MOVE_DAMP   = 0.88;       // amortiguación por frame de evento
const MOVE_MAX    = 1.2;        // velocidad máxima m/s
let motionReady   = false;

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

  // iOS 13+: pedir permiso de sensores de movimiento en un solo gesto
  if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
    try {
      const o = await DeviceOrientationEvent.requestPermission();
      if (o !== 'granted') {
        showError('Necesitas permitir el acceso al giroscopio.\nVe a Ajustes > Safari > Movimiento y orientación.');
        return;
      }
    } catch (e) {
      showError(`Permiso de orientación denegado: ${e.message}`);
      return;
    }
  }

  if (typeof DeviceMotionEvent?.requestPermission === 'function') {
    try {
      const m = await DeviceMotionEvent.requestPermission();
      if (m !== 'granted') {
        showError('Necesitas permitir el acceso al acelerómetro para detectar movimiento.');
        return;
      }
    } catch (e) {
      showError(`Permiso de movimiento denegado: ${e.message}`);
      return;
    }
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
      `No se pudo acceder a la cámara.\n\nError: ${e.name}\n${e.message}\n\n` +
      `• Acepta el permiso de cámara cuando lo solicite.\n` +
      `• Verifica que el sitio sea HTTPS.\n` +
      `• En Ajustes del teléfono, permite la cámara a Chrome/Safari.`
    );
    return;
  }

  cameraBg.srcObject = stream;
  cameraBg.style.display = 'block';
  await new Promise(r => { cameraBg.onloadedmetadata = r; });

  // Three.js
  initThree();

  // Escuchar sensores
  window.addEventListener('deviceorientation', onOrientation, true);
  window.addEventListener('devicemotion',      onMotion,      true);

  // Mostrar experiencia
  spinOff();
  splash.style.display = 'none';
  hud.style.display = 'block';
  btnPlace.style.display = 'block';

  // Cargar portal
  showHud('Cargando modelos...');
  await loadPortal();
  showHud('Mueve el teléfono y pulsa "Colocar portal" para anclarlo');

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

  camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.01, 100
  );
  camera.position.copy(camWorldPos);
  scene.add(camera);

  // Luces
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
// GIROSCOPIO → Orientación de la cámara
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

  // Solo rotación → no modifica posición
  camera.quaternion.copy(deviceQuat);
}

// ═══════════════════════════════════════════════════════════════
// ACELERÓMETRO → Movimiento adelante/atrás
// ═══════════════════════════════════════════════════════════════
function onMotion(event) {
  // Usar accelerationIncludingGravity y quitar la gravedad manualmente
  const raw = event.accelerationIncludingGravity;
  if (!raw || raw.x === null) return;

  const dt = event.interval > 0 ? event.interval : 1 / 60;
  motionReady = true;

  // Aceleración del dispositivo en su propio frame de referencia
  const accDev = new THREE.Vector3(raw.x ?? 0, raw.y ?? 0, raw.z ?? 0);

  // Pasar al frame del mundo usando la orientación actual del dispositivo
  const accWorld = accDev.clone().applyQuaternion(deviceQuat);

  // Quitar gravedad (en el frame del mundo, la gravedad va en -Y ≈ -9.81 m/s²)
  accWorld.y += 9.81;

  // Dirección de avance actual (horizontal) según donde mira el teléfono
  const forward = new THREE.Vector3(0, 0, -1);
  forward.applyQuaternion(deviceQuat);
  forward.y = 0;
  if (forward.lengthSq() < 0.0001) return;
  forward.normalize();

  // Proyectar aceleración del mundo sobre el eje de avance
  const fwdAcc = accWorld.dot(forward);

  // Integrar velocidad con amortiguación
  moveVelocity = moveVelocity * MOVE_DAMP + fwdAcc * dt * MOVE_SCALE;
  moveVelocity = THREE.MathUtils.clamp(moveVelocity, -MOVE_MAX, MOVE_MAX);

  // Si la velocidad es muy pequeña, parar (evita deriva lenta)
  if (Math.abs(moveVelocity) < 0.002) {
    moveVelocity = 0;
    return;
  }

  // Mover la posición de la cámara en el mundo
  camWorldPos.addScaledVector(forward, moveVelocity * dt);

  // Limitar la altura: el usuario siempre camina en Y = 1.5m
  camWorldPos.y = 1.5;
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
// Colocar portal en el mundo 3D
// ═══════════════════════════════════════════════════════════════
function placePortal() {
  if (!portalGroup || portalPlaced) return;

  // Dirección hacia donde mira la cámara en el momento de colocar
  const forward = new THREE.Vector3(0, 0, -1);
  forward.applyQuaternion(deviceQuat);
  forward.y = 0;
  forward.normalize();

  // Colocar el portal 2.5m adelante de la posición actual del usuario
  // La base del portal toca el "suelo" (y = 0)
  portalGroup.position.set(
    camWorldPos.x + forward.x * 2.5,
    0,                              // base del portal en el suelo
    camWorldPos.z + forward.z * 2.5
  );

  // El portal mira de vuelta al usuario
  const lookTarget = new THREE.Vector3(camWorldPos.x, 0, camWorldPos.z);
  portalGroup.lookAt(lookTarget);

  scene.add(portalGroup);
  portalPlaced = true;
  btnPlace.style.display = 'none';
  showHud('Camina hacia el portal para entrar');
}

// ═══════════════════════════════════════════════════════════════
// Render loop principal
// ═══════════════════════════════════════════════════════════════
function renderLoop() {
  // Aplicar la posición del mundo a la cámara Three.js
  // (la rotación ya se aplica en onOrientation)
  camera.position.copy(camWorldPos);

  // Si el giroscopio no tiene datos aún, hacer un leve balanceo cosmético
  if (!orientationReady) {
    const t = performance.now() * 0.001;
    camera.rotation.set(
      Math.sin(t * 0.3) * 0.015,
      Math.sin(t * 0.2) * 0.03,
      0
    );
  }

  // Limpiar buffers (color + depth + stencil)
  renderer.clear(true, true, true);

  // Detectar cruce del portal
  if (portalPlaced && portalGroup) {
    checkCrossing();
  }

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

  // Dot < 0 significa que la cámara está "detrás" del portal (dentro)
  const nowInside = (_tp.dot(_fw) < 0) && (_cp.distanceTo(_pp) < 4.0);

  if (nowInside && !insidePortal) {
    insidePortal = true;
    onEnterPortal();
  } else if (!nowInside && insidePortal) {
    insidePortal = false;
    onExitPortal();
  }

  // Actualizar HUD con distancia al portal si no está dentro
  if (!insidePortal && portalPlaced) {
    const dist = _cp.distanceTo(_pp);
    if (dist < 1.0) {
      showHud('¡Sigue avanzando para entrar!');
    } else if (dist < 2.5) {
      showHud(`Portal a ${dist.toFixed(1)}m · Camina hacia él`);
    }
  }
}

function onEnterPortal() {
  // Abrir el stencil: el usuario ve el interior de la habitación
  if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(false);

  // Atenuar la cámara real (ahora estamos "dentro")
  cameraBg.style.transition = 'opacity 0.6s ease';
  cameraBg.style.opacity = '0.15';

  showHud('¡Estás dentro! · Retrocede para salir');
}

function onExitPortal() {
  // Restaurar stencil
  if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(true);

  // Restaurar la cámara real
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
