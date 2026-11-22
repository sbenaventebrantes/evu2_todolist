import { InjectionToken } from '@angular/core';
import { Camera, type CameraPlugin } from '@capacitor/camera';
import { Filesystem, type FilesystemPlugin } from '@capacitor/filesystem';
import { Geolocation, type GeolocationPlugin } from '@capacitor/geolocation';
import { Network, type NetworkPlugin } from '@capacitor/network';

export const CAMERA_PLUGIN = new InjectionToken<CameraPlugin>('CAMERA_PLUGIN', {
  providedIn: 'root',
  factory: () => Camera,
});

export const GEOLOCATION_PLUGIN = new InjectionToken<GeolocationPlugin>('GEOLOCATION_PLUGIN', {
  providedIn: 'root',
  factory: () => Geolocation,
});

export const NETWORK_PLUGIN = new InjectionToken<NetworkPlugin>('NETWORK_PLUGIN', {
  providedIn: 'root',
  factory: () => Network,
});

export const FILESYSTEM_PLUGIN = new InjectionToken<FilesystemPlugin>('FILESYSTEM_PLUGIN', {
  providedIn: 'root',
  factory: () => Filesystem,
});
