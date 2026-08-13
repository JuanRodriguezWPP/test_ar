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
let lastTs = 0;

// ═══════════════════════════════════════════════════════════════
// Orientación de la cámara — DeviceOrientationEvent
//
// POR QUÉ DeviceOrientationEvent y NO Madgwick + sensores raw:
//   • DeviceOrientationEvent (alpha/beta/gamma) es normalizado por el
//     navegador Chrome/Safari INTERNAMENTE para cada fabricante Android.
//   • DeviceMotionEvent.rotationRate NO está normalizado: cada fabricante
//     (Samsung, Xiaomi, Motorola, Pixel, OnePlus...) mapea los ejes del
//     giroscopio de forma diferente a nivel de hardware.
//   • El filtro Madgwick consumía estos datos raw, lo que funcionaba en
//     el Redmi de desarrollo pero producía quaternions con ejes
//     invertidos/rotados en cualquier otro dispositivo.
//   • El navegador ya aplica fusión de sensores (Kalman/Complementary)
//     internamente, por lo que no necesitamos un filtro adicional.
//
// Esta es la misma técnica que usaba THREE.DeviceOrientationControls,
// probada en millones de dispositivos durante años.
// ═══════════════════════════════════════════════════════════════
const deviceQuat = new THREE.Quaternion();
const _euler = new THREE.Euler();
// Corrección: sistema del dispositivo (Z↑) → sistema de Three.js (Y↑)
// Rotación de -90° alrededor del eje X.
const _corrQ = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _screenQ = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
let gyroReady = false;

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

