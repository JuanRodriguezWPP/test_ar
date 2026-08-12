import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ═══════════════════════════════════════════════════════════════
// UI refs
// ═══════════════════════════════════════════════════════════════
const splash = document.getElementById('splash');
const splashLoading = document.getElementById('splash-loading');
const statusEl = document.getElementById('status-text');
const btnOpen = document.getElementById('btn-open');
const errorMsg = document.getElementById('error-msg');
const hud = document.getElementById('hud');
const btnPlace = document.getElementById('btn-place');
const cameraBg = document.getElementById('camera-bg');

// ═══════════════════════════════════════════════════════════════
// Three.js state
// ═══════════════════════════════════════════════════════════════
let renderer, scene, camera;
let portalGroup = null;
let portalPlaced = false;
let insidePortal = false;
// ═══════════════════════════════════════════════════════════════
// Orientación de la cámara (Fusión Nativa + SLERP)
// ═══════════════════════════════════════════════════════════════
const targetQuat = new THREE.Quaternion();
const deviceQuat = new THREE.Quaternion(); // Quaternion suavizado
let orientationInitialized = false;

const _euler = new THREE.Euler();
// Corrección: sistema del acelerómetro (Z↑) → sistema de Three.js (Y↑)
const _corrQ = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _screenQ = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
let gyroReady = false;
let lastMotionTs = 0;

// ═══════════════════════════════════════════════════════════════
// LOCOMOCIÓN — Detección de pasos FIABLE (pico-valle en magnitud)
//
// POR QUÉ pico-valle y no event.acceleration continuo:
//   • event.acceleration (sin gravedad) devuelve null en ~60% de iOS/Android
//   • accelerationIncludingGravity SIEMPRE está disponible (100% dispositivos)
//   • La magnitud oscila entre 7-13 m/s² al caminar → pico-valle muy confiable
//
// La fluidez se consigue con física de velocidad:
//   • onStep() impulsa walkVelocity hacia WALK_SPEED con lerp 0.8
//   • Mientras se camina: fricción casi nula (velocidad constante entre pasos)
//   • Al parar: fricción normal (velocidad decae en ~0.5s)
// ═══════════════════════════════════════════════════════════════

// ── Detección de pasos ─────────────────────────────────────────
const STEP_HIGH = 10.8;  // m/s² — umbral pico del paso
const STEP_LOW = 9.0;   // m/s² — umbral valle del paso
const STEP_GAP_MS = 210;   // ms mínimos entre pasos (~4.7 pasos/s máx)
let smoothMag = 9.81;  // magnitud suavizada (arranca en g)
let peakSeen = false;
let lastStepMs = 0;

// ── Velocidad y fricción diferenciada ─────────────────────────
const WALK_SPEED = 1.8;   // m/s objetivo al caminar (velocidad natural)
const FRICTION_WALK = 0.8;   // fricción MIENTRAS camina (muy baja → fluido)
const FRICTION_STOP = 5.0;   // fricción AL PARAR (decae en ~0.5s)
const WALK_EXPIRE_MS = 450;  // ms que se mantiene el estado "caminando" tras un paso
let walkingExpireMs = 0;

// ── Desplazamiento del portal ──────────────────────────────────
let portalOffset = 0;    // metros que el portal se ha acercado (+ = cerca)
let walkVelocity = 0;    // m/s sobre el eje del portal
const MAX_DIST = 8.0;

// ── Exploración dentro del portal ─────────────────────────────
const innerPos = new THREE.Vector3();
const innerVelocity = new THREE.Vector3();
const MAX_INNER = 3.5;

// ── Vectores de trabajo (pre-alojados, evitan GC en el loop) ──
const _camFwd = new THREE.Vector3();

// ── Raycaster + touch ─────────────────────────────────────────
const DRAG_THRESHOLD = 12;

// ── Eje y origen del portal ───────────────────────────────────
const portalOrigin = new THREE.Vector3();
const portalAxisDir = new THREE.Vector3();

// ═══════════════════════════════════════════════════════════════
// INICIO
// ═══════════════════════════════════════════════════════════════
splash.addEventListener('click', () => launch(), { once: true });

