import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ═══════════════════════════════════════════════════════════════
// UI refs
// ═══════════════════════════════════════════════════════════════
const splash        = document.getElementById('splash');
const splashLoading = document.getElementById('splash-loading');
const statusEl      = document.getElementById('status-text');
const btnOpen       = document.getElementById('btn-open');
const errorMsg      = document.getElementById('error-msg');
const hud           = document.getElementById('hud');
const btnPlace      = document.getElementById('btn-place');
const cameraBg      = document.getElementById('camera-bg');
const btnReset      = document.getElementById('btn-reset');

// ═══════════════════════════════════════════════════════════════
// Three.js state
// ═══════════════════════════════════════════════════════════════
let renderer, scene, camera;
let portalGroup  = null;
let portalPlaced = false;
let insidePortal = false;
let lastTs       = 0;

// ═══════════════════════════════════════════════════════════════
// MADGWICK AHRS — Fusión giroscopio + acelerómetro (inline)
// Sebastian Madgwick (2010). Beta=0.033 es el valor estándar para AR.
// Proporciona un quaternion estable y sin deriva para la orientación.
// ═══════════════════════════════════════════════════════════════
class MadgwickAHRS {
  constructor(beta = 0.033) {
    this.beta = beta;
    this.q0 = 1; this.q1 = 0; this.q2 = 0; this.q3 = 0;
  }

  // gx/gy/gz en rad/s   ax/ay/az en m/s²   dt en segundos
  update(gx, gy, gz, ax, ay, az, dt) {
    let { q0, q1, q2, q3, beta } = this;
    let recipNorm, s0, s1, s2, s3;
    let qDot0, qDot1, qDot2, qDot3;

    qDot0 = 0.5 * (-q1*gx - q2*gy - q3*gz);
    qDot1 = 0.5 * ( q0*gx + q2*gz - q3*gy);
    qDot2 = 0.5 * ( q0*gy - q1*gz + q3*gx);
    qDot3 = 0.5 * ( q0*gz + q1*gy - q2*gx);

    const accMag = Math.sqrt(ax*ax + ay*ay + az*az);
    if (accMag > 0.001) {
      recipNorm = 1.0 / accMag;
      ax *= recipNorm; ay *= recipNorm; az *= recipNorm;

      const _2q0=2*q0, _2q1=2*q1, _2q2=2*q2, _2q3=2*q3;
      const _4q0=4*q0, _4q1=4*q1, _4q2=4*q2;
      const _8q1=8*q1, _8q2=8*q2;
      const q0q0=q0*q0, q1q1=q1*q1, q2q2=q2*q2, q3q3=q3*q3;

      s0 = _4q0*q2q2 + _2q2*ax + _4q0*q1q1 - _2q1*ay;
      s1 = _4q1*q3q3 - _2q3*ax + 4*q0q0*q1 - _2q0*ay - _4q1 + _8q1*q1q1 + _8q1*q2q2 + _4q1*az;
      s2 = 4*q0q0*q2 + _2q0*ax + _4q2*q3q3 - _2q3*ay - _4q2 + _8q2*q1q1 + _8q2*q2q2 + _4q2*az;
      s3 = 4*q1q1*q3 - _2q1*ax + 4*q2q2*q3 - _2q2*ay;

      recipNorm = 1.0 / Math.sqrt(s0*s0 + s1*s1 + s2*s2 + s3*s3);
      if (isFinite(recipNorm)) {
        s0 *= recipNorm; s1 *= recipNorm; s2 *= recipNorm; s3 *= recipNorm;
        qDot0 -= beta * s0; qDot1 -= beta * s1;
        qDot2 -= beta * s2; qDot3 -= beta * s3;
      }
    }

    q0 += qDot0 * dt; q1 += qDot1 * dt;
    q2 += qDot2 * dt; q3 += qDot3 * dt;

    recipNorm = 1.0 / Math.sqrt(q0*q0 + q1*q1 + q2*q2 + q3*q3);
    this.q0 = q0*recipNorm; this.q1 = q1*recipNorm;
    this.q2 = q2*recipNorm; this.q3 = q3*recipNorm;
  }

  toThreeQuat(target) {
    // THREE.js espera (x, y, z, w), Madgwick devuelve (q0=w, q1=x, q2=y, q3=z)
    target.set(this.q1, this.q2, this.q3, this.q0);
    return target;
  }
}

const madgwick    = new MadgwickAHRS(0.033);
let madgwickReady = false;

// ── Orientación de la cámara ──────────────────────────────────
const deviceQuat = new THREE.Quaternion();
const _euler     = new THREE.Euler();
// Corrección: sistema del acelerómetro (Z↑) → sistema de Three.js (Y↑)
const _corrQ     = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _screenQ   = new THREE.Quaternion();
const _zAxis     = new THREE.Vector3(0, 0, 1);
let gyroReady    = false;
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
const STEP_HIGH   = 10.8;  // m/s² — umbral pico del paso
const STEP_LOW    = 9.0;   // m/s² — umbral valle del paso
const STEP_GAP_MS = 210;   // ms mínimos entre pasos (~4.7 pasos/s máx)
let smoothMag     = 9.81;  // magnitud suavizada (arranca en g)
let peakSeen      = false;
let lastStepMs    = 0;

