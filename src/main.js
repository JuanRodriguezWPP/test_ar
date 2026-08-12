import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ═══════════════════════════════════════════════════════════════
// UI refs
// ═══════════════════════════════════════════════════════════════
const splash       = document.getElementById('splash');
const splashLoading= document.getElementById('splash-loading');
const statusEl     = document.getElementById('status-text');
const btnOpen      = document.getElementById('btn-open');
const errorMsg     = document.getElementById('error-msg');
const hud          = document.getElementById('hud');
const btnPlace     = document.getElementById('btn-place');
const cameraBg     = document.getElementById('camera-bg');
const btnReset     = document.getElementById('btn-reset');

// ═══════════════════════════════════════════════════════════════
// Three.js state
// ═══════════════════════════════════════════════════════════════
let renderer, scene, camera;
let portalGroup  = null;
let portalPlaced = false;
let insidePortal = false;
let lastTs       = 0;

// ═══════════════════════════════════════════════════════════════
// MADGWICK AHRS — Fusión giroscopio + acelerómetro
// Sebastian Madgwick (2010). Beta=0.033 publicado para AR.
// Sin dependencias externas — implementado inline.
// ═══════════════════════════════════════════════════════════════
class MadgwickAHRS {
  constructor(beta = 0.033) {
    this.beta = beta;
    this.q0 = 1; this.q1 = 0; this.q2 = 0; this.q3 = 0;
  }

  /**
   * gx/gy/gz  rad/s  (rotationRate convertido)
   * ax/ay/az  m/s²   (accelerationIncludingGravity)
   * dt        s      (tiempo desde último frame)
   */
  update(gx, gy, gz, ax, ay, az, dt) {
    let { q0, q1, q2, q3, beta } = this;
    let recipNorm, s0, s1, s2, s3;
    let qDot0, qDot1, qDot2, qDot3;

    // Derivada del quaternion por giroscopio
    qDot0 = 0.5 * (-q1*gx - q2*gy - q3*gz);
    qDot1 = 0.5 * ( q0*gx + q2*gz - q3*gy);
    qDot2 = 0.5 * ( q0*gy - q1*gz + q3*gx);
    qDot3 = 0.5 * ( q0*gz + q1*gy - q2*gx);

    // Corrección de inclinación con acelerómetro (descarta si es cero)
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

  /** Retorna THREE.Quaternion compatible (x,y,z,w) */
  toThreeQuat(target) {
    target.set(this.q1, this.q2, this.q3, this.q0);
    return target;
  }
}

const madgwick     = new MadgwickAHRS(0.033);
let madgwickReady  = false;   // true cuando llega rotationRate del dispositivo

// ── Orientación de la cámara ──────────────────────────────────
const deviceQuat = new THREE.Quaternion();
const _euler     = new THREE.Euler();
// Corrección: el sistema de coordenadas del acelerómetro (Z apunta arriba)
// debe convertirse al sistema de Three.js (Y apunta arriba).
const _corrQ     = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _screenQ   = new THREE.Quaternion();
const _zAxis     = new THREE.Vector3(0, 0, 1);
let gyroReady    = false;
let lastMotionTs = 0;

// ═══════════════════════════════════════════════════════════════
// LOCOMOCIÓN — sistema continuo basado en acelerómetro real
// ═══════════════════════════════════════════════════════════════

// ── ANTES de cruzar el portal: el portal se mueve hacia/desde cámara ──
let portalOffset = 0;
let walkVelocity = 0;         // m/s a lo largo del eje del portal

// ── DENTRO del portal: la cámara explora el mundo 360° ──
const innerPos      = new THREE.Vector3(); // posición exploratoria (XZ)
const innerVelocity = new THREE.Vector3(); // velocidad exploratoria en mundo

// Constantes de física
const VEL_DAMPING   = 0.82;   // 0=frena al instante, 1=sin fricción
                               // A 60fps: 0.82^60 ≈ 0  (para en ~1.5s)
const ACC_SCALE     = 0.40;   // sensibilidad acelerómetro → velocidad
const ACC_THRESHOLD = 0.25;   // zona muerta m/s² (evita deriva en reposo)
const MAX_DIST      = 8.0;    // metros máx lejos del portal
const MAX_INNER     = 3.5;    // metros máx de exploración interna

// EMA sobre la proyección de aceleración (suaviza jitter del sensor)
let smoothAccFwd = 0;
const EMA_ALPHA  = 0.22;      // 0.10=muy suave, 0.30=más reactivo

// Vectores de trabajo (pre-alojados para evitar GC en el loop)
const _accVec  = new THREE.Vector3();
const _camFwd  = new THREE.Vector3();

// ── Touch ─────────────────────────────────────────────────────
const DRAG_THRESHOLD = 12;

// Eje del portal
const portalOrigin  = new THREE.Vector3();
const portalAxisDir = new THREE.Vector3();

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

