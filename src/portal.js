import * as THREE from 'three';

const STENCIL_REF = 1;
const DOOR_W = 1.8;   // metros ancho puerta
const DOOR_H = 3.0;   // metros alto  puerta

/**
 * buildPortalGroup:
 *  - Marco físico con label "McCORMICK"
 *  - Plano stencil (ventana invisible que define lo que se ve adentro)
 *  - Esfera 360° con la imagen panorámica (con stencil al inicio)
 *  - Modelo Paprika 1.glb flotando AFUERA de la puerta (sin stencil)
 */
export async function buildPortalGroup(loader) {
  const group = new THREE.Group();
  let paprikaMesh   = null;
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

  // 4. Páprika dentro del portal (oculta hasta cruzar)
  paprikaMesh = await loadPaprika(loader);
  if (paprikaMesh) {
    paprikaMesh.position.set(0, paprikaBaseY, -3); // dentro del mundo 360
    paprikaMesh.visible = false; // oculta hasta que el usuario entre
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

  // Material oscuro tipo madera fina
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1a0a00,
    roughness: 0.35,
    metalness: 0.45,
  });

  const T = 0.14; // grosor del marco

  // Poste izquierdo
  const left = new THREE.Mesh(new THREE.BoxGeometry(T, DOOR_H, T * 1.5), mat);
  left.position.set(-(DOOR_W / 2 + T / 2), DOOR_H / 2, 0);

  // Poste derecho
  const right = left.clone();
  right.position.set(DOOR_W / 2 + T / 2, DOOR_H / 2, 0);

  // Barra superior
  const top = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W + T * 2, T, T * 1.5), mat);
  top.position.set(0, DOOR_H + T / 2, 0);

  // Label "McCORMICK" encima del marco
  const label = createMcCormickLabel();

  g.add(left, right, top, label);
  return g;
}

function createMcCormickLabel() {
  // Crear textura con canvas
  const canvas = document.createElement('canvas');
  canvas.width  = 512;
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
  ctx.font      = 'bold 62px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('McCORMICK', 256, 64);

  const tex  = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DOOR_W * 1.05, 0.38),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  mesh.position.set(0, DOOR_H + 0.24, 0.02);
  return mesh;
}

// ─── Plano Stencil ────────────────────────────────────────────
function createStencilPlane() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DOOR_W, DOOR_H),
    new THREE.MeshBasicMaterial({
      colorWrite:   false,
      depthWrite:   false,
      stencilWrite: true,
      stencilRef:   STENCIL_REF,
      stencilFunc:  THREE.AlwaysStencilFunc,
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

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(50, 64, 40),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide })
  );
  sphere.renderOrder = 2;
  container.add(sphere);

  // Aplicar stencil por defecto (solo visible a través del hueco de la puerta)
  applyStencil(container, true);

  // Ligero offset para no competir con el plano stencil en el Z-buffer
  container.position.z = -0.02;
  container.renderOrder = 2;

  return container;
}

// ─── Modelo Páprika ───────────────────────────────────────────
async function loadPaprika(loader) {
  try {
    const gltf = await loader.loadAsync('/models/Paprika 1.glb');
    const model = gltf.scene;

    // Ajustar escala para que se vea bien al lado de la puerta
    const bbox = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const targetH = 1.0; // queremos ~1 metro de alto
    const s = targetH / maxDim;
    model.scale.set(s, s, s);

    // Centrar horizontalmente en la base
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    model.position.x = -center.x * s;

    return model;
  } catch (e) {
    console.warn('Paprika 1.glb no cargado:', e);
    return null;
  }
}

// ─── Stencil ──────────────────────────────────────────────────
function applyStencil(obj, enabled) {
  obj.traverse(child => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach(mat => {
      mat.stencilWrite = enabled;
      mat.stencilRef   = STENCIL_REF;
      mat.stencilFunc  = enabled ? THREE.EqualStencilFunc : THREE.AlwaysStencilFunc;
      mat.stencilFail  = THREE.KeepStencilOp;
      mat.stencilZFail = THREE.KeepStencilOp;
      mat.stencilZPass = THREE.KeepStencilOp;
      mat.needsUpdate  = true;
    });
  });
}
