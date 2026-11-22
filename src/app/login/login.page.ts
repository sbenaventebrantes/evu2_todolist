import { Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import { leafOutline } from 'ionicons/icons';

import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-login',
  templateUrl: 'login.page.html',
  styleUrls: ['login.page.scss'],
  imports: [
    ReactiveFormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonCard,
    IonCardContent,
    IonInput,
    IonButton,
    IonIcon,
  ],
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly formBuilder = inject(NonNullableFormBuilder);

  readonly mode = signal<'login' | 'register'>('login');
  readonly errorMessage = signal<string | null>(null);
  readonly loading = signal(false);

  readonly authForm = this.formBuilder.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
    name: [''],
  });

  constructor() {
    addIcons({ leafOutline });
  }

  isFieldInvalid(field: 'email' | 'password'): boolean {
    const control = this.authForm.controls[field];
    return control.invalid && control.touched;
  }

  toggleMode(): void {
    this.mode.update((mode) => (mode === 'login' ? 'register' : 'login'));
    this.errorMessage.set(null);
    this.authForm.reset();
  }

  async submit(): Promise<void> {
    if (this.authForm.invalid) {
      this.authForm.markAllAsTouched();
      return;
    }

    const { email, password, name } = this.authForm.getRawValue();

    if (this.mode() === 'register' && !name.trim()) {
      this.errorMessage.set('Ingresa tu nombre para crear la cuenta.');
      return;
    }

    this.loading.set(true);
    this.errorMessage.set(null);

    try {
      if (this.mode() === 'register') {
        await this.auth.register(email.trim(), password, name.trim());
      } else {
        await this.auth.login(email.trim(), password);
      }

      await this.router.navigate(['/home']);
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'No se pudo completar la acción.');
    } finally {
      this.loading.set(false);
    }
  }
}
