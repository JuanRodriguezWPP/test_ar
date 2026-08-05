import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let camera, scene, renderer, controls;

export async function initFallbackScene(onLoadComplete, onProgress, instructionsCallback) {
  // Siempre manejar el caso de que instructionsCallback no exista
  const setInstructions = instructionsCallback || (() => {});

  // --- Crear el canvas y la escena PRIMERO, ANTES de ocultar el overlay ---
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 2, 8);

  // Iluminación rica
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
  scene.add(hemi);
  const dirLight = new THREE.DirectionalLight(0xfff5e1, 2);
  dirLight.position.set(5, 10, 5);
  scene.add(dirLight);
  const fillLight = new THREE.DirectionalLight(0xe8a87c, 0.5);
  fillLight.position.set(-5, 5, -5);
  scene.add(fillLight);

  // Cuadrícula en el suelo
  const gridHelper = new THREE.GridHelper(30, 30, 0x333355, 0x222233);
  scene.add(gridHelper);

  // Crear el renderer con fondo opaco (nunca transparent en fallback)
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;

  // Agregar el canvas al body INMEDIATAMENTE, antes de esconder el overlay
  renderer.domElement.style.position = 'fixed';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  renderer.domElement.style.zIndex = '0'; // Detrás del overlay
  document.body.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1;
  controls.maxDistance = 30;
  controls.update();

  // Lanzar el render loop INMEDIATAMENTE para que el canvas no se vea negro
  renderer.setAnimationLoop(render);

  // Cargar el modelo de Dia de Muertos directamente (sin pasar por la lógica del portal)
  const loader = new GLTFLoader();

  try {
    onProgress(10);

    const gltf = await loader.loadAsync('/models/Dia_de_Muertos.glb',
      (event) => {
        if (event.total > 0) {
          const pct = 10 + (event.loaded / event.total) * 85;
          onProgress(pct);
        }
      }
    );

    const model = gltf.scene;

    // Centrar y ajustar el modelo al suelo
    const bbox = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const center = new THREE.Vector3();
    bbox.getCenter(center);

    model.position.x = -center.x;
    model.position.y = -bbox.min.y;
    model.position.z = -center.z;

    scene.add(model);

    // Ajustar la cámara para encuadrar el modelo perfectamente
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    let camDist = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    camDist *= 1.5; // Margen
    camera.position.set(0, size.y * 0.5, Math.min(camDist, 30));
    controls.target.set(0, size.y * 0.4, 0);
    controls.update();

    onProgress(100);

    // Ahora sí ocultar el overlay (el canvas ya está renderizando)
    onLoadComplete();
    setInstructions('Arrastra para girar • Pellizca para hacer zoom');

  } catch (err) {
    console.error('Error cargando modelo en fallback:', err);

    // Si falla el modelo, mostrar al menos una escena funcional con geometría básica
    const boxGeo = new THREE.BoxGeometry(2, 2, 2);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xff8c00 });
    const box = new THREE.Mesh(boxGeo, boxMat);
    box.position.y = 1;
    scene.add(box);

    onLoadComplete();
    setInstructions('Error cargando modelo. Arrastra para girar.');
  }

  window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
  if (!camera || !renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function render() {
  if (!renderer || !scene || !camera) return;
  controls.update();
  renderer.render(scene, camera);
}
