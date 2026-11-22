import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.evaluacion1.mistareas',
  appName: 'Mis Tareas',
  webDir: 'www',
  plugins: {
    Camera: {
      cameraUsageDescription: 'La app usa la cámara para adjuntar fotos a tus tareas.',
      photoLibraryUsageDescription: 'La app usa la galería para adjuntar fotos a tus tareas.',
    },
    Geolocation: {
      ios: {
        NSLocationWhenInUseUsageDescription: 'La app usa tu ubicación para registrar dónde se realizó cada tarea.',
        NSLocationAlwaysAndWhenInUseUsageDescription:
          'La app usa tu ubicación para registrar dónde se realizó cada tarea.',
      },
    },
  },
};

export default config;
