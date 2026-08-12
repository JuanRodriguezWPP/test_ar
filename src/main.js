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
// MADGWICK AHRS — Filtro de fusión de sensores inline
// Referencia: Sebastian Madgwick (2010)
// Fusiona giroscopio + acelerómetro → quaternion estable y sin deriva
// ═══════════════════════════════════════════════════════════════
class MadgwickAHRS {
  constructor(sampleFreq = 60, beta = 0.1) {
    this.sampleFreq = sampleFreq;
    this.beta = beta;         // 0 = solo giroscopio, 1 = solo acelerómetro
    this.q0 = 1; this.q1 = 0; this.q2 = 0; this.q3 = 0;
  }

  update(gx, gy, gz, ax, ay, az) {
    let { q0, q1, q2, q3, beta, sampleFreq } = this;
    let recipNorm;
    let s0, s1, s2, s3;
    let qDot0, qDot1, qDot2, qDot3;
    let _2q0, _2q1, _2q2, _2q3;
    let _4q0, _4q1, _4q2;
    let _8q1, _8q2;
    let q0q0, q1q1, q2q2, q3q3;

    // Derivada del quaternion por el giroscopio
    qDot0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
    qDot1 = 0.5 * ( q0 * gx + q2 * gz - q3 * gy);
    qDot2 = 0.5 * ( q0 * gy - q1 * gz + q3 * gx);
    qDot3 = 0.5 * ( q0 * gz + q1 * gy - q2 * gx);

    // Corrección con acelerómetro (solo si el vector no es nulo)
    const accMag = Math.sqrt(ax * ax + ay * ay + az * az);
    if (accMag > 0.001) {
      // Normalizar acelerómetro
      recipNorm = 1.0 / accMag;
      ax *= recipNorm; ay *= recipNorm; az *= recipNorm;

      // Valores auxiliares
      _2q0 = 2.0 * q0; _2q1 = 2.0 * q1; _2q2 = 2.0 * q2; _2q3 = 2.0 * q3;
      _4q0 = 4.0 * q0; _4q1 = 4.0 * q1; _4q2 = 4.0 * q2;
      _8q1 = 8.0 * q1; _8q2 = 8.0 * q2;
      q0q0 = q0 * q0; q1q1 = q1 * q1; q2q2 = q2 * q2; q3q3 = q3 * q3;

      // Función objetivo y Jacobiano (campo de gravedad)
      s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay;
      s1 = _4q1 * q3q3 - _2q3 * ax + 4.0 * q0q0 * q1 - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az;
      s2 = 4.0 * q0q0 * q2 + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az;
      s3 = 4.0 * q1q1 * q3 - _2q1 * ax + 4.0 * q2q2 * q3 - _2q2 * ay;

      recipNorm = 1.0 / Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3);
      s0 *= recipNorm; s1 *= recipNorm; s2 *= recipNorm; s3 *= recipNorm;

      // Aplicar corrección al paso de integración
      qDot0 -= beta * s0;
      qDot1 -= beta * s1;
      qDot2 -= beta * s2;
      qDot3 -= beta * s3;
    }

    // Integrar para obtener el quaternion
    const dt = 1.0 / sampleFreq;
    q0 += qDot0 * dt; q1 += qDot1 * dt;
    q2 += qDot2 * dt; q3 += qDot3 * dt;

    // Normalizar quaternion
    recipNorm = 1.0 / Math.sqrt(q0*q0 + q1*q1 + q2*q2 + q3*q3);
    this.q0 = q0 * recipNorm; this.q1 = q1 * recipNorm;
    this.q2 = q2 * recipNorm; this.q3 = q3 * recipNorm;
  }

  getQuaternion() {
    // Retorna THREE.Quaternion compatible (x, y, z, w)
    return new THREE.Quaternion(this.q1, this.q2, this.q3, this.q0);
  }
}

// ── Instancia del filtro Madgwick ─────────────────────────────
const madgwick = new MadgwickAHRS(60, 0.1);

