import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../services/auth.service';
import { TEST_USER, createAuthDouble } from '../testing/test-doubles';

import { LoginPage } from './login.page';

describe('LoginPage', () => {
  let component: LoginPage;
  let fixture: ComponentFixture<LoginPage>;
  let auth: ReturnType<typeof createAuthDouble>;
  let router: Router;

  beforeEach(async () => {
    auth = createAuthDouble();

    TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });

    fixture = TestBed.createComponent(LoginPage);
    component = fixture.componentInstance;
    router = TestBed.inject(Router);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the login page in login mode', () => {
    expect(component).toBeTruthy();
    expect(component.mode()).toBe('login');
  });

  it('marks invalid fields as touched without calling the API', async () => {
    await component.submit();

    expect(component.isFieldInvalid('email')).toBe(true);
    expect(component.isFieldInvalid('password')).toBe(true);
    expect(auth.login).not.toHaveBeenCalled();
    expect(auth.register).not.toHaveBeenCalled();
  });

  it('logs in with valid credentials and navigates home', async () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    component.authForm.setValue({ email: 'ana@ejemplo.test', password: 'password123', name: '' });

    await component.submit();

    expect(auth.login).toHaveBeenCalledWith('ana@ejemplo.test', 'password123');
    expect(navigate).toHaveBeenCalledWith(['/home']);
    expect(component.loading()).toBe(false);
  });

  it('registers a new user when the mode is switched', async () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    component.toggleMode();
    component.authForm.setValue({ email: 'bruno@ejemplo.test', password: 'password123', name: '  Bruno  ' });

    await component.submit();

    expect(component.mode()).toBe('register');
    expect(auth.register).toHaveBeenCalledWith('bruno@ejemplo.test', 'password123', 'Bruno');
    expect(navigate).toHaveBeenCalledWith(['/home']);
  });

  it('requires a name when registering', async () => {
    component.toggleMode();
    component.authForm.setValue({ email: 'bruno@ejemplo.test', password: 'password123', name: '  ' });

    await component.submit();

    expect(component.errorMessage()).toBe('Ingresa tu nombre para crear la cuenta.');
    expect(auth.register).not.toHaveBeenCalled();
  });

  it('shows the authentication error returned by the service', async () => {
    vi.mocked(auth.login).mockRejectedValueOnce(new Error('Correo o contraseña incorrectos.'));
    component.authForm.setValue({ email: TEST_USER.email, password: 'wrong-password', name: '' });

    await component.submit();

    expect(component.errorMessage()).toBe('Correo o contraseña incorrectos.');
    expect(component.loading()).toBe(false);
  });
});
