import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { loadPortalAssets } from './portal.js';
import { checkPortalCrossing } from './portalCrossing.js';

let camera, scene, renderer;
let reticle;
let hitTestSource = null;
let hitTestSourceRequested = false;
let portalInstantiated = false;
let portalGroup = null;
let onInstructionsUpdate = null;

export async function initARScene(onLoadComplete, onProgress, instructionsCallback) {
  onInstructionsUpdate = instructionsCallback;
  
  const container = document.createElement('div');
  document.body.appendChild(container);

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

  // Iluminación
  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  light.position.set(0.5, 1, 0.25);
  scene.add(light);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  container.appendChild(renderer.domElement);

  // UI overlay param
  const uiContainer = document.getElementById('ui-container');

  const arButton = ARButton.createButton(renderer, {
    optionalFeatures: ['dom-overlay', 'hit-test'],
    domOverlay: { root: uiContainer }
  });

  arButton.addEventListener('click', () => {
    // Timeout para verificar si la sesión realmente arranca o se queda bloqueada
    setTimeout(async () => {
      if (!renderer.xr.isPresenting) {
        alert("Tu dispositivo o navegador bloqueó el acceso a la cámara AR. Activando el visor 3D Inmersivo de respaldo...");
        
        // Limpiar basura del AR fallido
        arButton.style.display = 'none';
        uiContainer.style.display = 'none';
        renderer.dispose();
        if(container.parentNode) {
            document.body.removeChild(container);
        }

        // Importar y ejecutar el visor 3D clásico (OrbitControls)
        document.getElementById('overlay').style.display = 'flex';
        document.getElementById('overlay-text').innerText = "Cargando visor 3D interactivo...";
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('start-btn').style.display = 'none';

        try {
            const { initFallbackScene } = await import('./fallbackOrbit.js');
            initFallbackScene(
                () => {
                    document.getElementById('overlay').style.display = 'none';
                },
                (progress) => {
                    document.getElementById('loader-text').innerText = `Cargando... ${Math.round(progress)}%`;
                }
            );
        } catch (e) {
            console.error("Error cargando fallback:", e);
        }
      }
    }, 3500);
  });

  renderer.xr.addEventListener('sessionstart', () => {
    // Si inicia bien, quitamos el loader por si acaso
    document.getElementById('loader').style.display = 'none';
  });

  document.body.appendChild(arButton);

  // Loading models
  const manager = new THREE.LoadingManager();
  manager.onProgress = function (url, itemsLoaded, itemsTotal) {
    onProgress((itemsLoaded / itemsTotal) * 100);
  };
  
  try {
    const loadedPortal = await loadPortalAssets(manager);
    onLoadComplete();
    
    // Reticle (anillo para colocar)
    reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.15, 0.2, 32).rotateX(- Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x00704A }) // Verde Starbucks
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);

    // Controller
    const controller = renderer.xr.getController(0);
    controller.addEventListener('select', () => {
      if (reticle.visible && !portalInstantiated) {
        portalGroup = loadedPortal;
        // Posicionar en el reticle
        portalGroup.position.setFromMatrixPosition(reticle.matrix);
        // Ajustar rotación para que mire al usuario, manteniendo el Y arriba
        const yRotation = Math.atan2(
          (camera.position.x - portalGroup.position.x),
          (camera.position.z - portalGroup.position.z)
        );
        portalGroup.rotation.y = yRotation;
        
        scene.add(portalGroup);
        portalInstantiated = true;
        reticle.visible = false;
        
        onInstructionsUpdate("Camina hacia el portal para entrar");
      }
    });
    scene.add(controller);

    window.addEventListener('resize', onWindowResize);
    
    renderer.setAnimationLoop(render);
    
  } catch(e) {
    console.error("Error inicializando AR Scene", e);
  }
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

    if (hitTestSourceRequested === false) {
      session.requestReferenceSpace('viewer').then(function (referenceSpace) {
        session.requestHitTestSource({ space: referenceSpace }).then(function (source) {
          hitTestSource = source;
        });
      });
      session.addEventListener('end', function () {
        hitTestSourceRequested = false;
        hitTestSource = null;
      });
      hitTestSourceRequested = true;
    }

    if (hitTestSource) {
      const hitTestResults = frame.getHitTestResults(hitTestSource);
      if (hitTestResults.length > 0) {
        const hit = hitTestResults[0];
        reticle.visible = true;
        reticle.matrix.fromArray(hit.getPose(referenceSpace).transform.matrix);
        onInstructionsUpdate("Toca para colocar el portal");
      } else {
        reticle.visible = false;
        onInstructionsUpdate("Buscando superficie plana (piso)...");
      }
    }
  }
  
  if (portalInstantiated && portalGroup) {
    checkPortalCrossing(camera, portalGroup, onInstructionsUpdate);
  }

  renderer.render(scene, camera);
}
