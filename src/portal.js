import * as THREE from 'three';

const STENCIL_REF = 1;
const DOOR_W = 2.8;   // Ajustado para que quepa en pantalla
const DOOR_H = 2.5;   // Reducido ligeramente para no cortarse arriba

/**
 * buildPortalGroup:
 *  - Marco físico con label "McCORMICK"
 *  - Plano stencil (ventana invisible que define lo que se ve adentro)
 *  - Esfera 360° con la imagen panorámica (con stencil al inicio)
 *  - Modelo Paprika 1.glb flotando AFUERA de la puerta (sin stencil)
 */
export async function buildPortalGroup(loader) {
  const group = new THREE.Group();
  let paprikaMesh = null;
  const paprikaBaseY = 1.2; // altura de flotación del modelo

  // 1. Marco del portal
  const frame = await loadFrame(loader);
  group.add(frame);

  // 2. Plano stencil – "ventana" invisible
  const stencilMesh = createStencilPlane();
  stencilMesh.renderOrder = 0;
  group.add(stencilMesh);

  // 3. Esfera 360 interior (solo visible a través de la puerta gracias al stencil)
  const interior = buildInterior();
  group.add(interior);

  // 4. Páprika dentro del portal (movida a la derecha y profunda para forzar a buscarla)
  paprikaMesh = await loadPaprika(loader);
  if (paprikaMesh) {
    paprikaMesh.position.set(2.5, paprikaBaseY, -5.0); // A la derecha, lejos de la cara
    paprikaMesh.visible = false;

    // Etiqueta de producto flotante
    const productLabel = createProductLabel();
    productLabel.position.set(0, 0.8, 0); // Arriba del producto
    paprikaMesh.add(productLabel);

    group.add(paprikaMesh);
  }

  // ── API pública ───────────────────────────────────────────────
  group.userData.setStencil = (enabled) => {
    applyStencil(interior, enabled);      // enabled=true → solo por el hueco; false → todo el espacio
    stencilMesh.visible = enabled;
    // La Páprika aparece SOLO cuando se entra al portal
    if (paprikaMesh) paprikaMesh.visible = !enabled;
  };

  // Animación de flotación de la Páprika (llamar desde renderLoop)
  group.userData.tick = (ts) => {
    if (paprikaMesh) {
      paprikaMesh.position.y = paprikaBaseY + Math.sin(ts * 0.0015) * 0.18;
      paprikaMesh.rotation.y += 0.006;
    }
  };

  return group;
}

// ─── Marco del portal ─────────────────────────────────────────
async function loadFrame(loader) {
  // Siempre construimos el marco personalizado de McCORMICK
  return buildFrameGeometry();
}

function buildFrameGeometry() {
  const g = new THREE.Group();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x1a0a00, roughness: 0.35, metalness: 0.45,
  });
  const goldMat = new THREE.MeshStandardMaterial({
    color: 0xC8A84B, roughness: 0.2, metalness: 0.8,
  });

  const T = 0.2; // Grosor de los pilares principales

  // Pilar Izquierdo
  const pL = new THREE.Mesh(new THREE.BoxGeometry(T, DOOR_H, T * 1.5), mat);
  pL.position.set(-(DOOR_W / 2 + T / 2), DOOR_H / 2, 0);
  // Base dorada izq
  const bL = new THREE.Mesh(new THREE.BoxGeometry(T * 1.2, 0.1, T * 1.7), goldMat);
  bL.position.set(0, -DOOR_H / 2 + 0.05, 0);
  pL.add(bL);
  // Capitel dorado izq
  const cL = new THREE.Mesh(new THREE.BoxGeometry(T * 1.2, 0.1, T * 1.7), goldMat);
  cL.position.set(0, DOOR_H / 2 - 0.05, 0);
  pL.add(cL);

  // Pilar Derecho
  const pR = pL.clone();
  pR.position.set(DOOR_W / 2 + T / 2, DOOR_H / 2, 0);

  // Viga superior doble
  const top1 = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W + T * 2.5, T, T * 1.5), mat);
  top1.position.set(0, DOOR_H + T / 2, 0);

  const top2 = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W + T * 3.0, 0.08, T * 1.7), goldMat);
  top2.position.set(0, DOOR_H + T + 0.04, 0);

  // Label "McCORMICK"
  const label = createMcCormickLabel();

  g.add(pL, pR, top1, top2, label);
  return g;
}

