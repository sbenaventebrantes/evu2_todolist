import { Injectable, inject, signal } from '@angular/core';

import { NETWORK_PLUGIN } from '../tokens/device.tokens';

type StatusListener = (online: boolean) => void;

@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly network = inject(NETWORK_PLUGIN);
  private readonly statusState = signal(true);
  private readonly listeners = new Set<StatusListener>();
  private initialized = false;

  readonly online = this.statusState.asReadonly();

  async initialize(): Promise<boolean> {
    const online = await this.readStatus();
    this.statusState.set(online);

    if (!this.initialized) {
      this.initialized = true;

      try {
        const handle = await this.network.addListener('networkStatusChange', (status) => {
          this.setStatus(status.connected);
        });
        this.networkHandle = handle;
      } catch {
        this.networkHandle = undefined;
      }

      if (typeof window !== 'undefined') {
        window.addEventListener('online', this.handleBrowserOnline);
        window.addEventListener('offline', this.handleBrowserOffline);
      }
    }

    return online;
  }

  async isOnline(): Promise<boolean> {
    return this.readStatus();
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleBrowserOnline);
      window.removeEventListener('offline', this.handleBrowserOffline);
    }

    void this.networkHandle?.remove();
    this.listeners.clear();
    this.initialized = false;
  }

  private networkHandle?: { remove: () => Promise<void> | void };

  private readonly handleBrowserOnline = (): void => this.setStatus(true);
  private readonly handleBrowserOffline = (): void => this.setStatus(false);

  private async readStatus(): Promise<boolean> {
    try {
      return (await this.network.getStatus()).connected;
    } catch {
      return typeof navigator === 'undefined' ? true : navigator.onLine;
    }
  }

  private setStatus(online: boolean): void {
    if (this.statusState() === online) {
      return;
    }

    this.statusState.set(online);

    for (const listener of this.listeners) {
      listener(online);
    }
  }
}
