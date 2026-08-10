import * as THREE from 'three';

const STENCIL_REF = 1;
const DOOR_W = 2.8;   // Restaurado al ancho anterior
const DOOR_H = 2.5;   // Altura original

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

  // 4. Páprika dentro del portal (a la izquierda)
  paprikaMesh = await loadPaprika(loader);
  if (paprikaMesh) {
    paprikaMesh.position.set(-1.5, paprikaBaseY, -3.0); // A la izquierda, dentro del portal
    paprikaMesh.visible = false;
    group.add(paprikaMesh);
  }

  // ── API pública ───────────────────────────────────────────────
  group.userData.setStencil = (enabled) => {
    applyStencil(interior, enabled);      // enabled=true → solo por el hueco; false → todo el espacio
    stencilMesh.visible = enabled;
    frame.visible = enabled; // Ocultar la puerta cuando estás adentro
    // La Páprika aparece SOLO cuando se entra al portal
    if (paprikaMesh) paprikaMesh.visible = !enabled;

    // MAGIA: Deslizar la esfera físicamente para arreglar el 360
    if (enabled) {
      // Afuera: La esfera se aleja para dar el efecto "zoom out"
      interior.position.z = -15.0;
      interior.position.y = -5.0;
    } else {
      // Adentro: La esfera "salta" hacia ti para que quedes exactamente en su centro
      // Esto arregla completamente la vista 360 sin deformaciones ni ojos de pez
      interior.position.z = -2.0;
      interior.position.y = 0.0;
    }
  };

  // Exponer la páprika para el Raycaster (mostrar CTA al mirarla)
  group.userData.getPaprika = () => paprikaMesh;

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
  return buildFrameGeometry();
}

function createCheckeredTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Colores del patrón (Rojo y Blanco)
  const colorRed = '#d32f2f'; // Un rojo más vivo
  const colorWhite = '#ffffff'; // Blanco

  ctx.fillStyle = colorRed;
  ctx.fillRect(0, 0, 256, 256);

  ctx.fillStyle = colorWhite;
  // Dibujar cuadros blancos para formar el patrón de ajedrez
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillRect(128, 128, 128, 128);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildFrameGeometry() {
  const g = new THREE.Group();

  // Textura y Materiales
  const checkTex = createCheckeredTexture();
  checkTex.repeat.set(2, 4); // Repetición para las columnas frontales

  const facadeMat = new THREE.MeshStandardMaterial({
    map: checkTex,
    roughness: 0.8,
  });

  const doorMat = new THREE.MeshStandardMaterial({
    color: 0x333333, // Gris oscuro
    roughness: 0.4,
    metalness: 0.2
  });

  const DEPTH = 1.5; // Profundidad del portal
  const COL_W = 1.0; // Ancho de las columnas frontales

  // 1. FACHADA FRONTAL
  // Columna Izquierda
  const leftColTex = checkTex.clone();
  leftColTex.repeat.set(1.5, 4);
  const leftCol = new THREE.Mesh(new THREE.BoxGeometry(COL_W, DOOR_H, 0.2), new THREE.MeshStandardMaterial({ map: leftColTex, roughness: 0.8 }));
  leftCol.position.set(-(DOOR_W / 2 + COL_W / 2), DOOR_H / 2, 0);

  // Columna Derecha
  const rightCol = new THREE.Mesh(new THREE.BoxGeometry(COL_W, DOOR_H, 0.2), new THREE.MeshStandardMaterial({ map: leftColTex, roughness: 0.8 }));
  rightCol.position.set((DOOR_W / 2 + COL_W / 2), DOOR_H / 2, 0);

  // Viga superior (Fachada)
  const topTex = checkTex.clone();
  topTex.repeat.set(5, 1);
  const topBeam = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W + COL_W * 2, 1.2, 0.2), new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.8 }));
  topBeam.position.set(0, DOOR_H + 0.6, 0);

  // 2. VESTÍBULO (Paredes interiores que dan profundidad)
  // Para evitar "Z-fighting" (parpadeo) con las columnas frontales que miden 0.2 de grosor (de +0.1 a -0.1 en Z),
  // empezamos las paredes interiores exactamente en Z = -0.1
  const INNER_DEPTH = DEPTH - 0.1;
  const INNER_Z = -0.1 - (INNER_DEPTH / 2);

  const wallTex = checkTex.clone();
  wallTex.repeat.set(INNER_DEPTH, DOOR_H); // Ajustar repetición por tamaño
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 });

  // Pared interior izquierda
  const innerLeft = new THREE.Mesh(new THREE.PlaneGeometry(INNER_DEPTH, DOOR_H), wallMat);
  innerLeft.rotation.y = Math.PI / 2;
  innerLeft.position.set(-DOOR_W / 2, DOOR_H / 2, INNER_Z);

  // Pared interior derecha
  const innerRight = new THREE.Mesh(new THREE.PlaneGeometry(INNER_DEPTH, DOOR_H), wallMat);
  innerRight.rotation.y = -Math.PI / 2;
  innerRight.position.set(DOOR_W / 2, DOOR_H / 2, INNER_Z);

  // Techo interior
  const ceilTex = checkTex.clone();
  ceilTex.repeat.set(DOOR_W, INNER_DEPTH);
  const ceilMat = new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 0.9 });
  const innerCeil = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W, INNER_DEPTH), ceilMat);
  innerCeil.rotation.x = Math.PI / 2;
  innerCeil.position.set(0, DOOR_H, INNER_Z);

  // (Piso interior café retirado a petición)
  // En su lugar, colocamos un piso "invisible" que actúa como portal (stencil)
  // para que la imagen 360 se pinte también sobre el piso del túnel y no se corte.
  const floorStencilMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    stencilWrite: true,
    stencilRef: STENCIL_REF,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  const innerFloorStencil = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W, INNER_DEPTH), floorStencilMat);
  innerFloorStencil.rotation.x = -Math.PI / 2;
  innerFloorStencil.position.set(0, 0, INNER_Z);
  innerFloorStencil.renderOrder = 0;

  // 3. PUERTAS ABIERTAS CON DISEÑO DE PANELES (Fijadas al final del vestíbulo)
  const doorGroupL = new THREE.Group();
  doorGroupL.position.set(-DOOR_W / 2, 0, -DEPTH);

  const doorL = createDoorMesh(DOOR_W / 2, DOOR_H, doorMat);
  doorL.position.set(DOOR_W / 4, 0, 0); // Eje de rotación en el borde izquierdo
  doorGroupL.add(doorL);
  // Abierta hacia ADENTRO (hacia el 360). 
  // 0.25 * PI = 45 grados (suficiente para verse claras y abiertas)
  doorGroupL.rotation.y = -Math.PI * 0.25;

  const doorGroupR = new THREE.Group();
  doorGroupR.position.set(DOOR_W / 2, 0, -DEPTH);

  const doorR = createDoorMesh(DOOR_W / 2, DOOR_H, doorMat);
  doorR.position.set(-DOOR_W / 4, 0, 0); // Eje de rotación en el borde derecho
  doorGroupR.add(doorR);
  doorGroupR.rotation.y = Math.PI * 0.25; // Abierta hacia ADENTRO

  // Molduras doradas en el letrero superior
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xC8A84B, roughness: 0.2, metalness: 0.8 });
  const goldTrimTop = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W + COL_W * 2 + 0.1, 0.05, 0.25), goldMat);
  goldTrimTop.position.set(0, DOOR_H + 1.2, 0.05);
  const goldTrimBot = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W + COL_W * 2 + 0.1, 0.05, 0.25), goldMat);
  goldTrimBot.position.set(0, DOOR_H, 0.05);

  // Label "McCORMICK"
  const label = createMcCormickLabel();

  g.add(leftCol, rightCol, topBeam, innerLeft, innerRight, innerCeil, innerFloorStencil, doorGroupL, doorGroupR, goldTrimTop, goldTrimBot, label);
  return g;
}

