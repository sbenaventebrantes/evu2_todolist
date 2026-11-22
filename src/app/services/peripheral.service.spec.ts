import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStorageDouble, storageAsAppStorage } from '../testing/test-doubles';
import { CAMERA_PLUGIN, GEOLOCATION_PLUGIN } from '../tokens/device.tokens';

import { PeripheralService } from './peripheral.service';
import { AppStorage } from './storage.service';

describe('PeripheralService', () => {
  let service: PeripheralService;
  let camera: ReturnType<typeof createCameraDouble>;
  let geolocation: ReturnType<typeof createGeolocationDouble>;
  let storage: ReturnType<typeof createStorageDouble>;

  function createCameraDouble() {
    return {
      checkPermissions: vi.fn(async (): Promise<{ camera: string; photos?: string }> => ({
        camera: 'granted',
        photos: 'granted',
      })),
      requestPermissions: vi.fn(async (_options?: unknown): Promise<{ camera: string; photos?: string }> => ({
        camera: 'granted',
        photos: 'granted',
      })),
      takePhoto: vi.fn(async (_options?: unknown) => ({ thumbnail: 'base64-image', metadata: { format: 'jpeg' } })),
      chooseFromGallery: vi.fn(async (_options?: unknown) => ({
        results: [{ thumbnail: 'gallery-base64', metadata: { format: 'png' } }],
      })),
    };
  }

  function createGeolocationDouble() {
    return {
      checkPermissions: vi.fn(async () => ({ location: 'granted' })),
      requestPermissions: vi.fn(async (_options?: unknown) => ({ location: 'granted' })),
      getCurrentPosition: vi.fn(async (_options?: unknown) => ({
        coords: { latitude: -33.4489, longitude: -70.6693, accuracy: 8 },
        timestamp: 1_760_000_000_000,
      })),
    };
  }

  beforeEach(() => {
    camera = createCameraDouble();
    geolocation = createGeolocationDouble();
    storage = createStorageDouble();

    TestBed.configureTestingModule({
      providers: [
        { provide: CAMERA_PLUGIN, useValue: camera },
        { provide: GEOLOCATION_PLUGIN, useValue: geolocation },
        { provide: AppStorage, useValue: storageAsAppStorage(storage) },
      ],
    });

    service = TestBed.inject(PeripheralService);
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'mediaDevices');
    for (const input of document.body.querySelectorAll('input[type="file"]')) {
      input.remove();
    }
    for (const overlay of document.body.querySelectorAll('.peripheral-webcam-overlay')) {
      overlay.remove();
    }
    vi.restoreAllMocks();
  });

  it('captures and persists a photo when camera permission is granted', async () => {
    const result = await service.capturePhoto();

    expect(result.status).toBe('success');
    expect(storage.savePhoto).toHaveBeenCalledWith('base64-image', 'image/jpeg');
    expect(camera.takePhoto).toHaveBeenCalled();
  });

  describe('when the browser can open a live camera stream', () => {
    function stubCanvas(dataUrl: string): void {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D);
      vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(dataUrl);
    }

    function stubGetUserMedia(stop: () => void) {
      const getUserMedia = vi.fn(async () => ({
        getTracks: () => [{ stop }],
      }));
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia },
      });
      return getUserMedia;
    }

    it('opens a live preview instead of a plain file picker and takes a snapshot', async () => {
      const stop = vi.fn();
      stubGetUserMedia(stop);
      stubCanvas('data:image/jpeg;base64,webcam-photo');

      const pending = service.capturePhoto();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const overlay = document.body.querySelector('.peripheral-webcam-overlay');
      const captureButton = overlay?.querySelector<HTMLButtonElement>('[data-testid="webcam-capture-button"]');

      if (!overlay || !captureButton) {
        throw new Error('Webcam overlay was not created');
      }

      expect(captureButton.disabled).toBe(false);
      expect(document.querySelector('input[type="file"]')).toBeNull();

      captureButton.click();
      const result = await pending;

      expect(result.status).toBe('success');
      expect(storage.savePhoto).toHaveBeenCalledWith('webcam-photo', 'image/jpeg');
      expect(camera.takePhoto).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalled();
      expect(document.body.contains(overlay)).toBe(false);
    });

    it('cancels the live preview without saving a photo', async () => {
      const stop = vi.fn();
      stubGetUserMedia(stop);

      const pending = service.capturePhoto();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const cancelButton = document.body.querySelector<HTMLButtonElement>('[data-testid="webcam-cancel-button"]');

      if (!cancelButton) {
        throw new Error('Webcam overlay was not created');
      }

      cancelButton.click();
      const result = await pending;

      expect(result.status).toBe('cancelled');
      expect(stop).toHaveBeenCalled();
      expect(storage.savePhoto).not.toHaveBeenCalled();
    });

    it('reports a denied camera when getUserMedia is rejected by the user', async () => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error('Denied'), { name: 'NotAllowedError' })),
        },
      });

      const result = await service.capturePhoto();

      expect(result.status).toBe('denied');
      expect(camera.takePhoto).not.toHaveBeenCalled();
    });

    it('reports no camera available when the device has none', async () => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error('None'), { name: 'NotFoundError' })) },
      });

      const result = await service.capturePhoto();

      expect(result.status).toBe('unavailable');
    });
  });

  it('attaches a photo from the gallery without opening the camera', async () => {
    const result = await service.attachPhoto();

    expect(result.status).toBe('success');
    expect(storage.savePhoto).toHaveBeenCalledWith('gallery-base64', 'image/png');
    expect(camera.chooseFromGallery).toHaveBeenCalledWith(expect.objectContaining({ webUseInput: true }));
    expect(camera.takePhoto).not.toHaveBeenCalled();
  });

  it('does not open the gallery when photos permission is denied', async () => {
    vi.mocked(camera.checkPermissions).mockResolvedValueOnce({ camera: 'granted', photos: 'denied' });

    const result = await service.attachPhoto();

    expect(result).toMatchObject({ status: 'denied' });
    expect((result as { message: string }).message).toContain('galería');
    expect(camera.chooseFromGallery).not.toHaveBeenCalled();
  });

  it('does not open the camera when permission is denied', async () => {
    vi.mocked(camera.checkPermissions).mockResolvedValueOnce({ camera: 'denied' });

    const result = await service.capturePhoto();

    expect(result).toMatchObject({ status: 'denied' });
    expect((result as { message: string }).message).toContain('sin foto');
    expect(camera.takePhoto).not.toHaveBeenCalled();
  });

  it('reports a denied camera permission request', async () => {
    vi.mocked(camera.checkPermissions).mockResolvedValueOnce({ camera: 'prompt' });
    vi.mocked(camera.requestPermissions).mockResolvedValueOnce({ camera: 'denied' });

    const result = await service.capturePhoto();

    expect(result.status).toBe('denied');
    expect(camera.takePhoto).not.toHaveBeenCalled();
  });

  it('uses the browser file picker when the camera permission stays pending', async () => {
    vi.mocked(camera.checkPermissions).mockResolvedValueOnce({ camera: 'prompt' });
    vi.mocked(camera.requestPermissions).mockResolvedValueOnce({ camera: 'prompt' });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });

    const pending = service.capturePhoto();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const input = document.body.querySelector<HTMLInputElement>('input[type="file"][capture="environment"]');

    if (!input) {
      throw new Error('File input was not created');
    }

    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['photo'], 'foto.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change'));

    const result = await pending;

    expect(result.status).toBe('success');
    expect(camera.takePhoto).not.toHaveBeenCalled();
    expect(document.body.contains(input)).toBe(false);
  });

  it('explains that camera permission cannot be requested in this browser', async () => {
    vi.mocked(camera.checkPermissions).mockResolvedValueOnce({ camera: 'prompt' });
    vi.mocked(camera.requestPermissions).mockRejectedValueOnce(new Error('not implemented'));

    const result = await service.capturePhoto();

    expect(result.status).toBe('unavailable');
    expect((result as { message: string }).message).toContain('navegador');
  });

  it('treats a cancelled camera capture as a non-blocking result', async () => {
    vi.mocked(camera.takePhoto).mockRejectedValueOnce(
      Object.assign(new Error('User cancelled'), { code: 'OS-PLUG-CAMR-0006' }),
    );

    const result = await service.capturePhoto();

    expect(result.status).toBe('cancelled');
    expect((result as { message: string }).message).toContain('sin foto');
  });

  it('captures coordinates with accuracy and timestamp', async () => {
    const result = await service.captureLocation();

    expect(result).toMatchObject({
      status: 'success',
      location: {
        latitude: -33.4489,
        longitude: -70.6693,
        accuracy: 8,
      },
    });
    expect(geolocation.getCurrentPosition).toHaveBeenCalledWith(expect.objectContaining({ enableHighAccuracy: true }));
  });

  it('does not query GPS when location permission is denied', async () => {
    vi.mocked(geolocation.checkPermissions).mockResolvedValueOnce({ location: 'denied' });

    const result = await service.captureLocation();

    expect(result.status).toBe('denied');
    expect(geolocation.getCurrentPosition).not.toHaveBeenCalled();
  });

  it('reports a denied location permission request', async () => {
    vi.mocked(geolocation.checkPermissions).mockResolvedValueOnce({ location: 'prompt' });
    vi.mocked(geolocation.requestPermissions).mockResolvedValueOnce({ location: 'denied' });

    const result = await service.captureLocation();

    expect(result.status).toBe('denied');
  });

  it('reports when location permission cannot be requested in this browser', async () => {
    vi.mocked(geolocation.checkPermissions).mockResolvedValueOnce({ location: 'prompt' });
    vi.mocked(geolocation.requestPermissions).mockRejectedValueOnce(new Error('not implemented'));

    const result = await service.captureLocation();

    expect(result.status).toBe('unavailable');
  });

  it('distinguishes a disabled GPS from other location errors', async () => {
    vi.mocked(geolocation.getCurrentPosition).mockRejectedValueOnce(
      Object.assign(new Error('Location services disabled'), { code: 2 }),
    );

    const result = await service.captureLocation();

    expect(result.status).toBe('disabled');
    expect((result as { message: string }).message).toContain('GPS');
  });

  it('reports a location timeout in Spanish', async () => {
    vi.mocked(geolocation.getCurrentPosition).mockRejectedValueOnce(Object.assign(new Error('Timeout'), { code: 3 }));

    const result = await service.captureLocation();

    expect(result.status).toBe('unavailable');
    expect((result as { message: string }).message).toContain('tiempo');
  });

  it('uses the requested metadata to save a PNG photo', async () => {
    vi.mocked(camera.takePhoto).mockResolvedValueOnce({ thumbnail: 'png-base64', metadata: { format: 'png' } });

    const result = await service.capturePhoto();

    expect(result.status).toBe('success');
    expect(camera.takePhoto).toHaveBeenCalledWith(expect.objectContaining({ includeMetadata: true }));
    expect(storage.savePhoto).toHaveBeenCalledWith('png-base64', 'image/png');
  });

  it('treats a Capacitor string cancel code as a cancelled capture', async () => {
    vi.mocked(camera.takePhoto).mockRejectedValueOnce('OS-PLUG-CAMR-0006');

    const result = await service.capturePhoto();

    expect(result).toMatchObject({ status: 'cancelled' });
    expect((result as { message: string }).message).toContain('sin foto');
  });

  it('treats a Capacitor string permission code as a denied capture', async () => {
    vi.mocked(camera.takePhoto).mockRejectedValueOnce({ code: 'OS-PLUG-CAMR-0003', message: 'Failure' });

    const result = await service.capturePhoto();

    expect(result.status).toBe('denied');
    expect((result as { message: string }).message).toContain('sin foto');
  });

  it('treats prompt-with-rationale as a denied camera permission', async () => {
    vi.mocked(camera.checkPermissions).mockResolvedValueOnce({ camera: 'prompt-with-rationale' });
    vi.mocked(camera.requestPermissions).mockResolvedValueOnce({ camera: 'prompt-with-rationale' });

    const result = await service.capturePhoto();

    expect(result.status).toBe('denied');
    expect(camera.takePhoto).not.toHaveBeenCalled();
  });

  it('treats prompt-with-rationale as a denied location permission', async () => {
    vi.mocked(geolocation.checkPermissions).mockResolvedValueOnce({ location: 'prompt-with-rationale' });
    vi.mocked(geolocation.requestPermissions).mockResolvedValueOnce({ location: 'prompt-with-rationale' });

    const result = await service.captureLocation();

    expect(result.status).toBe('denied');
    expect(geolocation.getCurrentPosition).not.toHaveBeenCalled();
  });

  it('recognizes the Capacitor disabled-location string code', async () => {
    vi.mocked(geolocation.getCurrentPosition).mockRejectedValueOnce({
      code: 'OS-PLUG-GLOC-0007',
      message: 'Failure',
    });

    const result = await service.captureLocation();

    expect(result.status).toBe('disabled');
    expect((result as { message: string }).message).toContain('GPS');
  });

  it('recognizes the Capacitor location-timeout string code', async () => {
    vi.mocked(geolocation.getCurrentPosition).mockRejectedValueOnce({
      code: 'OS-PLUG-GLOC-0010',
      message: 'Failure',
    });

    const result = await service.captureLocation();

    expect(result.status).toBe('unavailable');
    expect((result as { message: string }).message).toContain('tiempo');
  });

  it('recognizes the Capacitor denied-location string code', async () => {
    vi.mocked(geolocation.getCurrentPosition).mockRejectedValueOnce({
      code: 'OS-PLUG-GLOC-0003',
      message: 'Failure',
    });

    const result = await service.captureLocation();

    expect(result.status).toBe('denied');
    expect((result as { message: string }).message).toContain('sin coordenadas');
  });

  it('recognizes the Capacitor undeclared-permissions string code', async () => {
    vi.mocked(geolocation.getCurrentPosition).mockRejectedValueOnce({
      code: 'OS-PLUG-GLOC-0018',
      message: 'Failure',
    });

    const result = await service.captureLocation();

    expect(result.status).toBe('unavailable');
    expect((result as { message: string }).message).toContain('permisos');
  });

  it('recognizes the Capacitor location-obtainment error string code', async () => {
    vi.mocked(geolocation.getCurrentPosition).mockRejectedValueOnce({
      code: 'OS-PLUG-GLOC-0002',
      message: 'Failure',
    });

    const result = await service.captureLocation();

    expect(result.status).toBe('unavailable');
    expect((result as { message: string }).message).toContain('sin coordenadas');
  });

  it('resolves a cancelled browser file picker and cleans up the input', async () => {
    vi.mocked(camera.checkPermissions).mockRejectedValueOnce(new Error('not implemented'));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });

    const pending = service.capturePhoto();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');

    if (!input) {
      throw new Error('File input was not created');
    }

    input.dispatchEvent(new Event('cancel'));

    const result = await pending;

    expect(result).toMatchObject({ status: 'cancelled' });
    expect(document.body.contains(input)).toBe(false);
  });

  it('resolves a browser file picker error and cleans up the input', async () => {
    vi.mocked(camera.requestPermissions).mockRejectedValueOnce(new Error('not implemented'));
    vi.mocked(camera.checkPermissions).mockResolvedValueOnce({ camera: 'prompt' });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });

    const pending = service.capturePhoto();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');

    if (!input) {
      throw new Error('File input was not created');
    }

    input.dispatchEvent(new Event('error'));

    const result = await pending;

    expect(result.status).toBe('error');
    expect(document.body.contains(input)).toBe(false);
  });
});
