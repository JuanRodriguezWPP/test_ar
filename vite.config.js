import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [
    // basicSsl() // <- Comentado temporalmente para que funcione en Safari local
  ],
  server: {
    host: true, // Permite acceso desde otros dispositivos en la red local
  }
});
