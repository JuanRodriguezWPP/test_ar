import * as THREE from 'three';
import { setInteriorStencil } from './portal.js';

let isUserInside = false;

const cameraPosition = new THREE.Vector3();
const portalPosition = new THREE.Vector3();
const portalForward = new THREE.Vector3();
const cameraToPortal = new THREE.Vector3();

export function checkPortalCrossing(camera, portalGroup, updateInstructions, threshold = 0.5) {
  if (!portalGroup) return;

  camera.getWorldPosition(cameraPosition);
  portalGroup.getWorldPosition(portalPosition);
  
  // Asumimos que el portal mira hacia +Z localmente, y el interior se extiende hacia -Z.
  portalGroup.getWorldDirection(portalForward);
  
  cameraToPortal.subVectors(cameraPosition, portalPosition);
  
  // Proyección de la posición de la cámara sobre el eje perpendicular al portal
  // Positivo significa que estamos delante del portal, negativo que estamos detrás (dentro).
  const zDistance = cameraToPortal.dot(portalForward);
  
  // Distancia euclidiana total
  const distance = cameraPosition.distanceTo(portalPosition);
  
  // Condiciones de entrada:
  // 1. Haber cruzado hacia el lado negativo de Z relativo al portal.
  // 2. Estar suficientemente cerca (evitar teletransportes si nos movemos por los lados a lo lejos).
  const currentlyInside = (zDistance < 0) && (distance < threshold * 2.5);

  if (currentlyInside && !isUserInside) {
    isUserInside = true;
    onEnterPortal(updateInstructions);
  } else if (!currentlyInside && isUserInside) {
    isUserInside = false;
    onExitPortal(updateInstructions);
  } else if (!isUserInside && distance < 2.0 && zDistance > 0) {
    updateInstructions("Camina hacia el portal para entrar");
  } else if (!isUserInside && distance >= 2.0) {
    updateInstructions("Acércate al portal");
  }
}

function onEnterPortal(updateInstructions) {
  setInteriorStencil(false);
  updateInstructions("Estás dentro. Retrocede para salir.");
}

function onExitPortal(updateInstructions) {
  setInteriorStencil(true);
  updateInstructions("Camina hacia el portal para entrar");
}