// ── Velocidad y fricción diferenciada ─────────────────────────
const WALK_SPEED    = 1.8;   // m/s objetivo al caminar (velocidad natural)
const FRICTION_WALK = 0.8;   // fricción MIENTRAS camina (muy baja → fluido)
const FRICTION_STOP = 5.0;   // fricción AL PARAR (decae en ~0.5s)
const WALK_EXPIRE_MS = 450;  // ms que se mantiene el estado "caminando" tras un paso
let walkingExpireMs  = 0;

// ── Desplazamiento del portal ──────────────────────────────────
let portalOffset = 0;    // metros que el portal se ha acercado (+ = cerca)
let walkVelocity = 0;    // m/s sobre el eje del portal
const MAX_DIST   = 8.0;

// ── Exploración dentro del portal ─────────────────────────────
const innerPos      = new THREE.Vector3();
const innerVelocity = new THREE.Vector3();
const MAX_INNER     = 3.5;

// ── Vectores de trabajo (pre-alojados, evitan GC en el loop) ──
const _camFwd   = new THREE.Vector3();

// ── Raycaster + touch ─────────────────────────────────────────
const DRAG_THRESHOLD = 12;

// ── Eje y origen del portal ───────────────────────────────────
const portalOrigin  = new THREE.Vector3();
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
        width:  { ideal: 640 },
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
  window.addEventListener('devicemotion',      onMotion,      true);
  setupTouch();

  splashLoading.classList.remove('on');
  splash.style.display = 'none';
  hud.style.display    = 'block';
  btnPlace.style.display = 'block';

  showHud('Cargando portal McCORMICK...');
  await loadPortal();
  showHud('Pulsa el botón para colocar el portal frente a ti');

  btnPlace.addEventListener('click', placePortal, { once: true });
  if (btnReset) btnReset.addEventListener('click', resetPosition);
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
        const nx = (tapStartX / window.innerWidth)  * 2 - 1;
        const ny = -(tapStartY / window.innerHeight) * 2 + 1;
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
        const ctaHit = rc.intersectObject(paprika, true).find(h => h.object.name === 'CTA_Plane');
        if (ctaHit) {
          showHud('¡Abriendo tienda McCormick!');
          window.open('https://www.mccormick.com.mx', '_blank');
        }
      }
    }
    isDragging = false;
  }, { passive: true });
}

