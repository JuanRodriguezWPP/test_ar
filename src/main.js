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

// ── Giroscopio (solo rotación de cámara) ─────────────────────
const deviceQuat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _corrQ = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _screenQ = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
let gyroReady = false;

// ── Movimiento ────────────────────────────────────────────────
// La CÁMARA está FIJA en el origen. El PORTAL se acerca o aleja.
// portalOffset > 0  →  portal se acerca (usuario avanza)
// portalOffset < 0  →  portal se aleja  (usuario retrocede)
let portalOffset = 0;   // posición actual interpolada
let targetPortalOffset = 0; // posición objetivo a la que el portal intenta llegar suavemente
let moveVel = 0;   // velocidad actual m/s (para el toque)

// ── Raycaster (para CTA) ──────────────────────────────────────
const raycaster = new THREE.Raycaster();
const screenCenter = new THREE.Vector2(0, 0); // Centro de la pantalla para raycast
let ctaVisible = false;

const TOUCH_SPEED = 2.0;  // m/s con toque (un poco más rápido)
const MAX_DIST = 8.0;  // metros máx que puede alejarse el portal
const STEP_MOVE = 0.8;  // metros que avanza por cada paso (pasos más cortos y frecuentes)

// Touch
let touchIntent = null; // 'fwd' | 'bwd' | null

// ── Detección profesional de pasos (algoritmo pico-valle) ────
// La magnitud del acelerómetro oscila entre ~7 y ~13 m/s² al caminar.
// Un paso = subida por encima de STEP_HIGH + bajada por debajo de STEP_LOW.
const STEP_HIGH = 10.8; // umbral alto (pico del paso)
const STEP_LOW = 9.0;  // umbral bajo  (valle del paso)
const STEP_GAP_MS = 220;  // mínimo ms entre pasos (~4 pasos/s máx)
let smoothMag = 9.81; // magnitud suavizada
let peakSeen = false; // ¿detectamos ya el pico?
let lastStepMs = 0;    // timestamp del último paso
let stepCount = 0;    // contador de pasos (para debug en HUD)

// ═══════════════════════════════════════════════════════════════
// INICIO
// ═══════════════════════════════════════════════════════════════
// Al tocar la pantalla de inicio se lanza la experiencia
splash.addEventListener('click', () => launch(), { once: true });

// ═══════════════════════════════════════════════════════════════
// PASO 1 – Permisos + Cámara
// ═══════════════════════════════════════════════════════════════
async function launch() {
  // Mostrar overlay de carga sobre el splash
  splashLoading.classList.add('on');
  showStatus('Solicitando permisos...');

  // iOS 13+: permisos de sensores (deben pedirse en gesture de usuario)
  for (const E of [DeviceOrientationEvent, DeviceMotionEvent]) {
    if (typeof E?.requestPermission === 'function') {
      try { await E.requestPermission(); } catch (_) { }
    }
  }

  // Abrir cámara trasera
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 640 }, // Reducido para mejor rendimiento
        height: { ideal: 480 }  // Reducido para mejor rendimiento
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

  // Sensores
  window.addEventListener('deviceorientation', onOrientation, true);
  window.addEventListener('devicemotion', onMotion, true);

  // Controles táctiles de movimiento
  setupTouch();

  // Mostrar experiencia
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
  // antialias: true suaviza los bordes dentados
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, powerPreference: 'high-performance' });
  // Aumentar el pixel ratio a 2 para pantallas HD de celulares (antes estaba en 1.25 que se ve muy pixelado)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  scene = new THREE.Scene();

  // Cámara SIEMPRE en el origen — solo rota con giroscopio
  // Aumentamos el far plane a 1000 para que la habitación profunda no se recorte
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

