/**
 * DeviceOrientationControls
 * Usa el giroscopio del dispositivo para orientar la cámara.
 * Adaptado de Three.js examples para uso standalone.
 */
import * as THREE from 'three';

const _zee = new THREE.Vector3(0, 0, 1);
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _changeEvent = { type: 'change' };

class DeviceOrientationControls extends THREE.EventDispatcher {
  constructor(object) {
    super();

    if (window.isSecureContext === false) {
      console.error('DeviceOrientationControls: DeviceOrientationEvent is only available in secure contexts (https)');
      return;
    }

    this.object = object;
    this.object.rotation.reorder('YXZ');

    this.enabled = true;
    this.deviceOrientation = {};
    this.screenOrientation = 0;
    this.alphaOffset = 0; // offset manual en radianes

    const onDeviceOrientationChangeEvent = (event) => {
      this.deviceOrientation = event;
    };

    const onScreenOrientationChangeEvent = () => {
      this.screenOrientation = window.orientation || 0;
    };

    // iOS 13+ requiere permiso explícito
    const requestPermission = DeviceOrientationEvent.requestPermission;
    if (typeof requestPermission === 'function') {
      requestPermission()
        .then((response) => {
          if (response === 'granted') {
            window.addEventListener('orientationchange', onScreenOrientationChangeEvent);
            window.addEventListener('deviceorientation', onDeviceOrientationChangeEvent);
          }
        })
        .catch(console.error);
    } else {
      window.addEventListener('orientationchange', onScreenOrientationChangeEvent);
      window.addEventListener('deviceorientation', onDeviceOrientationChangeEvent);
    }

    onScreenOrientationChangeEvent();

    this.connect = () => {
      window.addEventListener('orientationchange', onScreenOrientationChangeEvent);
      window.addEventListener('deviceorientation', onDeviceOrientationChangeEvent);
    };

    this.disconnect = () => {
      window.removeEventListener('orientationchange', onScreenOrientationChangeEvent);
      window.removeEventListener('deviceorientation', onDeviceOrientationChangeEvent);
    };

    this.update = () => {
      if (!this.enabled) return;

      const device = this.deviceOrientation;
      if (!device || !device.alpha) return;

      const alpha = device.alpha ? THREE.MathUtils.degToRad(device.alpha) + this.alphaOffset : 0;
      const beta = device.beta ? THREE.MathUtils.degToRad(device.beta) : 0;
      const gamma = device.gamma ? THREE.MathUtils.degToRad(device.gamma) : 0;
      const orient = this.screenOrientation ? THREE.MathUtils.degToRad(this.screenOrientation) : 0;

      _euler.set(beta, alpha, -gamma, 'YXZ');
      this.object.quaternion.setFromEuler(_euler);
      this.object.quaternion.multiply(_q1);
      this.object.quaternion.multiply(_q0.setFromAxisAngle(_zee, -orient));

      this.dispatchEvent(_changeEvent);
    };

    this.dispose = () => {
      this.disconnect();
    };
  }
}

export { DeviceOrientationControls };
