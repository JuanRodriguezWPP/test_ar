import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let portalGroup = null;
const stencilRef = 1;

export async function loadPortalAssets(manager) {
  const loader = new GLTFLoader(manager);

  try {
    const [frameGltf, interiorGltf] = await Promise.all([
      loader.loadAsync('/models/portal_frame.glb').catch(() => {
        console.warn("No portal_frame.glb found, using dummy");
        return { scene: createDummyFrame() };
      }),
      loader.loadAsync('/models/Dia_de_Muertos.glb').catch(() => {
        console.warn("No Dia_de_Muertos.glb found, using dummy");
        return { scene: createDummyInterior() };
      })
    ]);
    
    portalGroup = new THREE.Group();
    
    // 1. Marco exterior
    const frame = frameGltf.scene;
    portalGroup.add(frame);
    
    // 2. Plano Stencil (La ventana invisible)
    const stencilGeometry = new THREE.PlaneGeometry(1.2, 2.0); 
    const stencilMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false, 
      depthWrite: false, 
      stencilWrite: true,
      stencilRef: stencilRef,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp
    });
    
    const stencilMesh = new THREE.Mesh(stencilGeometry, stencilMaterial);
    stencilMesh.position.set(0, 1.0, 0); // Centro de la puerta
    portalGroup.add(stencilMesh);

    // 3. Crear el Contenedor Interior (Habitación + Dia de Muertos)
    const interiorContainer = new THREE.Group();
    
    // Preparar el modelo de Dia de Muertos y calcular su tamaño real
    const diaDeMuertos = interiorGltf.scene;
    
    // Calcular el Bounding Box (caja delimitadora) del modelo
    const bbox = new THREE.Box3().setFromObject(diaDeMuertos);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const center = new THREE.Vector3();
    bbox.getCenter(center);

    // Añadir un margen (padding) de 2 metros alrededor del modelo para que la pared no lo toque
    const roomWidth = Math.max(size.x + 4, 4);  // Mínimo 4m de ancho
    const roomHeight = Math.max(size.y + 2, 3); // Mínimo 3m de alto
    const roomDepth = Math.max(size.z + 4, 4);  // Mínimo 4m de fondo

    // Crear el "Cubo" a la medida exacta del modelo
    const room = createRoom(roomWidth, roomHeight, roomDepth);
    interiorContainer.add(room);

    // Centrar el modelo de Dia de Muertos perfectamente dentro del cuarto
    // Movemos el modelo restando su centro original para que su punto 0,0,0 quede en el centro de masa.
    // Luego lo colocamos en el centro de la habitación: X=0, Y=piso, Z=mitad de la habitación
    diaDeMuertos.position.x = -center.x; 
    diaDeMuertos.position.y = -bbox.min.y; // Para que toque exactamente el suelo de la habitación
    diaDeMuertos.position.z = -center.z - (roomDepth / 2); // Centro de la habitación en profundidad
    
    interiorContainer.add(diaDeMuertos);

    // Aplicar lógica Stencil a TODO lo que está dentro del contenedor interior
    interiorContainer.traverse((child) => {
      if (child.isMesh) {
        if (Array.isArray(child.material)) {
          child.material.forEach(mat => setupStencilForMaterial(mat));
        } else {
          setupStencilForMaterial(child.material);
        }
      }
    });
    
    // Posicionar el contenedor interior un pelín detrás para evitar glitch visual con el stencil
    interiorContainer.position.set(0, 0, -0.05); 
    portalGroup.add(interiorContainer);
    
    return portalGroup;
  } catch (error) {
    console.error("Error loading portal assets:", error);
    throw error;
  }
}

function setupStencilForMaterial(mat) {
  // Asegurar que use colores por ambos lados para las paredes de la habitación
  if (mat.side === THREE.FrontSide) mat.side = THREE.DoubleSide; 
  
  mat.stencilWrite = true;
  mat.stencilRef = stencilRef;
  mat.stencilFunc = THREE.EqualStencilFunc;
  mat.stencilFail = THREE.KeepStencilOp;
  mat.stencilZFail = THREE.KeepStencilOp;
  mat.stencilZPass = THREE.KeepStencilOp;
}

