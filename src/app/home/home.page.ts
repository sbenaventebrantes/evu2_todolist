import { Component, DestroyRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import {
  AlertController,
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  addOutline,
  cameraOutline,
  checkmarkCircleOutline,
  clipboardOutline,
  closeOutline,
  createOutline,
  downloadOutline,
  leafOutline,
  locationOutline,
  logOutOutline,
  syncOutline,
  trashOutline,
  warningOutline,
} from 'ionicons/icons';

import type { Task, TaskLocation, TaskPhoto } from '../models/task.model';
import { AuthService } from '../services/auth.service';
import { PeripheralService, type PhotoCaptureResult } from '../services/peripheral.service';
import { TaskService } from '../services/task.service';
import { formatCoordinates } from '../utils/task.utils';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [
    ReactiveFormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBadge,
    IonContent,
    IonCard,
    IonCardContent,
    IonInput,
    IonTextarea,
    IonButton,
    IonIcon,
    IonList,
    IonItem,
    IonLabel,
  ],
})
export class HomePage {
  private readonly taskService = inject(TaskService);
  private readonly auth = inject(AuthService);
  private readonly peripherals = inject(PeripheralService);
  private readonly router = inject(Router);
  private readonly formBuilder = inject(NonNullableFormBuilder);
  private readonly alertController = inject(AlertController);
  private readonly destroyRef = inject(DestroyRef);
  private readonly content = viewChild(IonContent);

  readonly tasks = this.taskService.tasks;
  readonly syncStatus = this.taskService.syncStatus;
  readonly syncError = this.taskService.syncError;
  readonly conflictMessage = this.taskService.conflictMessage;
  readonly pendingCount = this.taskService.pendingCount;
  readonly online = this.taskService.online;
  readonly lastSyncAt = this.taskService.lastSyncAt;
  readonly currentUser = this.auth.currentUser;
  readonly editingTaskId = signal<string | null>(null);
  readonly draftPhoto = signal<TaskPhoto | null>(null);
  readonly draftPhotoUrl = signal<string | null>(null);
  readonly draftLocation = signal<TaskLocation | null>(null);
  readonly locating = signal(false);
  readonly photoPendingReason = signal<string | null>(null);
  readonly locationPendingReason = signal<string | null>(null);
  readonly photoUrls = signal<Record<string, string>>({});
  readonly importing = signal(false);
  readonly isBusy = computed(() => this.syncStatus() === 'syncing' || this.importing());
  readonly statusMessage = signal<string | null>(null);

  private statusTimer?: ReturnType<typeof setTimeout>;

  readonly taskForm = this.formBuilder.group({
    title: ['', [Validators.required, Validators.pattern(/\S/)]],
    description: ['', [Validators.required, Validators.pattern(/\S/)]],
  });

  constructor() {
    addIcons({
      addOutline,
      cameraOutline,
      checkmarkCircleOutline,
      clipboardOutline,
      closeOutline,
      createOutline,
      downloadOutline,
      leafOutline,
      locationOutline,
      logOutOutline,
      syncOutline,
      trashOutline,
      warningOutline,
    });

    effect(() => {
      const currentTasks = this.tasks();
      const urls = this.photoUrls();

      for (const task of currentTasks) {
        if (task.photo && !urls[task.id]) {
          void this.peripherals
            .readPhoto(task.photo)
            .then((url) => this.photoUrls.update((values) => ({ ...values, [task.id]: url })))
            .catch(() => undefined);
        }
      }
    });

    this.destroyRef.onDestroy(() => {
      if (this.statusTimer) {
        clearTimeout(this.statusTimer);
      }
    });
  }

  isFieldInvalid(field: 'title' | 'description'): boolean {
    const control = this.taskForm.controls[field];
    return control.invalid && control.touched;
  }

  photoSource(task: Task): string {
    return this.photoUrls()[task.id] ?? '';
  }

  coordinates(task: Task): string {
    return task.location ? formatCoordinates(task.location) : '';
  }

  draftCoordinates(): string {
    const location = this.draftLocation();
    return location ? formatCoordinates(location) : '';
  }

  async saveTask(): Promise<void> {
    if (this.locating()) {
      return;
    }

    if (this.taskForm.invalid) {
      this.taskForm.markAllAsTouched();
      return;
    }

    const { title, description } = this.taskForm.getRawValue();
    const editingId = this.editingTaskId();
    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    const photo = this.draftPhoto();
    const location = this.draftLocation();
    const previousPhoto = editingId ? (this.tasks().find((task) => task.id === editingId)?.photo ?? null) : null;

    try {
      if (editingId) {
        await this.taskService.updateTask(editingId, trimmedTitle, trimmedDescription, { photo, location });

        if (previousPhoto && previousPhoto.path !== photo?.path) {
          this.cleanupUnusedPhoto(previousPhoto, editingId);
        }
      } else {
        await this.taskService.addTask({
          title: trimmedTitle,
          description: trimmedDescription,
          photo: photo ?? undefined,
          location: location ?? undefined,
        });
      }

      this.showStatus(this.buildSaveMessage(editingId, photo, location));
      this.resetForm();
    } catch (error) {
      this.showStatus(error instanceof Error ? error.message : 'No se pudo guardar la tarea.');
    }
  }

  async capturePhoto(): Promise<void> {
    await this.applyPhotoResult(await this.peripherals.capturePhoto(), 'Foto tomada. Se guardará junto con la tarea.');
  }

