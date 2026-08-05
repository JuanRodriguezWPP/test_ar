import { checkARSupport } from './deviceDetect.js';

const startBtn = document.getElementById('start-btn');
const overlayText = document.getElementById('overlay-text');
const overlay = document.getElementById('overlay');
const loader = document.getElementById('loader');
const uiContainer = document.getElementById('ui-container');
const instructions = document.getElementById('instructions');

let isARSupported = false;

async function init() {
  isARSupported = await checkARSupport();
  
  if (isARSupported) {
    overlayText.textContent = "Tu dispositivo soporta AR. Toca para comenzar.";
  } else {
    overlayText.textContent = "Tu dispositivo no soporta AR completo. Explora el portal en 3D con tus dedos.";
  }
  
  startBtn.style.display = 'block';
  startBtn.addEventListener('click', startExperience);
}

async function startExperience() {
  startBtn.style.display = 'none';
  overlayText.textContent = 'Cargando experiencia...';
  loader.style.display = 'flex';

  try {
    if (isARSupported) {
      // Ocultar overlay, arScene.js crea su propio botón "INICIAR CÁMARA AR"
      overlay.style.display = 'none';
      const { initARScene } = await import('./arScene.js');
      await initARScene(onLoadComplete, onProgress, setInstructions);
    } else {
      const { initFallbackScene } = await import('./fallbackOrbit.js');
      await initFallbackScene(onLoadComplete, onProgress, setInstructions);
    }
  } catch (error) {
    console.error('Error al cargar la experiencia:', error);
    overlayText.textContent = 'Hubo un error al cargar los modelos.';
    loader.style.display = 'none';
  }
}

function onProgress(percent) {
  const loaderText = document.getElementById('loader-text');
  if(loaderText) {
    loaderText.textContent = `Cargando modelos... ${Math.round(percent)}%`;
  }
}

function onLoadComplete() {
  // Ocultar overlay inicial
  overlay.style.display = 'none';
  // Mostrar contenedor de UI (Instrucciones)
  uiContainer.style.pointerEvents = 'none'; 
  instructions.style.display = 'inline-block';
}

export function setInstructions(text) {
  if(instructions.textContent !== text) {
    instructions.textContent = text;
  }
}

init();
