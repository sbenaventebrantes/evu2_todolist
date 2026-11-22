import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class TokenStore {
  private readonly tokenState = signal<string | null>(null);
  readonly token = this.tokenState.asReadonly();

  set(token: string): void {
    this.tokenState.set(token);
  }

  clear(): void {
    this.tokenState.set(null);
  }
}