  async attachPhoto(): Promise<void> {
    await this.applyPhotoResult(
      await this.peripherals.attachPhoto(),
      'Foto adjuntada. Se guardará junto con la tarea.',
    );
  }

  removeDraftPhoto(): void {
    if (!this.draftPhoto()) {
      return;
    }

    this.draftPhoto.set(null);
    this.draftPhotoUrl.set(null);
    this.photoPendingReason.set(null);
    this.showStatus('Foto quitada. Puedes guardar la tarea sin foto.');
  }

  async captureLocation(): Promise<void> {
    if (this.locating()) {
      return;
    }

    this.locating.set(true);
    try {
      const result = await this.peripherals.captureLocation();

      if (result.status === 'success') {
        this.draftLocation.set(result.location);
        this.locationPendingReason.set(null);
        this.showStatus('Ubicación registrada. Se guardará junto con la tarea.');
        return;
      }

      this.locationPendingReason.set(result.message);
      this.showStatus(result.message);
    } finally {
      this.locating.set(false);
    }
  }

  startEdit(task: Task): void {
    this.editingTaskId.set(task.id);
    this.taskForm.setValue({
      title: task.title,
      description: task.description,
    });
    this.draftPhoto.set(task.photo ?? null);
    this.draftPhotoUrl.set(this.photoUrls()[task.id] ?? null);

    if (task.photo) {
      void this.peripherals
        .readPhoto(task.photo)
        .then((url) => this.draftPhotoUrl.set(url))
        .catch(() => undefined);
    }

    this.draftLocation.set(task.location ?? null);
    this.photoPendingReason.set(null);
    this.locationPendingReason.set(null);
    void this.content()?.scrollToTop(300);
  }

  cancelEdit(): void {
    this.resetForm();
  }

  async confirmDelete(task: Task): Promise<void> {
    const alert = await this.alertController.create({
      header: 'Eliminar tarea',
      message: `¿Seguro que quieres eliminar "${task.title}"? Esta acción no se puede deshacer.`,
      buttons: [
        {
          text: 'Cancelar',
          role: 'cancel',
        },
        {
          text: 'Eliminar',
          role: 'destructive',
          handler: async () => {
            try {
              await this.taskService.deleteTask(task.id);
              this.cleanupUnusedPhoto(task.photo, task.id);

              if (this.editingTaskId() === task.id) {
                this.resetForm();
              }

              this.showStatus('Tarea eliminada');
            } catch (error) {
              this.showStatus(error instanceof Error ? error.message : 'No se pudo eliminar la tarea.');
            }
          },
        },
      ],
    });

    await alert.present();
  }

  async syncNow(): Promise<void> {
    await this.taskService.sync();
  }

  async importTasks(): Promise<void> {
    this.importing.set(true);

    try {
      const result = await this.taskService.importTasks();
      const skipped = result.skippedDuplicates + result.skippedInvalid + (result.skippedLimit ?? 0);
      this.showStatus(
        skipped > 0
          ? `Se importaron ${result.imported.length} tareas. Se omitieron ${skipped} registros duplicados, inválidos o fuera del límite.`
          : `Se importaron ${result.imported.length} tareas desde la API externa.`,
      );
    } catch (error) {
      this.showStatus(error instanceof Error ? error.message : 'No se pudo importar desde la API externa.');
    } finally {
      this.importing.set(false);
    }
  }

  dismissConflict(): void {
    this.taskService.dismissConflict();
  }

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }

  // Shared by capturePhoto/attachPhoto: both peripheral actions resolve to the same
  // draft state and status feedback, only the source and success copy differ.
  private async applyPhotoResult(result: PhotoCaptureResult, successMessage: string): Promise<void> {
    if (result.status === 'success') {
      this.draftPhoto.set(result.photo);
      this.draftPhotoUrl.set(await this.peripherals.readPhoto(result.photo).catch(() => null));
      this.photoPendingReason.set(null);
      this.showStatus(successMessage);
      return;
    }

    if (result.status !== 'cancelled') {
      this.photoPendingReason.set(result.message);
    }

    this.showStatus(result.message);
  }

  private cleanupUnusedPhoto(photo: TaskPhoto | null | undefined, excludedTaskId?: string): void {
    if (!photo) {
      return;
    }

    const stillReferenced = this.tasks().some((task) => task.id !== excludedTaskId && task.photo?.path === photo.path);

    if (stillReferenced) {
      return;
    }

    void this.peripherals.removePhoto(photo).catch(() => undefined);
  }

  private resetForm(): void {
    this.taskForm.reset();
    this.editingTaskId.set(null);
    this.draftPhoto.set(null);
    this.draftPhotoUrl.set(null);
    this.draftLocation.set(null);
    this.photoPendingReason.set(null);
    this.locationPendingReason.set(null);
  }

  private buildSaveMessage(editingId: string | null, photo: TaskPhoto | null, location: TaskLocation | null): string {
    const base = editingId ? 'Tarea actualizada' : 'Tarea agregada';
    const pending: string[] = [];

    if (!photo) {
      pending.push(this.photoPendingReason() ? `foto (${this.photoPendingReason()})` : 'foto');
    }

    if (!location) {
      pending.push(this.locationPendingReason() ? `ubicación (${this.locationPendingReason()})` : 'ubicación');
    }

    return pending.length > 0 ? `${base}. Pendiente: ${pending.join('; ')}.` : base;
  }

  private showStatus(message: string): void {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
    }

    this.statusMessage.set(message);
    this.statusTimer = setTimeout(() => {
      this.statusMessage.set(null);
      this.statusTimer = undefined;
    }, 3200);
  }
}
