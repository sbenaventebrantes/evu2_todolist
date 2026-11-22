import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';

import type { TaskLocation, TaskPhoto } from '../models/task.model';
import { CAMERA_PLUGIN, GEOLOCATION_PLUGIN } from '../tokens/device.tokens';

import { AppStorage } from './storage.service';

export type PhotoCaptureResult =
  | { status: 'success'; photo: TaskPhoto }
  | { status: 'cancelled'; message: string }
  | { status: 'denied' | 'unavailable' | 'error'; message: string };

export type LocationCaptureResult =
  | { status: 'success'; location: TaskLocation }
  | { status: 'denied' | 'disabled' | 'unavailable' | 'error'; message: string };

const DENIED_CAMERA_CODES = new Set(['OS-PLUG-CAMR-0003', 'OS-PLUG-CAMR-0005']);
const CANCELLED_CAMERA_CODES = new Set(['OS-PLUG-CAMR-0006', 'OS-PLUG-CAMR-0013', 'OS-PLUG-CAMR-0020']);
const UNAVAILABLE_CAMERA_CODES = new Set(['OS-PLUG-CAMR-0007']);
const UNDECLARED_LOCATION_CODES = new Set(['OS-PLUG-GLOC-0018']);
const DENIED_LOCATION_CODES = new Set(['OS-PLUG-GLOC-0003']);
const DISABLED_LOCATION_CODES = new Set(['OS-PLUG-GLOC-0007']);
const TIMEOUT_LOCATION_CODES = new Set(['OS-PLUG-GLOC-0010']);
const FAILED_LOCATION_CODES = new Set(['OS-PLUG-GLOC-0002']);

function errorCode(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  return typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
}

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error && 'message' in error
    ? String((error as { message: unknown }).message)
    : '';
}

function isGranted(value: unknown): boolean {
  return value === 'granted';
}

function isPhotoGranted(permission: 'camera' | 'photos', value: unknown): boolean {
  return value === 'granted' || (permission === 'photos' && value === 'limited');
}

function mimeTypeFor(format: string | undefined): string {
  if (format?.toLowerCase().includes('png')) {
    return 'image/png';
  }

  return 'image/jpeg';
}

function browserCameraAvailable(): boolean {
  return typeof document !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices;
}

// Stricter than browserCameraAvailable(): only true when getUserMedia can actually
// open a live video stream, which is what lets "Tomar foto" open the real camera
// instead of falling back to a plain file picker (the same experience as "Adjuntar foto").
function browserCameraStreamAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

function browserLocationAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.geolocation;
}

function cancelledPhotoResult(): PhotoCaptureResult {
  return { status: 'cancelled', message: 'Captura cancelada. Puedes guardar la tarea sin foto.' };
}

function deniedPhotoResult(): PhotoCaptureResult {
  return { status: 'denied', message: 'Permiso de cámara denegado. Puedes guardar la tarea sin foto.' };
}

function deniedGalleryResult(): PhotoCaptureResult {
  return { status: 'denied', message: 'Permiso de galería denegado. Puedes guardar la tarea sin foto.' };
}

function unavailablePermissionPhotoResult(): PhotoCaptureResult {
  return { status: 'unavailable', message: 'No se pudo solicitar el permiso de cámara en este navegador.' };
}

function unavailableCameraResult(): PhotoCaptureResult {
  return { status: 'unavailable', message: 'No hay cámara disponible en este dispositivo.' };
}

function invalidPhotoResult(): PhotoCaptureResult {
  return { status: 'error', message: 'La cámara no devolvió una imagen válida.' };
}

function unreadablePhotoResult(): PhotoCaptureResult {
  return { status: 'error', message: 'No se pudo leer la foto. Puedes guardar la tarea sin ella.' };
}

function genericPhotoResult(): PhotoCaptureResult {
  return { status: 'error', message: 'No se pudo capturar la foto. Puedes guardar la tarea sin ella.' };
}

function classifyWebcamError(error: unknown): PhotoCaptureResult | null {
  const name = typeof error === 'object' && error && 'name' in error ? String((error as { name: unknown }).name) : '';

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return deniedPhotoResult();
  }

  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return unavailableCameraResult();
  }

  return null;
}