async function launch() {
  splashLoading.classList.add('on');
  showStatus('Solicitando permisos...');

  // iOS 13+: permisos de sensores deben pedirse en gesto del usuario
  for (const E of [DeviceOrientationEvent, DeviceMotionEvent]) {
    if (typeof E?.requestPermission === 'function') {
      try { await E.requestPermission(); } catch (_) { }
    }
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    });
  } catch (e) {
    showError(
      `No se pudo abrir la cámara.\n\nError: ${e.name}\n${e.message}\n\n` +
      `• Acepta el permiso de cámara.\n` +
      `• El sitio debe ser HTTPS.\n` +
      `• En Ajustes, dale permiso de cámara a Chrome/Safari.`
    );
    return;
  }

  cameraBg.srcObject = stream;
  cameraBg.style.display = 'block';
  await new Promise(r => { cameraBg.onloadedmetadata = r; });

  initThree();
  window.addEventListener('deviceorientation', onOrientation, true);
  window.addEventListener('devicemotion', onMotion, true);
  setupTouch();

  splashLoading.classList.remove('on');
  splash.style.display = 'none';
  hud.style.display = 'block';
  btnPlace.style.display = 'block';

  showHud('Cargando portal McCORMICK...');
  await loadPortal();
  showHud('Pulsa el botón para colocar el portal frente a ti');

  btnPlace.addEventListener('click', placePortal, { once: true });
  renderer.setAnimationLoop(renderLoop);
}

