import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../environments/environment';
import { TEST_USER, createStorageDouble, storageAsAppStorage } from '../testing/test-doubles';

import { AuthService } from './auth.service';
import { AppStorage } from './storage.service';
import { TokenStore } from './token.store';

describe('AuthService', () => {
  let service: AuthService;
  let httpMock: HttpTestingController;
  let storage: ReturnType<typeof createStorageDouble>;
  let tokens: TokenStore;

  const session = { token: 'jwt-token', user: TEST_USER };

  beforeEach(() => {
    storage = createStorageDouble();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppStorage, useValue: storageAsAppStorage(storage) },
      ],
    });

    service = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
    tokens = TestBed.inject(TokenStore);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('stores the session and token after a successful login', async () => {
    const login = service.login('ana@ejemplo.test', 'password123');
    const request = httpMock.expectOne(`${environment.apiUrl}/api/auth/login`);

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ email: 'ana@ejemplo.test', password: 'password123' });

    request.flush(session);

    await expect(login).resolves.toEqual(TEST_USER);
    expect(tokens.token()).toBe('jwt-token');
    expect(service.isAuthenticated()).toBe(true);
    expect(storage.values.get('auth:session')).toEqual(session);
  });

  it('restores a persisted session and refreshes the user from the API', async () => {
    storage.values.set('auth:session', session);

    const restored = service.restoreSession();
    await Promise.resolve();
    await Promise.resolve();

    const request = httpMock.expectOne(`${environment.apiUrl}/api/auth/me`);
    request.flush({ ...TEST_USER, name: 'Ana actualizada' });

    await expect(restored).resolves.toMatchObject({ token: 'jwt-token' });
    expect(service.currentUser()?.name).toBe('Ana actualizada');
    expect(tokens.token()).toBe('jwt-token');
    expect(service.sessionReady()).toBe(true);
  });

  it('clears the session and token on logout', async () => {
    const login = service.login(TEST_USER.email, 'password123');
    httpMock.expectOne(`${environment.apiUrl}/api/auth/login`).flush(session);
    await login;

    await service.logout();

    expect(storage.remove).toHaveBeenCalledWith('auth:session');
    expect(tokens.token()).toBeNull();
    expect(service.currentUser()).toBeNull();
  });

  it('shows the server error in Spanish when credentials are invalid', async () => {
    const login = service.login(TEST_USER.email, 'wrong-password');

    httpMock
      .expectOne(`${environment.apiUrl}/api/auth/login`)
      .flush({ error: 'Correo o contraseña incorrectos.' }, { status: 401, statusText: 'Unauthorized' });

    await expect(login).rejects.toThrow('Correo o contraseña incorrectos.');
    expect(service.isAuthenticated()).toBe(false);
  });
});