  // iOS 13+: pedir permisos de sensores en gesto del usuario
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

  // Escuchar ambos eventos: DeviceOrientation (fallback) y DeviceMotion (Madgwick + locomoción)
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

  // Cámara fija en el origen — rota con Madgwick, traslada dentro del portal
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
// Touch: tap → CTA 3D   |   drag → rotar modelo GLB
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
        const nx = (tapStartX / window.innerWidth)  * 2 - 1;
        const ny = -(tapStartY / window.innerHeight) * 2 + 1;
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
        const intersects = rc.intersectObject(paprika, true);
        const ctaHit = intersects.find(h => h.object.name === 'CTA_Plane');
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
// DeviceOrientation → Fallback cuando NO hay rotationRate
// (se ignora en cuanto Madgwick empieza a recibir datos)
// ═══════════════════════════════════════════════════════════════
function onOrientation(e) {
  if (e.alpha === null) return;
  gyroReady = true;

  // Si Madgwick ya está activo, este evento es redundante
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
// DeviceMotion → Madgwick (orientación) + Aceleración (locomoción)
// ═══════════════════════════════════════════════════════════════
function onMotion(event) {
  const now = performance.now();
  const dt  = lastMotionTs > 0 ? Math.min((now - lastMotionTs) / 1000, 0.05) : 1 / 60;
  lastMotionTs = now;

  // ── 1. Orientación con Madgwick AHRS ──────────────────────────
  const gyro = event.rotationRate;
  const accG = event.accelerationIncludingGravity; // incluye gravedad (siempre disponible)

  if (gyro && gyro.alpha !== null && accG && accG.x !== null) {
    madgwickReady = true;
    gyroReady     = true;

    // Convertir grados/s → rad/s
    const gx = THREE.MathUtils.degToRad(gyro.beta  ?? 0);
    const gy = THREE.MathUtils.degToRad(gyro.alpha ?? 0);
    const gz = THREE.MathUtils.degToRad(gyro.gamma ?? 0);

    madgwick.update(gx, gy, gz, accG.x ?? 0, accG.y ?? 0, accG.z ?? 0, dt);
    madgwick.toThreeQuat(deviceQuat);

    // Corrección de ejes (Z↑ del dispositivo → Y↑ de Three.js)
    deviceQuat.multiply(_corrQ);
    // Corrección de orientación de pantalla (portrait vs landscape)
    _screenQ.setFromAxisAngle(
      _zAxis,
      -THREE.MathUtils.degToRad(window.screen?.orientation?.angle ?? window.orientation ?? 0)
    );
    deviceQuat.multiply(_screenQ);
    camera.quaternion.copy(deviceQuat);
  }

  // ── 2. Locomoción — solo cuando el portal está colocado ───────
  if (!portalPlaced) return;

  // Usamos event.acceleration (SIN gravedad) para dirección real de movimiento.
  // Si el dispositivo no lo provee (algunos Android), fallback a accG - 9.81 eje Y.
  const linAcc = event.acceleration;
  if (!linAcc || linAcc.x === null) return;

  const ax = linAcc.x ?? 0;
  const ay = linAcc.y ?? 0;
  const az = linAcc.z ?? 0;

  // Rotar el vector de aceleración local → espacio mundial
  _accVec.set(ax, ay, az).applyQuaternion(deviceQuat);
  _accVec.y = 0; // Solo plano horizontal

  if (insidePortal) {
    // ── Dentro del portal: exploración libre siguiendo la vista ─
    // Proyectar aceleración sobre el vector "hacia adelante" de la cámara en mundo XZ
    _camFwd.set(0, 0, -1).applyQuaternion(deviceQuat);
    _camFwd.y = 0;
    if (_camFwd.lengthSq() > 0.0001) _camFwd.normalize();

    const fwdAcc = _accVec.dot(_camFwd);
    const filtered = Math.abs(fwdAcc) > ACC_THRESHOLD ? fwdAcc : 0;

    if (filtered !== 0) {
      // Sumar impulso en la dirección de la vista
      innerVelocity.addScaledVector(_camFwd, filtered * ACC_SCALE * dt);
      // Clampar velocidad máxima
      const spd = innerVelocity.length();
      if (spd > 2.5) innerVelocity.multiplyScalar(2.5 / spd);
    }

  } else {
    // ── Fuera del portal: avanzar/retroceder en el eje del portal ─
    const accFwd = _accVec.dot(portalAxisDir);
    const filtered = Math.abs(accFwd) > ACC_THRESHOLD ? accFwd : 0;

    // EMA suavizado: reduce jitter de alta frecuencia del acelerómetro
    smoothAccFwd = smoothAccFwd * (1 - EMA_ALPHA) + filtered * EMA_ALPHA;

    // Integrar aceleración → velocidad
    walkVelocity += smoothAccFwd * ACC_SCALE * dt;
    walkVelocity = THREE.MathUtils.clamp(walkVelocity, -3.0, 3.0);
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

  // Colocar a 3.0m enfrente de la vista actual, bajado 1.3m para centrar verticalmente
  portalOrigin.set(fwd.x * 3.0, -1.3, fwd.z * 3.0);
  portalAxisDir.copy(fwd);

  portalGroup.position.copy(portalOrigin);
  portalGroup.lookAt(0, -1.3, 0);

  scene.add(portalGroup);
  portalPlaced   = true;
  portalOffset   = 0;
  walkVelocity   = 0;
  smoothAccFwd   = 0;

  btnPlace.style.display = 'none';
  showHud('Camina hacia el portal para entrar');
}

// ═══════════════════════════════════════════════════════════════
// Reset de posición dentro del portal
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

  // Tick del portal (animaciones internas: páprika, esfera, parallax)
  if (portalGroup?.userData.tick) portalGroup.userData.tick(ts, portalOffset, deviceQuat);

  if (portalPlaced) {
    // Fricción frame-rate independent:
    // Math.pow(VEL_DAMPING, dt*60) es equivalente a damping=VEL_DAMPING a exactamente 60fps,
    // pero se ajusta automáticamente a cualquier framerate real.
    const dampFactor = Math.pow(VEL_DAMPING, dt * 60);

    if (insidePortal) {
      // ── Exploración dentro del portal ────────────────────────
      innerVelocity.multiplyScalar(dampFactor);

      const speed = innerVelocity.length();
      if (speed > 0.005) {
        innerPos.x = THREE.MathUtils.clamp(innerPos.x + innerVelocity.x * dt, -MAX_INNER, MAX_INNER);
        innerPos.z = THREE.MathUtils.clamp(innerPos.z + innerVelocity.z * dt, -MAX_INNER, MAX_INNER);
        camera.position.x = innerPos.x;
        camera.position.z = innerPos.z;

        // Head bobbing sutil proporcional a la velocidad
        camera.position.y = THREE.MathUtils.lerp(
          camera.position.y,
          Math.sin(ts * 0.007) * Math.min(speed * 0.08, 0.06),
          8.0 * dt
        );
      } else {
        camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0, 5.0 * dt);
      }

    } else {
      // ── Avanzar / retroceder hacia el portal ─────────────────
      walkVelocity *= dampFactor;

      if (Math.abs(walkVelocity) > 0.003) {
        portalOffset = THREE.MathUtils.clamp(
          portalOffset + walkVelocity * dt,
          -MAX_DIST,
          MAX_DIST
        );
        applyPortalOffset();
      }

      // Head bobbing suave proporcional a la velocidad de caminata
      const bobbingTarget = Math.abs(walkVelocity) > 0.1
        ? Math.sin(ts * 0.007) * Math.min(Math.abs(walkVelocity) * 0.045, 0.07)
        : 0;
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, bobbingTarget, 8.0 * dt);
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
  // offset positivo → portal se mueve en -portalAxisDir → se acerca a la cámara
  portalGroup.position
    .copy(portalOrigin)
    .addScaledVector(portalAxisDir, -portalOffset);
}

// ═══════════════════════════════════════════════════════════════
// Detección de cruce
// ═══════════════════════════════════════════════════════════════
function checkCrossing() {
  // Umbral = distancia inicial (3.0m) + margen (0.1m)
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

  // Mostrar botón de reset solo cuando estás adentro
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

  // Ocultar botón de reset
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