// ═══════════════════════════════════════════════════════════════
// Three.js setup
// ═══════════════════════════════════════════════════════════════
function initThree() {
  renderer = new THREE.WebGLRenderer({
    antialias: true, alpha: true, stencil: true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  scene = new THREE.Scene();

  // La cámara está en el origen. Rota con Madgwick.
  // Cuando el usuario cruza el portal, se traslada con innerPos.
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
  camera.position.set(0, 0, 0);
  scene.add(camera);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(2, 5, 3);
  scene.add(sun);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// ═══════════════════════════════════════════════════════════════
// Touch: tap corto → CTA | drag → rotar modelo GLB
// ═══════════════════════════════════════════════════════════════
function setupTouch() {
  let tapStartX = 0, tapStartY = 0, isDragging = false;

  document.addEventListener('touchstart', e => {
    if (e.target.closest('button')) return;
    tapStartX = e.touches[0].clientX;
    tapStartY = e.touches[0].clientY;
    isDragging = false;
    if (insidePortal && portalGroup?.userData.onTouchStart) {
      portalGroup.userData.onTouchStart();
    }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!insidePortal || !portalPlaced) return;
    const dx = e.touches[0].clientX - tapStartX;
    const dy = e.touches[0].clientY - tapStartY;
    if (!isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
      isDragging = true;
    }
    if (isDragging && portalGroup?.userData.onTouchDrag) {
      portalGroup.userData.onTouchDrag(dx, dy);
      tapStartX = e.touches[0].clientX;
      tapStartY = e.touches[0].clientY;
    }
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (insidePortal && portalGroup?.userData.onTouchEnd) portalGroup.userData.onTouchEnd();
    if (!isDragging && insidePortal && portalGroup?.userData.getPaprika) {
      const paprika = portalGroup.userData.getPaprika();
      if (paprika) {
        scene.updateMatrixWorld(true);
        const nx = (tapStartX / window.innerWidth) * 2 - 1;
        const ny = -(tapStartY / window.innerHeight) * 2 + 1;
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
        const ctaHit = rc.intersectObject(paprika, true).find(h => h.object.name === 'CTA_Plane');
        if (ctaHit) {
          showHud('¡Abriendo tienda McCormick!');
          window.open('https://www.mccormick.com/', '_blank');
        }
      }
    }
    isDragging = false;
  }, { passive: true });
}

// ═══════════════════════════════════════════════════════════════
// DeviceOrientation → Fallback de orientación
// Solo se usa cuando Madgwick no recibe rotationRate (algunos Android/iOS)
function onOrientation(e) {
  if (e.alpha === null) return;
  gyroReady = true;

  _euler.set(
    THREE.MathUtils.degToRad(e.beta ?? 0),
    THREE.MathUtils.degToRad(e.alpha ?? 0),
    THREE.MathUtils.degToRad(-(e.gamma ?? 0)),
    'YXZ'
  );
  targetQuat.setFromEuler(_euler);
  targetQuat.multiply(_corrQ);
  _screenQ.setFromAxisAngle(
    _zAxis,
    -THREE.MathUtils.degToRad(window.screen?.orientation?.angle ?? window.orientation ?? 0)
  );
  targetQuat.multiply(_screenQ);

  if (!orientationInitialized) {
    deviceQuat.copy(targetQuat);
    orientationInitialized = true;
  }
}

// ═══════════════════════════════════════════════════════════════
// DeviceMotion:
// ═══════════════════════════════════════════════════════════════
function onMotion(event) {
  const now = performance.now();
  const accG = event.accelerationIncludingGravity;
  if (!accG || accG.x === null) return;

  let ax = accG.x ?? 0;
  let ay = accG.y ?? 0;
  let az = accG.z ?? 0;

  const isIOS = [
    'iPad Simulator', 'iPhone Simulator', 'iPod Simulator', 'iPad', 'iPhone', 'iPod'
  ].includes(navigator.platform) || (navigator.userAgent.includes("Mac") && "ontouchend" in document);

  if (isIOS) {
    ax = -ax;
    ay = -ay;
    az = -az;
  }

  // ── Detección de pasos — solo cuando el portal está puesto ──
  if (!portalPlaced) return;

  const rawMag = Math.sqrt(ax * ax + ay * ay + az * az);
  smoothMag = smoothMag * 0.5 + rawMag * 0.5;

  if (!peakSeen && smoothMag > STEP_HIGH) {
    peakSeen = true;
  }

  if (peakSeen && smoothMag < STEP_LOW) {
    peakSeen = false;
    const elapsed = now - lastStepMs;
    if (elapsed > STEP_GAP_MS) {
      lastStepMs = now;
      onStep(now);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
function onStep(now) {
  _camFwd.set(0, 0, -1).applyQuaternion(deviceQuat);
  _camFwd.y = 0;
  if (_camFwd.lengthSq() < 0.0001) return;
  _camFwd.normalize();

  if (insidePortal) {
    walkingExpireMs = now + WALK_EXPIRE_MS;
    innerVelocity.addScaledVector(_camFwd, WALK_SPEED * 0.8);
    const spd = innerVelocity.length();
    if (spd > WALK_SPEED * 1.5) innerVelocity.multiplyScalar((WALK_SPEED * 1.5) / spd);

  } else {
    const dot = _camFwd.dot(portalAxisDir);
    const direction = dot > 0.15 ? 1 : dot < -0.15 ? -1 : 0;
    if (direction === 0) return;

    walkingExpireMs = now + WALK_EXPIRE_MS;
    walkVelocity = THREE.MathUtils.lerp(walkVelocity, direction * WALK_SPEED, 0.8);
  }
}

// ═══════════════════════════════════════════════════════════════
// Cargar portal 3D
// ═══════════════════════════════════════════════════════════════
async function loadPortal() {
  const loader = new GLTFLoader();
  const { buildPortalGroup } = await import('./portal.js');
  portalGroup = await buildPortalGroup(loader);

  // Pre-compilar shaders en la memoria caché del GPU:
  scene.add(portalGroup);
  renderer.compile(scene, camera);
  scene.remove(portalGroup);
}

// ═══════════════════════════════════════════════════════════════
// Colocar el portal en la escena
// ═══════════════════════════════════════════════════════════════
function placePortal() {
  if (!portalGroup || portalPlaced) return;

  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(deviceQuat);
  fwd.y = 0;
  fwd.normalize();

  portalOrigin.set(fwd.x * 3.5, -1.3, fwd.z * 3.5);
  portalAxisDir.copy(fwd);

  portalGroup.position.copy(portalOrigin);
  portalGroup.lookAt(0, -1.3, 0);

  scene.add(portalGroup);
  portalPlaced = true;
  portalOffset = 0;
  walkVelocity = 0;
  walkingExpireMs = 0;

  btnPlace.style.display = 'none';
  showHud('Camina hacia el portal para entrar');
}

// ═══════════════════════════════════════════════════════════════
// Render loop
// ═══════════════════════════════════════════════════════════════
function renderLoop(time) {
  const dt = lastTs > 0 ? (time - lastTs) / 1000 : 0;
  lastTs = time;

  // Filtro SLERP (Amortiguador esférico)
  if (orientationInitialized) {
    deviceQuat.slerp(targetQuat, Math.min(12.0 * (dt || 0.016), 1.0));
    camera.quaternion.copy(deviceQuat);
  }

  if (!gyroReady) camera.rotation.set(0, 0, 0);

  // Tick del portal: animaciones internas + parallax de la esfera
  if (portalGroup?.userData.tick) portalGroup.userData.tick(time, portalOffset, deviceQuat);

  if (portalPlaced) {
    const now = performance.now();
    const isWalking = now < walkingExpireMs;

    // Fricción diferenciada (frame-rate independent):
    //   Mientras camina: FRICTION_WALK=0.8 → casi no frena entre pasos (fluido)
    //   Al parar:        FRICTION_STOP=5.0 → para en ~0.5s (natural)
    const friction = isWalking ? FRICTION_WALK : FRICTION_STOP;
    const dampFactor = Math.max(0, 1 - friction * dt);

    if (insidePortal) {
      // ── Exploración dentro del portal ────────────────────────
      innerVelocity.multiplyScalar(dampFactor);

      const speed = innerVelocity.length();
      if (speed > 0.005) {
        innerPos.x = THREE.MathUtils.clamp(innerPos.x + innerVelocity.x * dt, -MAX_INNER, MAX_INNER);
        innerPos.z = THREE.MathUtils.clamp(innerPos.z + innerVelocity.z * dt, -MAX_INNER, MAX_INNER);
        camera.position.x = innerPos.x;
        camera.position.z = innerPos.z;

        // Head bobbing proporcional a la velocidad de desplazamiento
        const bobbingAmt = Math.sin(ts * 0.007) * Math.min(speed * 0.03, 0.05);
        camera.position.y = THREE.MathUtils.lerp(camera.position.y, bobbingAmt, 8.0 * dt);
      } else {
        camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0, 5.0 * dt);
      }

    } else {
      // ── Locomoción hacia / desde el portal ───────────────────
      walkVelocity *= dampFactor;

      if (Math.abs(walkVelocity) > 0.003) {
        portalOffset = THREE.MathUtils.clamp(
          portalOffset + walkVelocity * dt,
          -MAX_DIST,
          MAX_DIST
        );
        applyPortalOffset();

        // Head bobbing proporcional a la velocidad
        const bobbingAmt = Math.abs(walkVelocity) > 0.1
          ? Math.sin(ts * 0.007) * Math.min(Math.abs(walkVelocity) * 0.035, 0.065)
          : 0;
        camera.position.y = THREE.MathUtils.lerp(camera.position.y, bobbingAmt, 8.0 * dt);
      } else {
        camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0, 5.0 * dt);
      }
    }

    checkCrossing();
  }

  renderer.clear(true, true, true);
  renderer.render(scene, camera);
}

// ═══════════════════════════════════════════════════════════════
// Helper: mover el portal según portalOffset
// ═══════════════════════════════════════════════════════════════
function applyPortalOffset() {
  if (!portalGroup || !portalPlaced) return;
  // offset positivo → portal se acerca a la cámara (usuario avanza)
  portalGroup.position
    .copy(portalOrigin)
    .addScaledVector(portalAxisDir, -portalOffset);
}

// ═══════════════════════════════════════════════════════════════
// Detección de cruce del portal
// ═══════════════════════════════════════════════════════════════
function checkCrossing() {
  // El portal se colocó a 3.5m → cruce cuando el offset supera 3.6m
  const threshold = 3.6;
  const nowInside = portalOffset >= threshold;

  if (nowInside && !insidePortal) {
    insidePortal = true;
    onEnterPortal();
  } else if (!nowInside && insidePortal) {
    insidePortal = false;
    onExitPortal();
  }

  if (!insidePortal) {
    const remaining = Math.max(0, threshold - portalOffset).toFixed(1);
    if (portalOffset > 0.3) {
      showHud(`Faltan ~${remaining}m para entrar`);
    } else {
      showHud('Camina hacia el portal para entrar');
    }
  }
}

function onEnterPortal() {
  if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(false);
  cameraBg.style.transition = 'opacity 0.8s ease';
  cameraBg.style.opacity = '0';
  showHud('¡Bienvenido al mundo McCORMICK!');
}

function onExitPortal() {
  if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(true);
  cameraBg.style.transition = 'opacity 0.5s ease';
  cameraBg.style.opacity = '1';
  showHud('Camina hacia el portal para entrar');

  // Resetear posición interna al salir
  innerPos.set(0, 0, 0);
  innerVelocity.set(0, 0, 0);
  camera.position.x = 0;
  camera.position.z = 0;
}

// ═══════════════════════════════════════════════════════════════
// Helpers UI
// ═══════════════════════════════════════════════════════════════
function showStatus(msg) { if (statusEl) statusEl.textContent = msg; }
function showHud(msg) { hud.textContent = msg; }
function showError(msg) {
  splashLoading.classList.add('on');
  showStatus('');
  errorMsg.style.display = 'block';
  errorMsg.textContent = msg;
  btnOpen.textContent = 'Reintentar';
  btnOpen.style.display = 'block';
  btnOpen.addEventListener('click', () => location.reload(), { once: true });
}