// ═══════════════════════════════════════════════════════════════
// DeviceOrientation → Fallback de orientación
// Solo se usa cuando Madgwick no recibe rotationRate (algunos Android/iOS)
// ═══════════════════════════════════════════════════════════════
function onOrientation(e) {
  if (e.alpha === null) return;
  gyroReady = true;

  // Madgwick tiene prioridad; este evento es solo el fallback
  if (madgwickReady) return;

  _euler.set(
    THREE.MathUtils.degToRad(e.beta  ?? 0),
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
// DeviceMotion:
//   PARTE 1 — Madgwick con rotationRate + accelerationIncludingGravity → orientación
//   PARTE 2 — Detección de pasos con accelerationIncludingGravity → locomoción
//
// accelerationIncludingGravity es SIEMPRE disponible (100% iOS y Android).
// event.acceleration (sin gravedad) falla en ~60% de dispositivos → NO se usa.
// ═══════════════════════════════════════════════════════════════
function onMotion(event) {
  const now = performance.now();
  const dt  = lastMotionTs > 0 ? Math.min((now - lastMotionTs) / 1000, 0.05) : 1 / 60;
  lastMotionTs = now;

  const accG = event.accelerationIncludingGravity;
  if (!accG || accG.x === null) return;

  const ax = accG.x ?? 0;
  const ay = accG.y ?? 0;
  const az = accG.z ?? 0;

  // ── PARTE 1: Madgwick — actualizar orientación ─────────────
  const gyro = event.rotationRate;
  if (gyro && gyro.alpha !== null) {
    madgwickReady = true;
    gyroReady     = true;

    // DeviceMotion reporta rotationRate en grados/s → convertir a rad/s
    const gx = THREE.MathUtils.degToRad(gyro.beta  ?? 0);
    const gy = THREE.MathUtils.degToRad(gyro.alpha ?? 0);
    const gz = THREE.MathUtils.degToRad(gyro.gamma ?? 0);

    madgwick.update(gx, gy, gz, ax, ay, az, dt);
    madgwick.toThreeQuat(deviceQuat);

    // Corrección de eje: Z↑ (sensor) → Y↑ (Three.js)
    deviceQuat.multiply(_corrQ);
    // Corrección de rotación de pantalla (portrait/landscape)
    _screenQ.setFromAxisAngle(
      _zAxis,
      -THREE.MathUtils.degToRad(window.screen?.orientation?.angle ?? window.orientation ?? 0)
    );
    deviceQuat.multiply(_screenQ);
    camera.quaternion.copy(deviceQuat);
  }

  // ── PARTE 2: Detección de pasos — solo cuando el portal está puesto ──
  if (!portalPlaced) return;

  // Magnitud del vector de aceleración (incluye gravedad ~9.81 en reposo)
  // Al caminar oscila entre ~7 y ~13 m/s². El algoritmo pico-valle detecta esto.
  const rawMag = Math.sqrt(ax*ax + ay*ay + az*az);

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
  // Vector hacia adelante de la cámara proyectado en el plano XZ
  _camFwd.set(0, 0, -1).applyQuaternion(deviceQuat);
  _camFwd.y = 0;
  if (_camFwd.lengthSq() < 0.0001) return; // sin orientación todavía
  _camFwd.normalize();

  if (insidePortal) {
    // ── Dentro del portal: moverse en la dirección de la vista ──
    walkingExpireMs = now + WALK_EXPIRE_MS;
    // Dar impulso en la dirección actual de la cámara
    innerVelocity.addScaledVector(_camFwd, WALK_SPEED * 0.8);
    // Clampar velocidad máxima
    const spd = innerVelocity.length();
    if (spd > WALK_SPEED * 1.5) innerVelocity.multiplyScalar((WALK_SPEED * 1.5) / spd);

  } else {
    // ── Fuera del portal: avanzar/retroceder por el eje del portal ──
    const dot = _camFwd.dot(portalAxisDir);

    // Zona muerta ±0.15 para evitar activación accidental al girar 90°
    const direction = dot > 0.15 ? 1 : dot < -0.15 ? -1 : 0;
    if (direction === 0) return;

    // Refrescar estado "caminando" para la fricción diferenciada
    walkingExpireMs = now + WALK_EXPIRE_MS;

    // Lerp del 80% hacia la velocidad objetivo: arranque rápido y natural.
    // Si cambias de dirección, la velocidad revierte suavemente.
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
}

// ═══════════════════════════════════════════════════════════════
// Colocar el portal en la escena
// ═══════════════════════════════════════════════════════════════
function placePortal() {
  if (!portalGroup || portalPlaced) return;

  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(deviceQuat);
  fwd.y = 0;
  fwd.normalize();

  // Portal a 3m enfrente, bajado 1.3m para centrar verticalmente en la pantalla
  portalOrigin.set(fwd.x * 3.0, -1.3, fwd.z * 3.0);
  portalAxisDir.copy(fwd);

  portalGroup.position.copy(portalOrigin);
  portalGroup.lookAt(0, -1.3, 0);

  scene.add(portalGroup);
  portalPlaced  = true;
  portalOffset  = 0;
  walkVelocity  = 0;
  walkingExpireMs = 0;

  btnPlace.style.display = 'none';
  showHud('Camina hacia el portal para entrar');
}

// ═══════════════════════════════════════════════════════════════
// Reset de posición (solo dentro del portal)
// ═══════════════════════════════════════════════════════════════
function resetPosition() {
  innerPos.set(0, 0, 0);
  innerVelocity.set(0, 0, 0);
  camera.position.set(0, 0, 0);
  showHud('Posición reiniciada ↺');
  setTimeout(() => {
    if (insidePortal) showHud('Toca el producto para verlo en la tienda');
  }, 1500);
}

// ═══════════════════════════════════════════════════════════════
// Render loop
// ═══════════════════════════════════════════════════════════════
function renderLoop(ts) {
  const dt = lastTs > 0 ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
  lastTs = ts;

  if (!gyroReady) camera.rotation.set(0, 0, 0);

  // Tick del portal: animaciones internas + parallax de la esfera
  if (portalGroup?.userData.tick) portalGroup.userData.tick(ts, portalOffset, deviceQuat);

  if (portalPlaced) {
    const now        = performance.now();
    const isWalking  = now < walkingExpireMs;

    // Fricción diferenciada (frame-rate independent):
    //   Mientras camina: FRICTION_WALK=0.8 → casi no frena entre pasos (fluido)
    //   Al parar:        FRICTION_STOP=5.0 → para en ~0.5s (natural)
    const friction    = isWalking ? FRICTION_WALK : FRICTION_STOP;
    const dampFactor  = Math.max(0, 1 - friction * dt);

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
  // El portal se colocó a 3.0m → cruce cuando el offset supera 3.1m
  const threshold = 3.1;
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

  if (btnReset) {
    btnReset.style.display = 'block';
    setTimeout(() => { if (btnReset) btnReset.style.opacity = '1'; }, 100);
  }
}

function onExitPortal() {
  if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(true);
  cameraBg.style.transition = 'opacity 0.5s ease';
  cameraBg.style.opacity = '1';
  showHud('Camina hacia el portal para entrar');

  if (btnReset) {
    btnReset.style.opacity = '0';
    setTimeout(() => { if (btnReset) btnReset.style.display = 'none'; }, 300);
  }

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
function showHud(msg)    { hud.textContent = msg; }
function showError(msg) {
  splashLoading.classList.add('on');
  showStatus('');
  errorMsg.style.display = 'block';
  errorMsg.textContent = msg;
  btnOpen.textContent = 'Reintentar';
  btnOpen.style.display = 'block';
  btnOpen.addEventListener('click', () => location.reload(), { once: true });
}