// ── Sistema Unificado de Locomoción Espacial ──────────────────
const virtualPos = new THREE.Vector3();
const userVelocity = new THREE.Vector3();
const MAX_DIST = 8.0; // Radio máximo de caminata desde el centro del portal

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

  // BUG 5 FIX: Bloquear orientación a portrait para evitar desalineación
  try {
    await screen.orientation.lock('portrait-primary');
  } catch (_) { /* No soportado o no permitido — OK, continuamos */ }

  // iOS 13+: permisos de sensores deben pedirse en gesto del usuario
  const sensorEvents = [window.DeviceOrientationEvent, window.DeviceMotionEvent];
  for (const E of sensorEvents) {
    if (E && typeof E.requestPermission === 'function') {
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

  // La cámara está en el origen. Rota con DeviceOrientationEvent.
  // Cuando el usuario cruza el portal, se traslada con virtualPos.
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
// DeviceOrientation — FUENTE PRIMARIA Y ÚNICA de orientación
//
// El navegador Chrome/Safari normaliza internamente alpha/beta/gamma
// para cada fabricante Android (Samsung, Xiaomi, Motorola, Pixel, etc.).
// Esto garantiza compatibilidad universal sin depender de datos raw
// de rotationRate que varían entre dispositivos.
//
// Conversión estándar: Euler(beta, alpha, -gamma, 'YXZ') + corrección Z↑→Y↑
// (misma técnica de THREE.DeviceOrientationControls, probada en millones
// de dispositivos).
// ═══════════════════════════════════════════════════════════════
function onOrientation(e) {
  if (e.alpha === null) return;
  gyroReady = true;

  // Conversión estándar W3C → Three.js quaternion:
  //   Euler X = beta  (pitch: inclinación adelante/atrás)
  //   Euler Y = alpha (yaw: giro horizontal / brújula)
  //   Euler Z = -gamma (roll: ladeo izquierda/derecha, negado por convención)
  //   Orden: 'YXZ' (estándar para cámaras AR/VR)
  _euler.set(
    THREE.MathUtils.degToRad(e.beta  ?? 0),
    THREE.MathUtils.degToRad(e.alpha ?? 0),
    THREE.MathUtils.degToRad(-(e.gamma ?? 0)),
    'YXZ'
  );
  deviceQuat.setFromEuler(_euler);

  // Corrección de sistema de coordenadas: Z↑ (sensor) → Y↑ (Three.js)
  deviceQuat.multiply(_corrQ);

  // Corrección de rotación de pantalla (portrait/landscape)
  const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;
  _screenQ.setFromAxisAngle(_zAxis, -THREE.MathUtils.degToRad(screenAngle));
  deviceQuat.multiply(_screenQ);

  camera.quaternion.copy(deviceQuat);
}

// ═══════════════════════════════════════════════════════════════
// DeviceMotion — SOLO detección de pasos (locomoción)
//
// accelerationIncludingGravity SIEMPRE está disponible (100% iOS y Android).
// La magnitud (invariante al signo) se usa para detección pico-valle.
// NO se usa para orientación (eso lo hace DeviceOrientationEvent).
// ═══════════════════════════════════════════════════════════════
function onMotion(event) {
  const now = performance.now();

  const accG = event.accelerationIncludingGravity;
  if (!accG || accG.x === null) return;

  // Solo detección de pasos — el portal debe estar puesto
  if (!portalPlaced) return;

  const ax = accG.x ?? 0;
  const ay = accG.y ?? 0;
  const az = accG.z ?? 0;
  const rawMag = Math.sqrt(ax * ax + ay * ay + az * az);

  // EMA ligero (0.5/0.5) para preservar picos sin demasiado jitter
  smoothMag = smoothMag * 0.5 + rawMag * 0.5;

  // Fase 1: detectar pico (inicio del paso)
  if (!peakSeen && smoothMag > STEP_HIGH) {
    peakSeen = true;
  }

  // Fase 2: detectar valle después del pico (final del paso)
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
// onStep — se llama cada vez que se detecta un paso físico
//
// DIRECCIÓN: dot product entre camFwd y portalAxisDir.
//   dot > 0  → usuario mira hacia el portal  → AVANZAR  (portal se acerca)
//   dot < 0  → usuario mira lejos del portal → RETROCEDER (portal se aleja)
//
// FLUIDEZ: lerp del 80% hacia WALK_SPEED. Cada paso refresca la velocidad
//   sin saltos bruscos. La fricción diferenciada mantiene la velocidad
//   entre pasos cuando se sigue caminando.
// ═══════════════════════════════════════════════════════════════
function onStep(now) {
  // BUG 7 FIX: Usar camera.quaternion (siempre actualizado) en vez de deviceQuat
  // (que podía estar desactualizado si Madgwick no se activaba).
  // Vector hacia adelante de la cámara proyectado en el plano XZ
  _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _camFwd.y = 0;
  if (_camFwd.lengthSq() < 0.0001) return; // sin orientación todavía
  _camFwd.normalize();

  // El impulso SIEMPRE se da en la dirección de la mirada.
  // Ya no hay divisiones "adentro" o "afuera" del portal, el espacio es continuo.
  // Esto permite girar físicamente y salir caminando del portal.
  walkingExpireMs = now + WALK_EXPIRE_MS;
  userVelocity.addScaledVector(_camFwd, WALK_SPEED * 0.8);
  
  // Limitar velocidad máxima de la caminata
  const spd = userVelocity.length();
  if (spd > WALK_SPEED * 1.5) {
    userVelocity.multiplyScalar((WALK_SPEED * 1.5) / spd);
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
// Colocar el portal en la escena
// ═══════════════════════════════════════════════════════════════
function placePortal() {
  if (!portalGroup || portalPlaced) return;

  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  fwd.y = 0;
  fwd.normalize();

  // Portal a 3.5m enfrente, bajado 1.3m para centrar verticalmente en la pantalla
  portalOrigin.set(fwd.x * 3.5, -1.3, fwd.z * 3.5);
  portalAxisDir.copy(fwd);

  portalGroup.position.copy(portalOrigin);
  portalGroup.lookAt(0, -1.3, 0);

  scene.add(portalGroup);
  portalPlaced = true;
  virtualPos.set(0, 0, 0);
  userVelocity.set(0, 0, 0);
  walkingExpireMs = 0;

  btnPlace.style.display = 'none';
  showHud('Camina hacia el portal para entrar');
}

// ═══════════════════════════════════════════════════════════════
// Render loop
// ═══════════════════════════════════════════════════════════════
function renderLoop(ts) {
  const dt = lastTs > 0 ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
  lastTs = ts;

  if (!gyroReady) camera.rotation.set(0, 0, 0);

  // Tick del portal: animaciones internas + parallax de la esfera
  // La distancia ahora se mide desde el virtualPos
  const toUser = virtualPos.clone().sub(portalOrigin);
  const portalProgress = toUser.dot(portalAxisDir) + 3.5;
  if (portalGroup?.userData.tick) portalGroup.userData.tick(ts, portalProgress, camera.quaternion);

  if (portalPlaced) {
    const now = performance.now();
    const isWalking = now < walkingExpireMs;

    // Fricción diferenciada (frame-rate independent):
    const friction = isWalking ? FRICTION_WALK : FRICTION_STOP;
    const dampFactor = Math.max(0, 1 - friction * dt);

    userVelocity.multiplyScalar(dampFactor);
    const speed = userVelocity.length();

    if (speed > 0.005) {
      virtualPos.addScaledVector(userVelocity, dt);
      
      const offset = virtualPos.clone().sub(portalOrigin);
      if (offset.length() > MAX_DIST) {
        offset.clampLength(0, MAX_DIST);
        virtualPos.copy(portalOrigin).add(offset);
      }

      const bobbingAmt = Math.sin(ts * 0.007) * Math.min(speed * 0.035, 0.065);
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, bobbingAmt, 8.0 * dt);
    } else {
      userVelocity.set(0, 0, 0);
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0, 5.0 * dt);
    }

    // La cámara SIEMPRE se queda en el origen (0,0,0)
    // El mundo entero (portalGroup) se mueve en sentido inverso
    portalGroup.position.copy(portalOrigin).sub(virtualPos);

    checkCrossing(toUser);
  }

  renderer.clear(true, true, true);
  renderer.render(scene, camera);
}



// ═══════════════════════════════════════════════════════════════
// Detección de cruce del portal
// ═══════════════════════════════════════════════════════════════
function checkCrossing(toUserOffset) {
  // Ecuación de plano: calculamos de qué lado del marco de la puerta está el usuario
  const distToPlane = toUserOffset.dot(portalAxisDir);
  
  // Si distToPlane > 0, el usuario ha cruzado físicamente la entrada del portal
  const nowInside = distToPlane > 0;

  if (nowInside && !insidePortal) {
    insidePortal = true;
    onEnterPortal();
  } else if (!nowInside && insidePortal) {
    insidePortal = false;
    onExitPortal();
  }

  if (!insidePortal) {
    const remaining = Math.max(0, -distToPlane).toFixed(1);
    if (remaining > 0.3) {
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