// Genera una puerta con diseño clásico de panel rebajado
function createDoorMesh(w, h, mat) {
  const g = new THREE.Group();
  const fw = 0.18; // Grosor del marco lateral y superior
  const bw = 0.30; // Grosor del zócalo inferior (más grueso)
  const d = 0.08;  // Profundidad de la puerta
  const pd = 0.02; // Profundidad del panel hundido

  // Marco izquierdo
  const left = new THREE.Mesh(new THREE.BoxGeometry(fw, h, d), mat);
  left.position.set(-w / 2 + fw / 2, h / 2, 0);

  // Marco derecho
  const right = new THREE.Mesh(new THREE.BoxGeometry(fw, h, d), mat);
  right.position.set(w / 2 - fw / 2, h / 2, 0);

  // Marco superior
  const top = new THREE.Mesh(new THREE.BoxGeometry(w - fw * 2, fw, d), mat);
  top.position.set(0, h - fw / 2, 0);

  // Marco inferior
  const bot = new THREE.Mesh(new THREE.BoxGeometry(w - fw * 2, bw, d), mat);
  bot.position.set(0, bw / 2, 0);

  // Panel central hundido
  const panel = new THREE.Mesh(new THREE.BoxGeometry(w - fw * 2, h - fw - bw, pd), mat);
  panel.position.set(0, bw + (h - fw - bw) / 2, 0);

  g.add(left, right, top, bot, panel);
  return g;
}

function createMcCormickLabel() {
  // Crear textura con canvas
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Fondo transparente
  ctx.clearRect(0, 0, 1024, 256);

  // Texto principal "McCORMICK" estilo la referencia (Letras blancas gruesas, sombra)
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '900 120px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Sombra suave para dar volumen 3D a las letras
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 4;
  ctx.shadowOffsetY = 4;

  ctx.fillText('McCORMICK', 512, 128);

  const tex = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DOOR_W + 1.5, 0.8),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  // Posicionado justo en el panel superior
  mesh.position.set(0, DOOR_H + 0.6, 0.12);
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
  // IMPORTANTE: El plano del stencil ahora debe estar al FINAL del vestíbulo (-1.5 metros),
  // para que las paredes del túnel (vestíbulo) sean visibles desde afuera.
  mesh.position.set(0, DOOR_H / 2, -1.5);
  return mesh;
}

// ─── Esfera 360° interior ─────────────────────────────────────
function buildInterior() {
  const container = new THREE.Group();

  // Cargar imagen panorámica equirectangular
  const tex = new THREE.TextureLoader().load(
    '/models/360img2.png',
    () => { /* cargada OK */ },
    undefined,
    (e) => console.warn('Error cargando panorama 360:', e)
  );

  // Flip horizontal necesario para que la imagen se vea correcta desde adentro (BackSide)
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping; // Evita que se repita el techo en el piso

  // ESCALAR LA TEXTURA (LA SOLUCIÓN REAL)
  // Como la puerta es angosta y estamos a 3m de distancia, geométricamente solo vemos un ángulo pequeño de la esfera.
  // Para ver "más" de la imagen, hacemos la imagen más pequeña en la esfera.
  tex.center.set(0.5, 0.5);
  // Aumentamos de 1.5 a 2.5 para alejar la imagen muchísimo más (hace la imagen casi un tercio de su tamaño original).
  tex.repeat.set(-2.5, 2.5);

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

  // Tienes razón, ponerlo en el extremo (-50) genera un efecto "ojo de pez" o de globo muy fuerte.
  // Vamos a buscar el punto intermedio perfecto: suficiente distancia para ver el altar completo, 
  // pero sin que se deformen las orillas.
  container.position.z = -15.0;

  // Como la esfera ya no está tan lejos, ajustamos un poco menos la altura para centrar el horizonte.
  container.position.y = -5.0;

  // Escala 100% natural, sin túneles
  container.scale.set(1.0, 1.0, 1.0);

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
