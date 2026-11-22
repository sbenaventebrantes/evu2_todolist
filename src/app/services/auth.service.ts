import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';
import type { AuthResponse, AuthSession, AuthUser } from '../models/auth.model';
import { describeError } from '../utils/task.utils';

import { AppStorage } from './storage.service';
import { TokenStore } from './token.store';

const SESSION_KEY = 'auth:session';

function serverMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const response = (error as { error?: { error?: string; message?: string } }).error;
  return response?.error || response?.message || null;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly storage = inject(AppStorage);
  private readonly tokenStore = inject(TokenStore);
  private readonly sessionState = signal<AuthSession | null>(null);
  private readonly readyState = signal(false);
  private restorePromise: Promise<AuthSession | null> | null = null;

  readonly currentUser = computed(() => this.sessionState()?.user ?? null);
  readonly isAuthenticated = computed(() => this.sessionState() !== null);
  readonly sessionReady = this.readyState.asReadonly();

  restoreSession(): Promise<AuthSession | null> {
    if (!this.restorePromise) {
      this.restorePromise = this.restore();
    }

    return this.restorePromise;
  }

  async login(email: string, password: string): Promise<AuthUser> {
    return this.authenticate('login', { email, password });
  }

  async register(email: string, password: string, name: string): Promise<AuthUser> {
    return this.authenticate('register', { email, password, name });
  }

  async logout(): Promise<void> {
    await this.storage.remove(SESSION_KEY);
    this.sessionState.set(null);
    this.tokenStore.clear();
  }

  private async authenticate(endpoint: 'login' | 'register', body: unknown): Promise<AuthUser> {
    try {
      const response = await firstValueFrom(
        this.http.post<AuthResponse>(`${environment.apiUrl}/api/auth/${endpoint}`, body),
      );
      await this.storage.set(SESSION_KEY, response);
      this.applySession(response);
      return response.user;
    } catch (error) {
      throw new Error(serverMessage(error) ?? describeError(error), { cause: error });
    }
  }

  private async restore(): Promise<AuthSession | null> {
    const session = await this.storage.get<AuthSession>(SESSION_KEY);

    if (!session?.token || !session.user) {
      this.readyState.set(true);
      return null;
    }

    this.applySession(session);

    try {
      const user = await firstValueFrom(this.http.get<AuthUser>(`${environment.apiUrl}/api/auth/me`));
      this.applySession({ ...session, user });
    } catch (error) {
      const status = (error as { status?: number }).status;

      if (status === 401) {
        await this.logout();
      }
    }

    this.readyState.set(true);
    return this.sessionState();
  }

  private applySession(session: AuthSession): void {
    this.sessionState.set(session);
    this.tokenStore.set(session.token);
  }
}
