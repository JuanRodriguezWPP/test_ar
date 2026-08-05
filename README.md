# Portal WebAR

Este proyecto es una experiencia de Realidad Aumentada (WebXR) donde el usuario puede colocar un portal dimensional en el mundo real (usando detección de superficies) y físicamente caminar hacia él para "entrar" a una tienda 3D. 

El proyecto utiliza **Three.js** y **Vanilla JavaScript**, configurado para ser desplegado con dependencias cargadas mediante CDN, usando **Vite** como servidor de desarrollo y *bundler*.

## Estructura del Proyecto

- `index.html`: Punto de entrada con interfaz de usuario y mapas de importación (CDN de Three.js).
- `src/main.js`: Lógica principal de inicio.
- `src/deviceDetect.js`: Detecta si el dispositivo y navegador soportan `immersive-ar`.
- `src/arScene.js`: Maneja la sesión WebXR, Hit-Test (para buscar el piso) y el bucle de renderizado en AR.
- `src/portal.js`: Carga de modelos 3D y configuración del *Stencil Buffer* que crea el efecto visual de "ventana".
- `src/portalCrossing.js`: Lógica matemática para determinar cuándo la cámara física cruza el umbral del portal.
- `src/fallbackOrbit.js`: Escena 3D normal para dispositivos sin AR (como iOS Safari sin soporte nativo o Desktop).

## Instrucciones para Desarrollo Local

Para que WebXR funcione en dispositivos móviles, es un requisito estricto que la página se sirva bajo **HTTPS**.

1. **Instalar dependencias de desarrollo:**
   Asegúrate de tener Node.js instalado. En la raíz de este proyecto ejecuta:
   ```bash
   npm install
   ```

2. **Ejecutar el servidor local:**
   ```bash
   npm run dev
   ```
   *Nota: Vite está configurado con `@vitejs/plugin-basic-ssl` para proveer un certificado HTTPS local falso.*

3. **Probar en tu móvil (Android):**
   Asegúrate de que tu PC y tu teléfono estén en la misma red Wi-Fi.
   Abre la URL proporcionada en la terminal por Vite (algo como `https://192.168.x.x:5173/`) en Chrome para Android. Si Chrome muestra una advertencia de seguridad (por el certificado básico), dale a "Configuración Avanzada -> Continuar de todos modos".
   
   **Alternativa (Recomendada):** Si el paso anterior falla o prefieres un certificado válido, usa [ngrok](https://ngrok.com/):
   ```bash
   ngrok http 5173
   ```
   Y abre la URL `https://xxxx.ngrok.io` en tu móvil.

## Cómo reemplazar los modelos .glb

1. Coloca tus archivos `.glb` reales (`portal_frame.glb` y `interior_scene.glb`) dentro de la carpeta `models/`.
2. Opcionalmente añade `Dia_de_Muertos.glb` y modifícalo en `src/portal.js`.
3. Ajusta las coordenadas y escalas en `src/portal.js` (`stencilMesh.position.set(...)`, `interior.position.set(...)`) según el tamaño real de tus modelos para que coincidan con la ventana del *Stencil*.

## Despliegue en Render.com o Vercel

Dado que usamos Vite, el proceso de despliegue es estándar:

1. Sube tu código a un repositorio en GitHub.
2. En Render / Vercel, crea un nuevo proyecto apuntando a tu repositorio.
3. **Build Command:** `npm run build` o `npx vite build`
4. **Publish/Output Directory:** `dist`

Render y Vercel proveerán certificados HTTPS válidos automáticamente, listos para que los usuarios experimenten el portal.