// Touch: mitad inferior = avanzar, mitad superior = retroceder, y click en CTA 3D
// ═══════════════════════════════════════════════════════════════
function setupTouch() {
  document.addEventListener('touchstart', e => {
    if (!portalPlaced) return;
    if (e.target.closest('button')) return; // ignorar botones UI

    // ── INTERACCIÓN 3D (Click en CTA) ──
    if (insidePortal && portalGroup?.userData.getPaprika) {
      const paprika = portalGroup.userData.getPaprika();
      if (paprika) {
        // Actualizar matriz de la escena para asegurar que el Raycaster acierta
        scene.updateMatrixWorld(true);

        const nx = (e.touches[0].clientX / window.innerWidth) * 2 - 1;
        const ny = -(e.touches[0].clientY / window.innerHeight) * 2 + 1;
        
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
        
        const intersects = raycaster.intersectObject(paprika, true);
        const ctaHit = intersects.find(hit => hit.object.name === 'CTA_Plane');
        
        if (ctaHit) {
          showHud('¡Abriendo tienda McCormick!');
          window.open('https://www.mccormick.com.mx', '_blank');
          return; // Detener ejecución para no caminar
        }
      }
    }

    // Movimiento (si no tocó el CTA)
    const y = e.touches[0].clientY;
    touchIntent = y > window.innerHeight * 0.5 ? 'fwd' : 'bwd';
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => { touchIntent = null; }, { passive: true });
  document.addEventListener('touchcancel', () => { touchIntent = null; }, { passive: true });
}

// ═══════════════════════════════════════════════════════════════
// Giroscopio → Solo rotación de la cámara
// ═══════════════════════════════════════════════════════════════
function onOrientation(e) {
  if (e.alpha === null) return;
  gyroReady = true;

  _euler.set(
    THREE.MathUtils.degToRad(e.beta ?? 0),
    THREE.MathUtils.degToRad(e.alpha ?? 0),
    THREE.MathUtils.degToRad(-(e.gamma ?? 0)),
    'YXZ'
  );
  deviceQuat.setFromEuler(_euler);
  deviceQuat.multiply(_corrQ);
  _screenQ.setFromAxisAngle(
    _zAxis,
    -THREE.MathUtils.degToRad(window.screen?.orientation?.angle ?? window.orientation ?? 0)
  );
  deviceQuat.multiply(_screenQ);

  camera.quaternion.copy(deviceQuat);
}

// ═══════════════════════════════════════════════════════════════
// Acelerómetro → Detección de pasos (algoritmo profesional pico-valle)
// ═══════════════════════════════════════════════════════════════
function onMotion(event) {
  if (!portalPlaced) return;

  // accelerationIncludingGravity = SIEMPRE disponible en todos los dispositivos
  const raw = event.accelerationIncludingGravity;
  if (!raw || raw.x === null) return;

  // Magnitud cruda del vector de aceleración
  const rawMag = Math.sqrt((raw.x ?? 0) ** 2 + (raw.y ?? 0) ** 2 + (raw.z ?? 0) ** 2);

  // Suavizado LIGERO (0.45/0.55) — preserva los picos del paso
  // Un filtro más agresivo (0.7/0.3) aplastaba las señales y no detectaba nada
  smoothMag = smoothMag * 0.45 + rawMag * 0.55;

  const now = performance.now();

  // ALGORITMO PICO-VALLE:
  // Fase 1: esperar pico (magnitud supera STEP_HIGH)
  if (!peakSeen && smoothMag > STEP_HIGH) {
    peakSeen = true;
  }

  // Fase 2: después del pico, esperar el valle (magnitud baja de STEP_LOW)
  if (peakSeen && smoothMag < STEP_LOW) {
    peakSeen = false;
    const elapsed = now - lastStepMs;
    // Verificar que sea un paso válido (no ruido muy rápido)
    if (elapsed > STEP_GAP_MS) {
      lastStepMs = now;
      onStep();
    }
  }
}

function onStep() {
  if (touchIntent === 'bwd') return; // si retrocediendo con toque, ignorar pasos

  stepCount++;
  // En lugar de teletransportar la cámara, sumamos al "objetivo"
  // El renderLoop se encargará de deslizar la cámara suavemente hacia ese objetivo
  targetPortalOffset = Math.min(targetPortalOffset + STEP_MOVE, 4.0);
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

// Estas variables guardan la posición y orientación INICIAL del portal
// para que el eje de movimiento (portalOffset) sea correcto
const portalOrigin = new THREE.Vector3(); // posición inicial del portal
const portalAxisDir = new THREE.Vector3(); // dirección de "acercarse" = camera → portal

function placePortal() {
  if (!portalGroup || portalPlaced) return;

  // Dirección hacia donde apunta el teléfono AHORA
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(deviceQuat);
  fwd.y = 0;
  fwd.normalize();

  // Colocar a 2.0m enfrente de la mirada actual y bajarlo 1.3m para centrarlo verticalmente
  portalOrigin.set(fwd.x * 2.0, -1.3, fwd.z * 2.0);
  portalAxisDir.copy(fwd);

  portalGroup.position.copy(portalOrigin);

  // El portal siempre mira hacia la cámara, nivelado
  portalGroup.lookAt(0, -1.3, 0);

  scene.add(portalGroup);
  portalPlaced = true;
  portalOffset = 0;
  targetPortalOffset = 0;
  btnPlace.style.display = 'none';
  showHud('Toca la mitad inferior de la pantalla para avanzar');
}


// ═══════════════════════════════════════════════════════════════
// Render loop
// ═══════════════════════════════════════════════════════════════
function renderLoop(ts) {
  const dt = lastTs > 0 ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
  lastTs = ts;

  // La cámara se queda estática si no hay giroscopio (se elimina el balanceo de flotación)
  if (!gyroReady) {
    camera.rotation.set(0, 0, 0);
  }

  // ── Animación de la Páprika y la profundidad de la esfera ──────────
  if (portalGroup?.userData.tick) portalGroup.userData.tick(ts, portalOffset);

  // ── Movimiento con toque y suavizado de pasos ────
  if (portalPlaced) {
    if (touchIntent === 'fwd') {
      // Mayor aceleración (0.35) para responder más rápido al toque
      moveVel = THREE.MathUtils.lerp(moveVel, TOUCH_SPEED, 0.35);
    } else if (touchIntent === 'bwd') {
      moveVel = THREE.MathUtils.lerp(moveVel, -TOUCH_SPEED, 0.35);
    } else {
      // Frenado más seco al soltar para que no se sienta que resbala (0.60)
      moveVel *= 0.60;
      if (Math.abs(moveVel) < 0.005) moveVel = 0;
    }

    // Aplicar velocidad del toque al objetivo
    if (Math.abs(moveVel) > 0.001) {
      targetPortalOffset = THREE.MathUtils.clamp(targetPortalOffset + moveVel * dt, -MAX_DIST, 4.0);
    }

    // INTERPOLACIÓN SUAVE (Lerp) de la posición actual hacia el objetivo
    if (Math.abs(targetPortalOffset - portalOffset) > 0.001) {
      // 12.0 es el factor de suavizado (mayor = más rígido/responsivo, reduce la sensación de "pegado")
      portalOffset = THREE.MathUtils.lerp(portalOffset, targetPortalOffset, 12.0 * dt);
      applyPortalOffset();
    }

    checkCrossing();
  }

  // La detección del CTA HTML fue removida. Ahora el CTA es un objeto 3D nativo gestionado en portal.js.

  renderer.clear(true, true, true);
  renderer.render(scene, camera);
}

// ═══════════════════════════════════════════════════════════════
// Helper: aplicar portalOffset a la posición del grupo del portal
// ═══════════════════════════════════════════════════════════════
function applyPortalOffset() {
  if (!portalGroup || !portalPlaced) return;
  // portalOffset positivo → portal va en -portalAxisDir → se acerca a la cámara
  portalGroup.position
    .copy(portalOrigin)
    .addScaledVector(portalAxisDir, -portalOffset);
}

// ═══════════════════════════════════════════════════════════════
// Detección de cruce
// ═══════════════════════════════════════════════════════════════
function checkCrossing() {
  // Cuando portalOffset ≥ distancia inicial (2.0m), el portal cruzó la cámara
  const threshold = 2.1;

  const nowInside = portalOffset >= threshold;

  if (nowInside && !insidePortal) {
    insidePortal = true;
    onEnterPortal();
  } else if (!nowInside && insidePortal) {
    insidePortal = false;
    onExitPortal();
  }

  // HUD con distancia y pasos detectados
  if (!insidePortal) {
    const remaining = Math.max(0, (threshold - portalOffset)).toFixed(1);
    if (portalOffset > 0.3) {
      showHud(`Pasos: ${stepCount} · Faltan ~${remaining}m para entrar`);
    } else {
      showHud('Camina o toca abajo para avanzar al portal');
    }
  }
}

function onEnterPortal() {
  if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(false);
  // Fade out cámara real → entorno 360 ocupa todo el espacio visual
  cameraBg.style.transition = 'opacity 0.8s ease';
  cameraBg.style.opacity = '0';
  showHud('¡Bienvenido al mundo McCORMICK! · Toca arriba para salir');
  // El CTA ahora solo se muestra al mirar el producto (gestionado por Raycaster)
}

function onExitPortal() {
  if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(true);
  // Restaurar cámara real al salir
  cameraBg.style.transition = 'opacity 0.5s ease';
  cameraBg.style.opacity = '1';
  showHud('Toca abajo para avanzar al portal');
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
