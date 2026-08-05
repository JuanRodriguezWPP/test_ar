import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DeviceOrientationControls } from './DeviceOrientationControls.js';

let camera, scene, renderer, controls;
let cameraVelocity = 0; // velocidad hacia adelante/atrás
const MOVE_SPEED = 0.04;
const DECELERATION = 0.92;

export async function initFallbackScene(onLoadComplete, onProgress, instructionsCallback) {
  const setInstructions = instructionsCallback || (() => {});

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  scene.fog = new THREE.Fog(0x1a1a2e, 20, 60);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 1.6, 8); // Altura de ojos

  // Iluminación
  const hemi = new THREE.HemisphereLight(0xffeedd, 0x222233, 1.5);
  scene.add(hemi);
  const dirLight = new THREE.DirectionalLight(0xfff5e1, 2);
  dirLight.position.set(5, 10, 5);
  scene.add(dirLight);
  const fillLight = new THREE.DirectionalLight(0xe8a87c, 0.5);
  fillLight.position.set(-5, 5, -5);
  scene.add(fillLight);

  // Suelo
  const floorGeo = new THREE.PlaneGeometry(100, 100);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x111122 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const gridHelper = new THREE.GridHelper(100, 50, 0x333355, 0x222233);
  scene.add(gridHelper);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.style.position = 'fixed';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  renderer.domElement.style.zIndex = '0';
  document.body.appendChild(renderer.domElement);

  // DeviceOrientationControls para giroscopio (mirar alrededor)
  controls = new DeviceOrientationControls(camera);

  // Acelerómetro para moverse adelante/atrás
  let lastAccelY = 0;
  const handleMotion = (event) => {
    const accel = event.acceleration || event.accelerationIncludingGravity;
    if (!accel) return;
    // En eje Y del acelerómetro: inclinación del teléfono hacia adelante/atrás
    const ay = accel.y || 0;
    const delta = ay - lastAccelY;
    lastAccelY = ay;
    // Filtro de ruido: solo reaccionar a movimientos significativos
    if (Math.abs(delta) > 0.3) {
      cameraVelocity += delta * 0.015;
      // Limitar velocidad máxima
      cameraVelocity = Math.max(-0.15, Math.min(0.15, cameraVelocity));
    }
  };

  // En iOS necesitamos pedir permiso para DeviceMotion
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    // iOS 13+
    DeviceMotionEvent.requestPermission()
      .then(permissionState => {
        if (permissionState === 'granted') {
          window.addEventListener('devicemotion', handleMotion);
        }
      })
      .catch(console.error);
  } else {
    // Android y otros
    window.addEventListener('devicemotion', handleMotion);
  }

  // Fallback táctil: swipe vertical para moverse adelante/atrás
  let touchStartY = null;
  renderer.domElement.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  renderer.domElement.addEventListener('touchmove', (e) => {
    if (touchStartY === null) return;
    const dy = touchStartY - e.touches[0].clientY;
    cameraVelocity += dy * 0.0005;
    cameraVelocity = Math.max(-0.15, Math.min(0.15, cameraVelocity));
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  renderer.domElement.addEventListener('touchend', () => {
    touchStartY = null;
  }, { passive: true });

  renderer.setAnimationLoop(render);

  // Cargar el modelo
  const loader = new GLTFLoader();
  try {
    onProgress(10);
    const gltf = await loader.loadAsync('/models/Dia_de_Muertos.glb',
      (event) => {
        if (event.total > 0) {
          onProgress(10 + (event.loaded / event.total) * 85);
        }
      }
    );

    const model = gltf.scene;
    const bbox = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const center = new THREE.Vector3();
    bbox.getCenter(center);

    model.position.x = -center.x;
    model.position.y = -bbox.min.y;
    model.position.z = -center.z;
    scene.add(model);

    // Posicionar la cámara a buena distancia frente al modelo
    const maxDim = Math.max(size.x, size.y, size.z);
    camera.position.set(0, size.y * 0.5, maxDim * 1.8);

    onProgress(100);
    onLoadComplete();
    setInstructions('Mueve el teléfono para mirar · Inclina para avanzar/retroceder');

  } catch (err) {
    console.error('Error cargando modelo:', err);
    // Escena de respaldo con geometría básica
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2),
      new THREE.MeshStandardMaterial({ color: 0xff8c00 })
    );
    box.position.y = 1;
    scene.add(box);
    onLoadComplete();
    setInstructions('Mueve el teléfono para mirar alrededor');
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

  if (controls) controls.update();

  // Mover la cámara hacia donde está mirando
  if (Math.abs(cameraVelocity) > 0.0005) {
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    // Solo mover en XZ (no hacia arriba/abajo)
    direction.y = 0;
    direction.normalize();
    camera.position.addScaledVector(direction, cameraVelocity * MOVE_SPEED * 60);
    cameraVelocity *= DECELERATION; // Desacelerar suavemente
  }

  renderer.render(scene, camera);
}