function deniedLocationResult(): LocationCaptureResult {
  return { status: 'denied', message: 'Permiso de ubicación denegado. Puedes guardar la tarea sin coordenadas.' };
}

function disabledLocationResult(): LocationCaptureResult {
  return { status: 'disabled', message: 'El GPS está deshabilitado o no hay señal disponible.' };
}

function unavailablePermissionLocationResult(): LocationCaptureResult {
  return { status: 'unavailable', message: 'No se pudo solicitar el permiso de ubicación en este navegador.' };
}

function unavailableLocationResult(): LocationCaptureResult {
  return {
    status: 'unavailable',
    message: 'No se pudo obtener la ubicación. Puedes guardar la tarea sin coordenadas.',
  };
}

function timeoutLocationResult(): LocationCaptureResult {
  return { status: 'unavailable', message: 'No se pudo obtener la ubicación a tiempo. Puedes guardar sin ella.' };
}

function undeclaredLocationResult(): LocationCaptureResult {
  return {
    status: 'unavailable',
    message: 'La app no tiene declarados los permisos de ubicación. Puedes guardar la tarea sin coordenadas.',
  };
}

function genericLocationResult(): LocationCaptureResult {
  return { status: 'error', message: 'No se pudo obtener la ubicación. Puedes guardar la tarea sin coordenadas.' };
}

@Injectable({ providedIn: 'root' })
export class PeripheralService {
  private readonly camera = inject(CAMERA_PLUGIN);
  private readonly geolocation = inject(GEOLOCATION_PLUGIN);
  private readonly storage = inject(AppStorage);

  async capturePhoto(): Promise<PhotoCaptureResult> {
    // On the web, Capacitor's Camera.takePhoto({ webUseInput: true }) only ever opens a
    // plain file picker — it never grants access to a live camera stream, so "Tomar foto"
    // and "Adjuntar foto" ended up being the exact same picker. Opening getUserMedia
    // directly gives "Tomar foto" a real camera preview, matching native platforms where
    // the Camera plugin does launch the OS camera.
    if (!Capacitor.isNativePlatform() && browserCameraStreamAvailable()) {
      return this.capturePhotoFromWebcam();
    }

    const permissionResult = await this.ensurePhotoPermission('camera', () => this.capturePhotoFromBrowser(true));

    if (permissionResult) {
      return permissionResult;
    }

    try {
      const media = await this.camera.takePhoto({
        quality: 60,
        saveToGallery: false,
        webUseInput: true,
        editable: 'no',
        includeMetadata: true,
      });

      return await this.toPhotoResult(media.thumbnail, media.metadata?.format);
    } catch (error) {
      return this.classifyCameraError(error) ?? genericPhotoResult();
    }
  }

  async attachPhoto(): Promise<PhotoCaptureResult> {
    const permissionResult = await this.ensurePhotoPermission('photos', () => this.capturePhotoFromBrowser(false));

    if (permissionResult) {
      return permissionResult;
    }

    try {
      const gallery = await this.camera.chooseFromGallery({
        allowMultipleSelection: false,
        webUseInput: true,
        includeMetadata: true,
        quality: 60,
        editable: 'no',
      });
      const selected = gallery.results[0];

      return await this.toPhotoResult(selected?.thumbnail, selected?.metadata?.format);
    } catch (error) {
      return this.classifyCameraError(error) ?? genericPhotoResult();
    }
  }

  async captureLocation(): Promise<LocationCaptureResult> {
    if (!Capacitor.isNativePlatform() && browserLocationAvailable()) {
      return this.captureLocationFromBrowser();
    }

    const permissionResult = await this.ensureLocationPermission(() => this.captureLocationFromBrowser());

    if (permissionResult) {
      return permissionResult;
    }

    try {
      const position = await this.geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 10_000,
        maximumAge: 0,
      });

