import * as THREE from 'three';

const STENCIL_REF = 1;
const DOOR_W = 1.4;  // metros de ancho de la puerta
const DOOR_H = 2.2;  // metros de alto de la puerta

/**
 * buildPortalGroup:
 * Crea el grupo completo del portal:
 *  - Marco físico (fallback geométrico si portal_frame.glb no existe)
 *  - Plano stencil (ventana invisible)
 *  - Habitación interior + modelo Dia_de_Muertos.glb
 */
export async function buildPortalGroup(loader) {
  const group = new THREE.Group();

  // 1. Marco del portal (geometría básica si no hay .glb)
  const frame = await loadFrame(loader);
  group.add(frame);

  // 2. Plano Stencil - La "ventana" invisible que define lo que se ve adentro
  const stencilMesh = createStencilPlane();
  group.add(stencilMesh);

  // 3. Contenedor interior (habitación + modelo)
  const interior = await buildInterior(loader);
  group.add(interior);

  // 4. Función pública para activar/desactivar el efecto estilo portal
  group.userData.setStencil = (enabled) => {
    applyStencil(interior, enabled);
    frame.visible   = enabled;
    stencilMesh.visible = enabled;
  };

  return group;
}

// ─── Marco del portal ─────────────────────────────────────────
async function loadFrame(loader) {
  try {
    const gltf = await loader.loadAsync('/models/portal_frame.glb');
    return gltf.scene;
  } catch {
    // Fallback geométrico: tres barras que forman un marco de puerta
    return buildFrameGeometry();
  }
}

function buildFrameGeometry() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x8B4513, roughness: 0.6, metalness: 0.2 });
  const T = 0.12; // grosor del marco

  // Barra izquierda
  const left = new THREE.Mesh(new THREE.BoxGeometry(T, DOOR_H + T, T), mat);
  left.position.set(-(DOOR_W / 2 + T / 2), DOOR_H / 2, 0);

  // Barra derecha
  const right = left.clone();
  right.position.set(DOOR_W / 2 + T / 2, DOOR_H / 2, 0);

  // Barra superior
  const top = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W + T * 2, T, T), mat);
  top.position.set(0, DOOR_H + T / 2, 0);

  g.add(left, right, top);
  return g;
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

// ─── Interior: habitación + modelo ────────────────────────────
async function buildInterior(loader) {
  const container = new THREE.Group();

  // Cargar el modelo
  let model = null;
  try {
    const gltf = await loader.loadAsync('/models/Dia_de_Muertos.glb');
    model = gltf.scene;
  } catch (e) {
    console.warn('Dia_de_Muertos.glb no encontrado, usando cubo de prueba');
    model = createDummyModel();
  }

  // Calcular bounding box del modelo para ajustar la habitación
  const bbox = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bbox.getSize(size);
  bbox.getCenter(center);

  // Dimensiones de la habitación: modelo + margen
  const rW = Math.max(size.x + 5, DOOR_W + 2);
  const rH = Math.max(size.y + 2, DOOR_H + 1);
  const rD = Math.max(size.z + 5, 6);

  // Centrar modelo en la habitación
  model.position.set(-center.x, -bbox.min.y, -center.z - rD / 2);
  container.add(model);

  // Construir la habitación
  const room = buildRoom(rW, rH, rD);
  container.add(room);

  // Aplicar stencil a todo el interior
  applyStencil(container, true);

  container.position.z = -0.02; // Evitar z-fighting con el plano stencil

  return container;
}

// ─── Habitación ───────────────────────────────────────────────
function buildRoom(W, H, D) {
  const g = new THREE.Group();
  const wallMat  = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, side: THREE.BackSide, roughness: 0.9 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x0d0d1a, side: THREE.BackSide, roughness: 1.0 });

  const zC = -D / 2; // Centro en Z de la habitación

  // Suelo
  addPlane(g, W, D, floorMat, [0, 0, zC], [-Math.PI / 2, 0, 0]);

  // Techo
  addPlane(g, W, D, wallMat, [0, H, zC], [Math.PI / 2, 0, 0]);

  // Pared trasera
  addPlane(g, W, H, wallMat, [0, H / 2, -D], [0, 0, 0]);

  // Pared izquierda
  addPlane(g, D, H, wallMat, [-W / 2, H / 2, zC], [0, Math.PI / 2, 0]);

  // Pared derecha
  addPlane(g, D, H, wallMat, [W / 2, H / 2, zC], [0, -Math.PI / 2, 0]);

  // Pared frontal - 3 piezas (dejando hueco de la puerta al centro)
  const sideW = (W - DOOR_W) / 2;
  // Pieza izquierda
  addPlane(g, sideW, H, wallMat, [-(DOOR_W / 2 + sideW / 2), H / 2, 0], [0, Math.PI, 0]);
  // Pieza derecha
  addPlane(g, sideW, H, wallMat, [(DOOR_W / 2 + sideW / 2), H / 2, 0], [0, Math.PI, 0]);
  // Pieza superior (sobre la puerta)
  const topH = H - DOOR_H;
  if (topH > 0) {
    addPlane(g, DOOR_W, topH, wallMat, [0, DOOR_H + topH / 2, 0], [0, Math.PI, 0]);
  }

  return g;
}

function addPlane(parent, w, h, mat, pos, rot) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.position.set(...pos);
  m.rotation.set(...rot);
  parent.add(m);
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
    });
  });
}

// ─── Dummy model ──────────────────────────────────────────────
function createDummyModel() {
  const g = new THREE.Group();
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xff6600 })
  );
  m.position.y = 0.5;
  g.add(m);
  return g;
}