// ── Orientación de la cámara ──────────────────────────────────
const deviceQuat = new THREE.Quaternion();
const _corrQ = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // corrección eje Z↑ → Y↑
const _screenQ = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
let gyroReady = false;

// Timestamp del último evento de movimiento (para calcular dt en Madgwick)
let lastMotionTs = 0;

// ── Locomoción continua (nueva arquitectura) ──────────────────
// Velocidad lineal acumulada en m/s proyectada sobre el eje del portal
let walkVelocity = 0;
const VEL_DAMPING = 0.88;   // fricción por frame (ajustable: 0.85 = más corte, 0.92 = más deslizamiento)
const ACC_SCALE   = 0.28;   // multiplicador de aceleración→velocidad (ajustable para más/menos sensibilidad)
const ACC_THRESHOLD = 0.30; // zona muerta m/s² — evita deriva en reposo
const MAX_DIST    = 8.0;    // metros máx que puede alejarse el portal

// Bias del acelerómetro en reposo (calibración automática)
let accBiasX = 0, accBiasZ = 0;
let biasSamples = 0;
const BIAS_FRAMES = 90; // calibrar durante los primeros 90 frames (~1.5s a 60fps)
let biasCalibrated = false;

// Aceleración suavizada con EMA para eliminar jitter
let smoothAccFwd = 0;
const EMA_ALPHA = 0.20; // 0.10 = muy suave, 0.25 = más reactivo

// ── Posición del portal ───────────────────────────────────────
let portalOffset = 0;

// ── Raycaster (CTA) ───────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const DRAG_THRESHOLD = 12;

// ═══════════════════════════════════════════════════════════════
// INICIO
// ═══════════════════════════════════════════════════════════════
splash.addEventListener('click', () => launch(), { once: true });

