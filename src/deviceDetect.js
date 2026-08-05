export async function checkARSupport() {
  if (navigator.xr) {
    try {
      const isSupported = await navigator.xr.isSessionSupported('immersive-ar');
      return isSupported;
    } catch (e) {
      console.warn("Error comprobando soporte AR:", e);
      return false;
    }
  }
  return false;
}
