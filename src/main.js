import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ─── UI Elements ──────────────────────────────────────────────
const splash       = document.getElementById('splash');
const statusEl     = document.getElementById('splash-status');
const spinner      = document.getElementById('spinner');
const btnStart     = document.getElementById('btn-start');
const errorBox     = document.getElementById('error-box');
const hud          = document.getElementById('hud');

// ─── Three.js globals ─────────────────────────────────────────
let renderer, scene, camera;
let reticle, portalGroup;
let hitTestSource = null;
let hitTestRequested = false;
let portalPlaced = false;
let isInsidePortal = false;

// ─── Step 1: Check support on load ────────────────────────────
async function init() {
  setStatus('Verificando compatibilidad con AR...');
  spinner.classList.add('active');

  if (!navigator.xr) {
    showError('Tu navegador no soporta WebXR. Usa Google Chrome en Android.');
    return;
  }

  try {
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!supported) {
      showError(
        'Este dispositivo no soporta AR. Asegúrate de tener ARCore instalado desde la Play Store y usa Google Chrome.'
      );
      return;
    }
  } catch (e) {
    showError(`Error verificando soporte AR: ${e.message}`);
    return;
  }

  // Dispositivo compatible: mostrar botón
  spinner.classList.remove('active');
  setStatus('¡Dispositivo compatible con AR!');
  btnStart.style.display = 'block';
  btnStart.addEventListener('click', startAR);
}

// ─── Step 2: User taps "Abrir Cámara AR" ──────────────────────
async function startAR() {
  btnStart.style.display = 'none';
  setStatus('Iniciando cámara...');
  spinner.classList.add('active');

  // Crear renderer con alpha=true (transparencia para ver la cámara)
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  // Crear escena
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 200);

  // Iluminación
  scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1));
  const dir = new THREE.DirectionalLight(0xffffff, 1);
  dir.position.set(1, 3, 2);
  scene.add(dir);

  // Reticle para indicar donde se colocará el portal
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.12, 0.16, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.8 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // Intentar abrir la sesión AR directamente, capturando el error real
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: ['hit-test', 'dom-overlay'],
      domOverlay: { root: document.body }  // Usar document.body, no un div custom
    });

    // Sesión iniciada: ocultar splash
    splash.style.display = 'none';
    hud.style.display = 'block';

    await renderer.xr.setSession(session);
    session.addEventListener('end', onSessionEnd);

    // Tap para colocar el portal
    const controller = renderer.xr.getController(0);
    controller.addEventListener('select', onSelect);
    scene.add(controller);

    // Cargar modelos en paralelo
    setHud('Cargando modelos...');
    await loadAssets();

    setHud('Apunta al piso para colocar el portal');
    renderer.setAnimationLoop(renderLoop);

  } catch (err) {
    // Mostrar el error REAL del navegador al usuario
    renderer.dispose();
    document.body.removeChild(renderer.domElement);
    spinner.classList.remove('active');
    showError(
      `No se pudo abrir la cámara AR.\n\nError del sistema: ${err.name} - ${err.message}\n\nSoluciones:\n` +
      `• Verifica que tienes "Servicios de Google Play para RA (ARCore)" instalados desde la Play Store.\n` +
      `• Asegúrate de estar usando Google Chrome (no otro navegador).\n` +
      `• El sitio debe abrirse en HTTPS (✓ Netlify lo cumple).`
    );
    btnStart.textContent = 'Reintentar';
    btnStart.style.display = 'block';
    btnStart.addEventListener('click', () => location.reload());
  }
}

// ─── Cargar el GLB de la escena interior ──────────────────────
async function loadAssets() {
  const loader = new GLTFLoader();

  // Construir la habitación con stencil + el modelo Dia de Muertos
  const { buildPortalGroup } = await import('./portal.js');
  portalGroup = await buildPortalGroup(loader);
}

let hitTestSupported = true; // asume verdadero hasta que falle