function createMcCormickLabel() {
  // Crear textura con canvas
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  // Fondo rojo oscuro con bordes redondeados
  ctx.fillStyle = '#8B0000';
  ctx.beginPath();
  ctx.roundRect(0, 0, 512, 128, 18);
  ctx.fill();

  // Borde dorado
  ctx.strokeStyle = '#C8A84B';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(3, 3, 506, 122, 15);
  ctx.stroke();

  // Texto principal
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 62px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('McCORMICK', 256, 64);

  const tex = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DOOR_W * 1.05, 0.38),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  // Se subió el letrero para que quede por encima de la doble viga superior (ajustado a la nueva altura)
  mesh.position.set(0, DOOR_H + 0.6, 0.02);
  return mesh;
}

// ─── Plano Stencil ────────────────────────────────────────────
function createStencilPlane() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DOOR_W, DOOR_H),
    new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      stencilWrite: true,
      stencilRef: STENCIL_REF,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp,
    })
  );
  mesh.position.set(0, DOOR_H / 2, 0);
  return mesh;
}

// ─── Esfera 360° interior ─────────────────────────────────────
function buildInterior() {
  const container = new THREE.Group();

  // Cargar imagen panorámica equirectangular
  const tex = new THREE.TextureLoader().load(
    '/models/5cf0bbd5-866d-4750-a6dd-85134b96dd15.png',
    () => { /* cargada OK */ },
    undefined,
    (e) => console.warn('Error cargando panorama 360:', e)
  );

  // Flip horizontal necesario para que la imagen se vea correcta desde adentro (BackSide)
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.x = -1;
  tex.colorSpace = THREE.SRGBColorSpace; // Corrección de color para Three.js moderno

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(50, 64, 40),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide })
  );

  // Rotar la esfera para enfocar el altar (giramos 180° respecto al intento anterior)
  sphere.rotation.y = Math.PI / 2;

  sphere.renderOrder = 2;
  container.add(sphere);

  // Aplicar stencil por defecto (solo visible a través del hueco de la puerta)
  applyStencil(container, true);

  // Mover la esfera hacia atrás. Entre más negativo sea este valor, más "lejos" y con
  // menos zoom se verá la imagen desde la puerta. (Ej: -10, -20, -30).
  // Límite máximo recomendado: -40 (porque la esfera tiene radio 50).
  container.position.z = -40.0;
  container.renderOrder = 2;

  return container;
}

// ─── Modelo Páprika y Etiqueta ────────────────────────────────
async function loadPaprika(loader) {
  try {
    const gltf = await loader.loadAsync('/models/Paprika 1.glb');
    const model = gltf.scene;

    // Ajustar escala para que se vea de 1 metro
    const bbox = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const targetH = 1.0;
    const s = targetH / maxDim;
    model.scale.set(s, s, s);

    // Centrar modelo localmente
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    model.position.set(-center.x * s, -bbox.min.y * s, -center.z * s);

    // Envolver en un grupo para que la rotación sea pura
    const wrapper = new THREE.Group();
    wrapper.add(model);
    return wrapper;
  } catch (e) {
    console.warn('Paprika 1.glb no cargado:', e);
    return null;
  }
}

function createProductLabel() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Fondo cristalino oscuro
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.beginPath();
  ctx.roundRect(0, 0, 512, 256, 30);
  ctx.fill();

  // Borde
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 4;
  ctx.stroke();

  // Marca
  ctx.fillStyle = '#C8A84B'; // Dorado
  ctx.font = 'bold 46px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('McCORMICK', 256, 90);

  // Producto
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 72px Georgia, serif';
  ctx.fillText('PÁPRIKA', 256, 170);

  // Subtítulo
  ctx.fillStyle = '#AAAAAA';
  ctx.font = '30px Arial, sans-serif';
  ctx.fillText('Edición Especial 100% Pura', 256, 220);

  const tex = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 0.8),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })
  );
  return mesh;
}

// ─── Stencil ──────────────────────────────────────────────────
function applyStencil(obj, enabled) {
  obj.traverse(child => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach(mat => {
      mat.stencilWrite = enabled;
      mat.stencilRef = STENCIL_REF;
      mat.stencilFunc = enabled ? THREE.EqualStencilFunc : THREE.AlwaysStencilFunc;
      mat.stencilFail = THREE.KeepStencilOp;
      mat.stencilZFail = THREE.KeepStencilOp;
      mat.stencilZPass = THREE.KeepStencilOp;
      mat.needsUpdate = true;
    });
  });
}