      return {
        status: 'success',
        location: {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy ?? null,
          capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
        },
      };
    } catch (error) {
      return this.classifyLocationError(error) ?? genericLocationResult();
    }
  }

  async readPhoto(photo: TaskPhoto): Promise<string> {
    return this.storage.readPhoto(photo);
  }

  async removePhoto(photo: TaskPhoto): Promise<void> {
    await this.storage.deletePhoto(photo);
  }

  private async ensurePhotoPermission(
    permission: 'camera' | 'photos',
    fallback: () => Promise<PhotoCaptureResult>,
  ): Promise<PhotoCaptureResult | null> {
    const deniedResult = permission === 'camera' ? deniedPhotoResult : deniedGalleryResult;

    try {
      const permissions = await this.camera.checkPermissions();
      const current = permissions[permission];

      if (isPhotoGranted(permission, current)) {
        return null;
      }

      if (current === 'denied') {
        return deniedResult();
      }

      try {
        const requested = await this.camera.requestPermissions({ permissions: [permission] });
        const next = requested[permission];

        if (isPhotoGranted(permission, next)) {
          return null;
        }

        if (next === 'prompt' && browserCameraAvailable()) {
          return fallback();
        }

        return deniedResult();
      } catch (error) {
        const known = this.classifyCameraError(error);

        if (known) {
          return known;
        }

        if (browserCameraAvailable()) {
          return fallback();
        }

        return unavailablePermissionPhotoResult();
      }
    } catch (error) {
      const known = this.classifyCameraError(error);

      if (known) {
        return known;
      }

      if (browserCameraAvailable()) {
        return fallback();
      }

      return unavailablePermissionPhotoResult();
    }
  }

  private async toPhotoResult(thumbnail: string | undefined, format: string | undefined): Promise<PhotoCaptureResult> {
    if (!thumbnail) {
      return invalidPhotoResult();
    }

    const photo = await this.storage.savePhoto(thumbnail, mimeTypeFor(format));
    return { status: 'success', photo };
  }

  private async ensureLocationPermission(
    fallback: () => Promise<LocationCaptureResult>,
  ): Promise<LocationCaptureResult | null> {
    try {
      const permissions = await this.geolocation.checkPermissions();

      if (isGranted(permissions.location)) {
        return null;
      }

      if (permissions.location === 'denied') {
        return deniedLocationResult();
      }

      try {
        const requested = await this.geolocation.requestPermissions({ permissions: ['location'] });

        if (isGranted(requested.location)) {
          return null;
        }

        return deniedLocationResult();
      } catch (error) {
        const known = this.classifyLocationError(error);

        if (known) {
          return known;
        }

        if (browserLocationAvailable()) {
          return fallback();
        }

        return unavailablePermissionLocationResult();
      }
    } catch (error) {
      const known = this.classifyLocationError(error);

      if (known) {
        return known;
      }

      if (browserLocationAvailable()) {
        return fallback();
      }

      return unavailablePermissionLocationResult();
    }
  }

  private classifyCameraError(error: unknown): PhotoCaptureResult | null {
    const code = errorCode(error);
    const message = errorMessage(error).toLowerCase();

    if (CANCELLED_CAMERA_CODES.has(code) || message.includes('cancel')) {
      return cancelledPhotoResult();
    }

    if (DENIED_CAMERA_CODES.has(code) || message.includes('permission') || message.includes('denied')) {
      return deniedPhotoResult();
    }

    if (UNAVAILABLE_CAMERA_CODES.has(code) || message.includes('not available') || message.includes('unavailable')) {
      return unavailableCameraResult();
    }

    return null;
  }

  private classifyLocationError(error: unknown): LocationCaptureResult | null {
    const rawCode = errorCode(error);
    const numericCode = Number(rawCode);
    const message = errorMessage(error).toLowerCase();

    if (UNDECLARED_LOCATION_CODES.has(rawCode)) {
      return undeclaredLocationResult();
    }

    if (DENIED_LOCATION_CODES.has(rawCode) || numericCode === 1 || message.includes('denied')) {
      return deniedLocationResult();
    }

    if (
      DISABLED_LOCATION_CODES.has(rawCode) ||
      numericCode === 2 ||
      message.includes('disabled') ||
      message.includes('not enabled')
    ) {
      return disabledLocationResult();
    }

    if (TIMEOUT_LOCATION_CODES.has(rawCode) || numericCode === 3 || message.includes('timeout')) {
      return timeoutLocationResult();
    }

    if (FAILED_LOCATION_CODES.has(rawCode) || message.includes('unavailable')) {
      return unavailableLocationResult();
    }

    if (message.includes('permission')) {
      return deniedLocationResult();
    }

    return null;
  }

  private capturePhotoFromWebcam(): Promise<PhotoCaptureResult> {
    return new Promise((resolve) => {
      let settled = false;
      let stream: MediaStream | null = null;

      const overlay = document.createElement('div');
      overlay.className = 'peripheral-webcam-overlay';

      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;

      const captureButton = document.createElement('button');
      captureButton.type = 'button';
      captureButton.textContent = 'Tomar foto';
      captureButton.disabled = true;
      captureButton.setAttribute('data-testid', 'webcam-capture-button');

      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.textContent = 'Cancelar';
      cancelButton.setAttribute('data-testid', 'webcam-cancel-button');

      const finish = (result: PhotoCaptureResult) => {
        if (settled) {
          return;
        }

        settled = true;

        for (const track of stream?.getTracks() ?? []) {
          track.stop();
        }

        overlay.remove();
        resolve(result);
      };

      cancelButton.onclick = () => finish(cancelledPhotoResult());

      captureButton.onclick = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const context = canvas.getContext('2d');

        if (!context) {
          finish(genericPhotoResult());
          return;
        }

        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const separator = dataUrl.indexOf(',');

        if (separator === -1) {
          finish(unreadablePhotoResult());
          return;
        }

        try {
          const photo = await this.storage.savePhoto(dataUrl.slice(separator + 1), 'image/jpeg');
          finish({ status: 'success', photo });
        } catch {
          finish(unreadablePhotoResult());
        }
      };

      overlay.append(video, captureButton, cancelButton);
      document.body.append(overlay);

      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        .then((mediaStream) => {
          if (settled) {
            for (const track of mediaStream.getTracks()) {
              track.stop();
            }

            return;
          }

          stream = mediaStream;
          video.srcObject = mediaStream;
          captureButton.disabled = false;

          // HTMLMediaElement.play() is expected to return a Promise, but not every
          // environment implements that (older WebViews, some test runners), so only
          // attach a rejection handler when it actually does.
          const playResult = video.play() as unknown;

          if (playResult && typeof (playResult as Promise<void>).then === 'function') {
            void (playResult as Promise<void>).catch(() => undefined);
          }
        })
        .catch((error: unknown) => {
          finish(classifyWebcamError(error) ?? unavailableCameraResult());
        });
    });
  }

  private capturePhotoFromBrowser(useCamera: boolean): Promise<PhotoCaptureResult> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';

      if (useCamera) {
        input.setAttribute('capture', 'environment');
      }

      let settled = false;
      const finish = (result: PhotoCaptureResult) => {
        if (settled) {
          return;
        }

        settled = true;
        input.onchange = null;
        input.oncancel = null;
        input.onerror = null;
        input.remove();
        resolve(result);
      };

      input.onchange = () => {
        const file = input.files?.[0];

        if (!file) {
          finish(cancelledPhotoResult());
          return;
        }

        const reader = new FileReader();
        reader.onload = async () => {
          const value = typeof reader.result === 'string' ? reader.result : '';
          const separator = value.indexOf(',');

          if (separator === -1) {
            finish(unreadablePhotoResult());
            return;
          }

          try {
            const photo = await this.storage.savePhoto(value.slice(separator + 1), file.type || 'image/jpeg');
            finish({ status: 'success', photo });
          } catch {
            finish(unreadablePhotoResult());
          }
        };
        reader.onerror = () => finish(unreadablePhotoResult());
        reader.readAsDataURL(file);
      };
      input.oncancel = () => finish(cancelledPhotoResult());
      input.onerror = () => finish(unreadablePhotoResult());

      document.body.appendChild(input);
      input.click();
    });
  }

  private captureLocationFromBrowser(): Promise<LocationCaptureResult> {
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) =>
          resolve({
            status: 'success',
            location: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy ?? null,
              capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
            },
          }),
        (error) => resolve(this.classifyLocationError(error) ?? genericLocationResult()),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
      );
    });
  }
}
