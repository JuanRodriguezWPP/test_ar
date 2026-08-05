import * as THREE from 'three';
import { loadPortalAssets } from './portal.js';
import { checkPortalCrossing } from './portalCrossing.js';

let camera, scene, renderer;
let reticle;
let hitTestSource = null;
let hitTestSourceRequested = false;
let portalInstantiated = false;
let portalGroup = null;
let onInstructionsUpdate = null;
let xrSession = null;

export async function initARScene(onLoadComplete, onProgress, instructionsCallback) {
  onInstructionsUpdate = instructionsCallback;

  const container = document.createElement('div');
  document.body.appendChild(container);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);

  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  light.position.set(0.5, 1, 0.25);
  scene.add(light);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  container.appendChild(renderer.domElement);

  // Crear botón AR manualmente para tener control total del error
  const startARBtn = document.createElement('button');
  startARBtn.textContent = 'INICIAR CÁMARA AR';
  Object.assign(startARBtn.style, {
    position: 'fixed',
    bottom: '40px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '16px 32px',
    background: '#00704A',
    color: 'white',
    border: 'none',
    borderRadius: '30px',
    fontSize: '18px',
    fontWeight: 'bold',
    zIndex: '999',
    cursor: 'pointer',
  });
  document.body.appendChild(startARBtn);

  startARBtn.addEventListener('click', async () => {
    startARBtn.textContent = 'Iniciando...';
    startARBtn.disabled = true;

    try {
      // Intentar abrir la sesión AR directamente con manejo de errores
      const sessionInit = {
        optionalFeatures: ['hit-test', 'dom-overlay'],
        domOverlay: { root: document.getElementById('ui-container') }
      };

      xrSession = await navigator.xr.requestSession('immersive-ar', sessionInit);
      
      // Sesión exitosa
      startARBtn.style.display = 'none';
      await onSessionStart(xrSession, onLoadComplete, onProgress);

    } catch (err) {
      // Capturar y mostrar el error REAL del navegador
      const errorMsg = `${err.name}: ${err.message}`;
      console.error('WebXR requestSession falló:', err);
      
      startARBtn.style.display = 'none';
      
      // Mostrar el error real al usuario y activar el fallback
      alert(`Cámara AR bloqueada por el navegador.\nError real: ${errorMsg}\n\nActivando visor 3D con giroscopio...`);
      
      // Limpiar
      renderer.dispose();
      if (container.parentNode) document.body.removeChild(container);

      // Activar fallback con giroscopio
      const { initFallbackScene } = await import('./fallbackOrbit.js');
      initFallbackScene(
        () => { document.getElementById('overlay').style.display = 'none'; },
        (p) => {
          const lt = document.getElementById('loader-text');
          if (lt) lt.innerText = `Cargando... ${Math.round(p)}%`;
        },
        (text) => {
          const ins = document.getElementById('instructions');
          if (ins) { ins.innerText = text; ins.style.display = 'inline-block'; }
        }
      );
    }
  });

  // Ocultar el overlay de inicio (ya lo maneja main.js con el botón START)
  // Cargar modelos en segundo plano
  const manager = new THREE.LoadingManager();
  manager.onProgress = (url, loaded, total) => onProgress((loaded / total) * 100);

  try {
    const loadedPortal = await loadPortalAssets(manager);
    onLoadComplete();

    reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x00ff88 })
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);

    portalGroup = loadedPortal;

    window.addEventListener('resize', onWindowResize);
    renderer.setAnimationLoop(render);

  } catch (e) {
    console.error('Error cargando portal assets:', e);
  }
}

async function onSessionStart(session, onLoadComplete, onProgress) {
  renderer.xr.setSession(session);

  session.addEventListener('end', () => {
    xrSession = null;
  });

  // Controller para tap
  const controller = renderer.xr.getController(0);
  controller.addEventListener('select', () => {
    if (reticle && reticle.visible && !portalInstantiated && portalGroup) {
      portalGroup.position.setFromMatrixPosition(reticle.matrix);
      const yRotation = Math.atan2(
        camera.position.x - portalGroup.position.x,
        camera.position.z - portalGroup.position.z
      );
      portalGroup.rotation.y = yRotation;
      scene.add(portalGroup);
      portalInstantiated = true;
      reticle.visible = false;
      onInstructionsUpdate('Camina hacia el portal para entrar');
    }
  });
  scene.add(controller);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function render(timestamp, frame) {
  if (frame && !portalInstantiated) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const session = renderer.xr.getSession();

    if (!hitTestSourceRequested) {
      session.requestReferenceSpace('viewer').then((vs) => {
        session.requestHitTestSource({ space: vs }).then((source) => {
          hitTestSource = source;
        }).catch(() => {
          // hit-test no soportado, igual continúa
          onInstructionsUpdate('Toca la pantalla para colocar el portal');
        });
      });
      session.addEventListener('end', () => {
        hitTestSourceRequested = false;
        hitTestSource = null;
      });
      hitTestSourceRequested = true;
    }

    if (hitTestSource && reticle) {
      const results = frame.getHitTestResults(hitTestSource);
      if (results.length > 0) {
        reticle.visible = true;
        reticle.matrix.fromArray(results[0].getPose(referenceSpace).transform.matrix);
        onInstructionsUpdate('Toca para colocar el portal');
      } else {
        reticle.visible = false;
        onInstructionsUpdate('Apunta al piso...');
      }
    }
  }

  if (portalInstantiated && portalGroup) {
    checkPortalCrossing(camera, portalGroup, onInstructionsUpdate);
  }

  renderer.render(scene, camera);
}