export function setInteriorStencil(enabled) {
  if (!portalGroup) return;
  // El interiorContainer es el índice 2
  const interior = portalGroup.children[2]; 
  
  if(interior) {
    interior.traverse((child) => {
      if (child.isMesh) {
        if (Array.isArray(child.material)) {
          child.material.forEach(mat => mat.stencilWrite = enabled);
        } else {
          child.material.stencilWrite = enabled;
        }
      }
    });
  }
  
  portalGroup.children[0].visible = enabled; // marco exterior
  portalGroup.children[1].visible = enabled; // plano stencil
}

// ---- Funciones para construir la geometría ----

function createRoom(roomWidth, roomHeight, roomDepth) {
  const roomGroup = new THREE.Group();
  // Material de las paredes (gris oscuro)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x222222, side: THREE.DoubleSide });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x111111, side: THREE.DoubleSide });

  // El centro de la habitación en Z estará en -roomDepth/2
  const zCenter = -roomDepth / 2;

  // Pared Trasera
  const back = new THREE.Mesh(new THREE.PlaneGeometry(roomWidth, roomHeight), wallMat);
  back.position.set(0, roomHeight/2, -roomDepth);
  roomGroup.add(back);

  // Pared Izquierda
  const left = new THREE.Mesh(new THREE.PlaneGeometry(roomDepth, roomHeight), wallMat);
  left.rotation.y = Math.PI / 2;
  left.position.set(-roomWidth/2, roomHeight/2, zCenter);
  roomGroup.add(left);

  // Pared Derecha
  const right = new THREE.Mesh(new THREE.PlaneGeometry(roomDepth, roomHeight), wallMat);
  right.rotation.y = -Math.PI / 2;
  right.position.set(roomWidth/2, roomHeight/2, zCenter);
  roomGroup.add(right);

  // Techo
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(roomWidth, roomDepth), wallMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, roomHeight, zCenter);
  roomGroup.add(ceiling);

  // Suelo
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(roomWidth, roomDepth), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, zCenter);
  roomGroup.add(floor);

  // Pared Frontal (con el hueco de la puerta)
  // Puerta: Ancho 1.2, Alto 2.0 (centrada en X=0)
  const doorWidth = 1.2;
  const doorHeight = 2.0;

  // Pieza izquierda del frontal
  const frontLeftWidth = (roomWidth - doorWidth) / 2;
  const frontLeft = new THREE.Mesh(new THREE.PlaneGeometry(frontLeftWidth, roomHeight), wallMat);
  frontLeft.position.set(-doorWidth/2 - frontLeftWidth/2, roomHeight/2, 0);
  roomGroup.add(frontLeft);

  // Pieza derecha del frontal
  const frontRightWidth = (roomWidth - doorWidth) / 2;
  const frontRight = new THREE.Mesh(new THREE.PlaneGeometry(frontRightWidth, roomHeight), wallMat);
  frontRight.position.set(doorWidth/2 + frontRightWidth/2, roomHeight/2, 0);
  roomGroup.add(frontRight);

  // Pieza superior del frontal (arriba de la puerta)
  const frontTopHeight = roomHeight - doorHeight;
  if(frontTopHeight > 0) {
    const frontTop = new THREE.Mesh(new THREE.PlaneGeometry(doorWidth, frontTopHeight), wallMat);
    frontTop.position.set(0, doorHeight + frontTopHeight/2, 0);
    roomGroup.add(frontTop);
  }

  return roomGroup;
}

function createDummyFrame() {
  const group = new THREE.Group();
  // Marco físico para la puerta en Z=0
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.2, 0.1), new THREE.MeshStandardMaterial({color:0x333333}));
  left.position.set(-0.65, 1.1, 0);
  const right = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.2, 0.1), new THREE.MeshStandardMaterial({color:0x333333}));
  right.position.set(0.65, 1.1, 0);
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.1), new THREE.MeshStandardMaterial({color:0x333333}));
  top.position.set(0, 2.25, 0);
  group.add(left, right, top);
  return group;
}

function createDummyInterior() {
  const group = new THREE.Group();
  const boxGeom = new THREE.BoxGeometry(1, 1, 1);
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  const boxMesh = new THREE.Mesh(boxGeom, boxMat);
  boxMesh.position.set(0, 0.5, 0);
  group.add(boxMesh);
  return group;
}
