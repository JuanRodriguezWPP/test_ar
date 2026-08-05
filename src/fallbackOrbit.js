import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadPortalAssets, setInteriorStencil } from './portal.js';

let camera, scene, renderer, controls;
let isInside = false;

export async function initFallbackScene(onLoadComplete, onProgress, instructionsCallback) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x222222);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.6, 4);

  const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  light.position.set(0, 20, 0);
  scene.add(light);
  
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(2, 5, 2);
  scene.add(dirLight);

  // Cuadrícula en el suelo como referencia
  const gridHelper = new THREE.GridHelper(10, 10, 0x00704A, 0x444444);
  scene.add(gridHelper);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();

  const manager = new THREE.LoadingManager();
  manager.onProgress = function (url, itemsLoaded, itemsTotal) {
    onProgress((itemsLoaded / itemsTotal) * 100);
  };

  try {
    const portalGroup = await loadPortalAssets(manager);
    scene.add(portalGroup);
    onLoadComplete();
    instructionsCallback("Haz doble tap para entrar o salir del portal");

    // Lógica para simular entrar/salir con doble clic/tap
    renderer.domElement.addEventListener('dblclick', () => togglePortal(instructionsCallback));
    
    // Soporte para doble tap en móviles
    let lastTap = 0;
    renderer.domElement.addEventListener('touchend', (e) => {
      const currentTime = new Date().getTime();
      const tapLength = currentTime - lastTap;
      if (tapLength < 500 && tapLength > 0) {
        togglePortal(instructionsCallback);
        e.preventDefault();
      }
      lastTap = currentTime;
    });

    window.addEventListener('resize', onWindowResize);
    renderer.setAnimationLoop(render);

  } catch (e) {
    console.error("Error en Fallback Scene", e);
  }
}

function togglePortal(instructionsCallback) {
  isInside = !isInside;
  if(isInside) {
    setInteriorStencil(false);
    instructionsCallback("Estás dentro. Doble tap para salir.");
    // Mover cámara adentro
    camera.position.set(0, 1.5, -1);
    controls.target.set(0, 1.5, -3);
  } else {
    setInteriorStencil(true);
    instructionsCallback("Haz doble tap para entrar o salir del portal");
    // Mover cámara afuera
    camera.position.set(0, 1.6, 4);
    controls.target.set(0, 1, 0);
  }
  controls.update();
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function render() {
  controls.update();
  renderer.render(scene, camera);
}