// ─── Tap en pantalla: colocar el portal ───────────────────────
function onSelect() {
  if (portalPlaced) return;

  if (hitTestSupported && !reticle.visible) {
    // Si soporta hit-test pero aún no detecta el piso, no hacer nada
    return;
  }

  if (hitTestSupported && reticle.visible) {
    // Colocar donde diga el reticle (piso real)
    portalGroup.position.setFromMatrixPosition(reticle.matrix);
  } else {
    // FALLBACK: Si no soporta hit-test, colocarlo 2 metros adelante de la cámara
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);
    camDir.y = 0; // mantenerlo a la altura de la cámara, pero plano
    camDir.normalize();
    
    portalGroup.position.copy(camPos).add(camDir.multiplyScalar(2.0));
    // Bajarlo un poco simulando el suelo
    portalGroup.position.y -= 1.0; 
  }

  // Rotar el portal para que mire a la cámara
  const camP = new THREE.Vector3();
  camera.getWorldPosition(camP);
  portalGroup.lookAt(camP.x, portalGroup.position.y, camP.z);

  scene.add(portalGroup);
  portalPlaced = true;
  reticle.visible = false;
  setHud('Camina hacia el portal para entrar');
}

// ─── Render loop de WebXR ─────────────────────────────────────
function renderLoop(timestamp, frame) {
  if (!frame) return;

  const refSpace = renderer.xr.getReferenceSpace();
  const session  = renderer.xr.getSession();

  // Hit-test para el reticle
  if (!portalPlaced && hitTestSupported) {
    if (!hitTestRequested) {
      session.requestReferenceSpace('viewer').then(vs => {
        session.requestHitTestSource({ space: vs }).then(src => {
          hitTestSource = src;
        }).catch(err => {
          // El teléfono no soporta Hit-Test
          hitTestSupported = false;
          setHud('Toca la pantalla para colocar el portal (Modo básico)');
        });
      });
      session.addEventListener('end', () => {
        hitTestRequested = false;
        hitTestSource = null;
      });
      hitTestRequested = true;
    }

    if (hitTestSource) {
      const hits = frame.getHitTestResults(hitTestSource);
      if (hits.length > 0) {
        reticle.visible = true;
        reticle.matrix.fromArray(hits[0].getPose(refSpace).transform.matrix);
      } else {
        reticle.visible = false;
      }
    }
  }

  // Detectar si usuario cruzó el portal
  if (portalPlaced && portalGroup) {
    detectCrossing();
  }

  renderer.render(scene, camera);
}

// ─── Detección de cruce del portal ────────────────────────────
const _camPos    = new THREE.Vector3();
const _portalPos = new THREE.Vector3();
const _forward   = new THREE.Vector3();
const _toPortal  = new THREE.Vector3();

function detectCrossing() {
  camera.getWorldPosition(_camPos);
  portalGroup.getWorldPosition(_portalPos);
  portalGroup.getWorldDirection(_forward);
  _toPortal.subVectors(_camPos, _portalPos);

  const dot  = _toPortal.dot(_forward);
  const dist = _camPos.distanceTo(_portalPos);

  const nowInside = dot < 0 && dist < 3.0;

  if (nowInside && !isInsidePortal) {
    isInsidePortal = true;
    onEnter();
  } else if (!nowInside && isInsidePortal) {
    isInsidePortal = false;
    onExit();
  }
}

function onEnter() {
  // Quitar el stencil: el usuario ve el interior a pantalla completa
  if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(false);
  setHud('Estás dentro del portal · Retrocede para salir');
}

function onExit() {
  // Restaurar stencil
  if (portalGroup.userData.setStencil) portalGroup.userData.setStencil(true);
  setHud('Camina hacia el portal para entrar');
}

// ─── Fin de sesión AR ─────────────────────────────────────────
function onSessionEnd() {
  splash.style.display = 'flex';
  hud.style.display = 'none';
  setStatus('Sesión AR terminada. Pulsa para volver a intentarlo.');
  btnStart.textContent = 'Reabrir Cámara AR';
  btnStart.style.display = 'block';
  hitTestRequested = false;
  hitTestSource = null;
  portalPlaced = false;
  isInsidePortal = false;
}

// ─── Helpers UI ───────────────────────────────────────────────
function setStatus(msg) { statusEl.textContent = msg; }

function setHud(msg) { hud.textContent = msg; }

function showError(msg) {
  spinner.classList.remove('active');
  setStatus('');
  errorBox.style.display = 'block';
  errorBox.textContent = msg;
}

// Resize
window.addEventListener('resize', () => {
  if (!camera || !renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Arrancar
init();