// ═══════════════════════════════════════════════════════════════
// PASO 1 – Permisos + Cámara
// ═══════════════════════════════════════════════════════════════
async function launch() {
  splashLoading.classList.add('on');
  showStatus('Solicitando permisos...');

  // iOS 13+: pedir permisos de sensores en gesto de usuario
  for (const E of [DeviceOrientationEvent, DeviceMotionEvent]) {
    if (typeof E?.requestPermission === 'function') {
      try { await E.requestPermission(); } catch (_) { }
    }
  }

  // Cámara trasera
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

  // Escuchar AMBOS eventos: DeviceOrientation (solo rotación, fallback)
  // y DeviceMotion (giroscopio + acelerómetro → Madgwick + locomoción)
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
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  scene = new THREE.Scene();

  // Cámara fija en el origen — solo rota con el filtro Madgwick
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
// Touch: distinguir tap (→ CTA) de drag (→ rotar modelo GLB)
// ═══════════════════════════════════════════════════════════════
function setupTouch() {
  let tapStartX = 0, tapStartY = 0;
  let isDragging = false;

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
    if (insidePortal && portalGroup?.userData.onTouchEnd) {
      portalGroup.userData.onTouchEnd();
    }

    if (!isDragging && insidePortal && portalGroup?.userData.getPaprika) {
      const paprika = portalGroup.userData.getPaprika();
      if (paprika) {
        scene.updateMatrixWorld(true);
        const nx = (tapStartX / window.innerWidth) * 2 - 1;
        const ny = -(tapStartY / window.innerHeight) * 2 + 1;
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
        const intersects = rc.intersectObject(paprika, true);
        const ctaHit = intersects.find(hit => hit.object.name === 'CTA_Plane');
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
// DeviceOrientation → Fallback de orientación (si DeviceMotion no entrega giroscopio)
// Se usa SOLO para actualizar deviceQuat cuando Madgwick aún no está listo
// ═══════════════════════════════════════════════════════════════
function onOrientation(e) {
  if (e.alpha === null) return;
  // Marcamos que hay orientación disponible
  gyroReady = true;

  // Si Madgwick ya está corriendo con giroscopio real, este evento se ignora
  // (Madgwick actualiza deviceQuat directamente en onMotion)
  if (lastMotionTs > 0) return;

  // Fallback: usar ángulos de Euler del DeviceOrientationEvent
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(e.beta ?? 0),
    THREE.MathUtils.degToRad(e.alpha ?? 0),
    THREE.MathUtils.degToRad(-(e.gamma ?? 0)),
    'YXZ'
  );
  deviceQuat.setFromEuler(euler);
  deviceQuat.multiply(_corrQ);
  _screenQ.setFromAxisAngle(
    _zAxis,
    -THREE.MathUtils.degToRad(window.screen?.orientation?.angle ?? window.orientation ?? 0)
  );
  deviceQuat.multiply(_screenQ);
  camera.quaternion.copy(deviceQuat);
}

// ═══════════════════════════════════════════════════════════════
// DeviceMotion → MADGWICK + Locomoción continua
// ═══════════════════════════════════════════════════════════════
function onMotion(event) {
  const now = performance.now();
  const dt = lastMotionTs > 0 ? Math.min((now - lastMotionTs) / 1000, 0.05) : 1/60;
  lastMotionTs = now;

  // ── 1. Actualizar filtro Madgwick con giroscopio + acelerómetro ──
  const gyro = event.rotationRate;
  const acc  = event.accelerationIncludingGravity; // siempre disponible (con gravedad)

  if (gyro && gyro.alpha !== null && acc && acc.x !== null) {
    // Convertir grados/s → radianes/s
    const gx = THREE.MathUtils.degToRad(gyro.beta  ?? 0);
    const gy = THREE.MathUtils.degToRad(gyro.alpha ?? 0);
    const gz = THREE.MathUtils.degToRad(gyro.gamma ?? 0);

    // Acelerómetro (incluye gravedad, en m/s²)
    const ax = acc.x ?? 0;
    const ay = acc.y ?? 0;
    const az = acc.z ?? 0;

    // Actualizar frecuencia de muestreo dinámicamente para mayor precisión
    madgwick.sampleFreq = dt > 0 ? Math.min(1/dt, 120) : 60;
    madgwick.update(gx, gy, gz, ax, ay, az);

    // Obtener quaternion del filtro y aplicar corrección de pantalla
    const mQ = madgwick.getQuaternion();
    deviceQuat.copy(mQ);
    deviceQuat.multiply(_corrQ);
    _screenQ.setFromAxisAngle(
      _zAxis,
      -THREE.MathUtils.degToRad(window.screen?.orientation?.angle ?? window.orientation ?? 0)
    );
    deviceQuat.multiply(_screenQ);
    camera.quaternion.copy(deviceQuat);
    gyroReady = true;
  }

  // ── 2. Locomoción continua — solo cuando el portal está colocado ──
  if (!portalPlaced) return;

  // Usar aceleración lineal (sin gravedad) si está disponible
  const linAcc = event.acceleration;
  if (!linAcc || linAcc.x === null) return;

  const rawX = linAcc.x ?? 0;
  const rawY = linAcc.y ?? 0;
  const rawZ = linAcc.z ?? 0;

  // ── 3. Calibración automática del bias en reposo (primeros ~1.5s) ──
  if (!biasCalibrated) {
    accBiasX += rawX;
    accBiasZ += rawZ;
    biasSamples++;
    if (biasSamples >= BIAS_FRAMES) {
      accBiasX /= biasSamples;
      accBiasZ /= biasSamples;
      biasCalibrated = true;
    }
    return; // no mover el portal durante la calibración
  }

  // Restar bias de reposo
  const corrX = rawX - accBiasX;
  const corrZ = rawZ - accBiasZ;

  // ── 4. Transformar aceleración del dispositivo → mundo 3D ──────────
  // El vector de aceleración está en el sistema de coordenadas del dispositivo.
  // Lo rotamos al sistema de coordenadas del mundo usando el quaternion actual.
  const accLocal = new THREE.Vector3(corrX, rawY, corrZ);
  const worldAcc = accLocal.clone().applyQuaternion(deviceQuat);

  // Solo nos interesa el plano horizontal (XZ del mundo)
  worldAcc.y = 0;

  // ── 5. Proyectar sobre el eje del portal para obtener dirección ────
  // portalAxisDir apunta desde la cámara hacia el portal
  // dot > 0 → aceleración hacia el portal (avanzar)
  // dot < 0 → aceleración alejándose del portal (retroceder)
  const accFwd = worldAcc.dot(portalAxisDir);

  // ── 6. Zona muerta — evitar deriva en reposo ──────────────────────
  const accFiltered = Math.abs(accFwd) > ACC_THRESHOLD ? accFwd : 0;

  // ── 7. Suavizar con EMA para eliminar jitter de alta frecuencia ───
  smoothAccFwd = smoothAccFwd * (1 - EMA_ALPHA) + accFiltered * EMA_ALPHA;

  // ── 8. Integrar aceleración → velocidad ───────────────────────────
  walkVelocity += smoothAccFwd * ACC_SCALE * dt;

  // Clamp de velocidad máxima para evitar saltos bruscos
  walkVelocity = THREE.MathUtils.clamp(walkVelocity, -3.0, 3.0);
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
const portalOrigin  = new THREE.Vector3();
const portalAxisDir = new THREE.Vector3();

function placePortal() {
  if (!portalGroup || portalPlaced) return;

  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(deviceQuat);
  fwd.y = 0;
  fwd.normalize();

  portalOrigin.set(fwd.x * 3.0, -1.3, fwd.z * 3.0);
  portalAxisDir.copy(fwd);

  portalGroup.position.copy(portalOrigin);
  portalGroup.lookAt(0, -1.3, 0);

  scene.add(portalGroup);
  portalPlaced  = true;
  portalOffset  = 0;
  walkVelocity  = 0;
  smoothAccFwd  = 0;

  // Reiniciar calibración del bias para el contexto de movimiento real
  biasCalibrated = false;
  biasSamples    = 0;
  accBiasX       = 0;
  accBiasZ       = 0;

  btnPlace.style.display = 'none';
  showHud('Camina hacia el portal para entrar');
}

// ═══════════════════════════════════════════════════════════════
// Render loop
// ═══════════════════════════════════════════════════════════════
function renderLoop(ts) {
  const dt = lastTs > 0 ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
  lastTs = ts;

  // Si no hay giroscopio, la cámara se queda estática
  if (!gyroReady) {
    camera.rotation.set(0, 0, 0);
  }

  // Tick del portal (animaciones internas: páprika, esfera, etc.)
  if (portalGroup?.userData.tick) portalGroup.userData.tick(ts, portalOffset);

  // ── Física de locomoción continua ─────────────────────────────
  if (portalPlaced) {
    // 1. Fricción frame-rate independent
    //    VEL_DAMPING = 0.88 → a 60fps: 0.88^60 ≈ 0.00065 (se detiene en ~1s)
    //    Elevamos al exponente dt*60 para que sea independiente del frame rate
    const dampFactor = Math.pow(VEL_DAMPING, dt * 60);
    walkVelocity *= dampFactor;

    // 2. Integrar velocidad → desplazamiento
    if (Math.abs(walkVelocity) > 0.005) {
      portalOffset = THREE.MathUtils.clamp(
        portalOffset + walkVelocity * dt,
        -MAX_DIST,
        MAX_DIST
      );
      applyPortalOffset();
    }

    // 3. Camera Y: suave retorno al origen (sin head bobbing)
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0, 6.0 * dt);

    checkCrossing();
  }

  renderer.clear(true, true, true);
  renderer.render(scene, camera);
}

// ═══════════════════════════════════════════════════════════════
// Helper: mover el portal según el offset calculado
// ═══════════════════════════════════════════════════════════════
function applyPortalOffset() {
  if (!portalGroup || !portalPlaced) return;
  // offset positivo → portal se acerca (usuario avanza)
  portalGroup.position
    .copy(portalOrigin)
    .addScaledVector(portalAxisDir, -portalOffset);
}

// ═══════════════════════════════════════════════════════════════
// Detección de cruce
// ═══════════════════════════════════════════════════════════════
function checkCrossing() {
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
    } else if (portalOffset < -0.5) {
      showHud('Camina hacia el portal para entrar');
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
