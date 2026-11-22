import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AlertController } from '@ionic/angular';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskLocation, TaskPhoto } from '../models/task.model';
import { AuthService } from '../services/auth.service';
import { ConnectivityService } from '../services/connectivity.service';
import { PeripheralService } from '../services/peripheral.service';
import { AppStorage } from '../services/storage.service';
import { TaskApiService } from '../services/task-api.service';
import { TaskService } from '../services/task.service';
import { TokenStore } from '../services/token.store';
import {
  TEST_SERVER_TIME,
  TEST_USER,
  createApiDouble,
  createAuthDouble,
  createConnectivityDouble,
  createStorageDouble,
  createTask,
  createTokenDouble,
  storageAsAppStorage,
} from '../testing/test-doubles';

import { HomePage } from './home.page';

type AlertElement = Awaited<ReturnType<AlertController['create']>>;

const PHOTO: TaskPhoto = {
  path: 'tasks/photo.jpg',
  name: 'photo.jpg',
  mimeType: 'image/jpeg',
  dataUrl: 'data:image/jpeg;base64,photo',
};

const LOCATION: TaskLocation = {
  latitude: -33.4489,
  longitude: -70.6693,
  accuracy: 10,
  capturedAt: TEST_SERVER_TIME,
};

describe('HomePage', () => {
  let component: HomePage;
  let fixture: ComponentFixture<HomePage>;
  let taskService: TaskService;
  let auth: ReturnType<typeof createAuthDouble>;
  let api: ReturnType<typeof createApiDouble>;
  let peripherals: {
    capturePhoto: ReturnType<typeof vi.fn>;
    attachPhoto: ReturnType<typeof vi.fn>;
    captureLocation: ReturnType<typeof vi.fn>;
    readPhoto: ReturnType<typeof vi.fn>;
    removePhoto: ReturnType<typeof vi.fn>;
  };
  let alertController: AlertController;
  let router: Router;

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    const storage = createStorageDouble();
    auth = createAuthDouble(TEST_USER);
    const connectivity = createConnectivityDouble();
    api = createApiDouble();
    peripherals = {
      capturePhoto: vi.fn(async () => ({ status: 'success', photo: PHOTO })),
      attachPhoto: vi.fn(async () => ({ status: 'success', photo: PHOTO })),
      captureLocation: vi.fn(async () => ({ status: 'success', location: LOCATION })),
      readPhoto: vi.fn(async () => PHOTO.dataUrl ?? ''),
      removePhoto: vi.fn(async () => undefined),
    };

    TestBed.configureTestingModule({
      imports: [HomePage],
      providers: [
        provideRouter([]),
        { provide: AppStorage, useValue: storageAsAppStorage(storage) },
        { provide: AuthService, useValue: auth },
        { provide: ConnectivityService, useValue: connectivity },
        { provide: TaskApiService, useValue: api },
        { provide: TokenStore, useValue: createTokenDouble('token-a') },
        { provide: PeripheralService, useValue: peripherals },
      ],
    });

    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(HomePage);
    component = fixture.componentInstance;
    taskService = TestBed.inject(TaskService);
    alertController = TestBed.inject(AlertController);
    await settle();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the page with the signed-in user', () => {
    expect(component).toBeTruthy();
    expect(component.currentUser()).toEqual(TEST_USER);
  });

  it('reports an invalid field only after it is touched', () => {
    expect(component.isFieldInvalid('title')).toBe(false);

    component.taskForm.controls.title.markAsTouched();
    expect(component.isFieldInvalid('title')).toBe(true);

    component.taskForm.controls.title.setValue('Valid title');
    expect(component.isFieldInvalid('title')).toBe(false);
  });

  it('does not add a task when the form is empty', async () => {
    await component.saveTask();

    expect(component.tasks()).toHaveLength(0);
    expect(component.taskForm.controls.title.touched).toBe(true);
    expect(component.taskForm.controls.description.touched).toBe(true);
  });

  it('does not add a task when fields contain only spaces', async () => {
    component.taskForm.setValue({ title: '   ', description: '   ' });

    expect(component.taskForm.invalid).toBe(true);
    await component.saveTask();

    expect(component.tasks()).toHaveLength(0);
  });

  it('shows a quiet status message after adding a task', async () => {
    vi.useFakeTimers();
    component.taskForm.setValue({ title: 'Task', description: 'Description' });

    await component.saveTask();

    expect(component.statusMessage()).toBe('Tarea agregada. Pendiente: foto; ubicación.');

    vi.advanceTimersByTime(3201);

    expect(component.statusMessage()).toBeNull();
  });

  it('adds a task with trimmed values and resets the form', async () => {
    component.taskForm.setValue({
      title: '  Study Ionic  ',
      description: '  Review components and forms  ',
    });

    await component.saveTask();
    await settle();

    expect(component.tasks()).toHaveLength(1);
    expect(component.tasks()[0]).toMatchObject({
      title: 'Study Ionic',
      description: 'Review components and forms',
    });
    expect(component.taskForm.getRawValue()).toEqual({ title: '', description: '' });
  });

  it('attaches a captured photo and coordinates to the saved task', async () => {
    await component.capturePhoto();
    await component.captureLocation();

    expect(component.draftPhoto()).toEqual(PHOTO);
    expect(component.draftLocation()).toEqual(LOCATION);
    expect(component.draftPhotoUrl()).toBe(PHOTO.dataUrl);
    expect(component.draftCoordinates()).toContain('-33.44890');

    component.taskForm.setValue({ title: 'Con evidencia', description: 'Con foto y GPS' });
    await component.saveTask();
    await settle();

    expect(component.tasks()[0]).toMatchObject({ photo: PHOTO, location: LOCATION });
    expect(component.statusMessage()).toBe('Tarea agregada');
    expect(component.draftPhoto()).toBeNull();
  });

  it('attaches an existing photo from the gallery', async () => {
    await component.attachPhoto();

    expect(peripherals.attachPhoto).toHaveBeenCalled();
    expect(component.draftPhoto()).toEqual(PHOTO);
    expect(component.statusMessage()).toContain('Foto adjuntada');
  });

  it('explains in the save message why photo or location is missing', async () => {
    peripherals.capturePhoto.mockResolvedValueOnce({
      status: 'denied',
      message: 'Permiso de cámara denegado.',
    });
    peripherals.captureLocation.mockResolvedValueOnce({
      status: 'disabled',
      message: 'GPS deshabilitado.',
    });

    await component.capturePhoto();
    await component.captureLocation();
    component.taskForm.setValue({ title: 'Sin evidencia', description: 'Datos pendientes' });
    await component.saveTask();

    expect(component.statusMessage()).toContain('foto (Permiso de cámara denegado.)');
    expect(component.statusMessage()).toContain('ubicación (GPS deshabilitado.)');
  });

  it('loads a task with its attachments for editing and saves the changes', async () => {
    await taskService.addTask({ title: 'Original', description: 'Descripción', photo: PHOTO, location: LOCATION });
    await settle();
    const task = component.tasks()[0];

    component.startEdit(task);
    await settle();

    expect(component.editingTaskId()).toBe(task.id);
    expect(component.taskForm.getRawValue()).toEqual({ title: 'Original', description: 'Descripción' });
    expect(component.draftPhoto()).toEqual(PHOTO);
    expect(component.draftLocation()).toEqual(LOCATION);

    component.taskForm.setValue({ title: 'Editada', description: 'Nueva descripción' });
    await component.saveTask();
    await settle();

    expect(component.tasks()[0]).toMatchObject({
      id: task.id,
      title: 'Editada',
      description: 'Nueva descripción',
      photo: PHOTO,
      location: LOCATION,
    });
    expect(component.editingTaskId()).toBeNull();
  });

  it('does not recapture location when editing and preserves the original coordinates', async () => {
    await taskService.addTask({ title: 'Original', description: 'Descripción', location: LOCATION });
    await settle();
    const task = component.tasks()[0];
    peripherals.captureLocation.mockClear();

    component.startEdit(task);
    component.taskForm.setValue({ title: 'Editada', description: 'Nueva descripción' });
    await component.saveTask();
    await settle();

    expect(peripherals.captureLocation).not.toHaveBeenCalled();
    expect(component.tasks()[0].location).toEqual(LOCATION);
  });

  it('deletes the old photo file when an edited task replaces its photo', async () => {
    const oldPhoto: TaskPhoto = { ...PHOTO, path: 'tasks/old.jpg', name: 'old.jpg' };
    const newPhoto: TaskPhoto = { ...PHOTO, path: 'tasks/new.jpg', name: 'new.jpg' };
    await taskService.addTask({ title: 'Original', description: 'Descripción', photo: oldPhoto });
    await settle();

    component.startEdit(component.tasks()[0]);
    peripherals.capturePhoto.mockResolvedValueOnce({ status: 'success', photo: newPhoto });
    await component.capturePhoto();
    component.taskForm.setValue({ title: 'Editada', description: 'Nueva descripción' });
    await component.saveTask();
    await settle();

    expect(peripherals.removePhoto).toHaveBeenCalledWith(oldPhoto);
    expect(component.tasks()[0].photo).toEqual(newPhoto);
  });

  it('keeps a photo file that is still referenced by another task', async () => {
    const sharedPhoto: TaskPhoto = { ...PHOTO, path: 'tasks/shared.jpg', name: 'shared.jpg' };
    const newPhoto: TaskPhoto = { ...PHOTO, path: 'tasks/new.jpg', name: 'new.jpg' };
    await taskService.addTask({ title: 'Uno', description: 'Descripción', photo: sharedPhoto });
    await taskService.addTask({ title: 'Dos', description: 'Descripción', photo: sharedPhoto });
    await settle();
    const task = component.tasks().find((item) => item.title === 'Uno');

    if (!task) {
      throw new Error('Task was not created');
    }

    component.startEdit(task);
    peripherals.capturePhoto.mockResolvedValueOnce({ status: 'success', photo: newPhoto });
    await component.capturePhoto();
    component.taskForm.setValue({ title: 'Uno editada', description: 'Nueva descripción' });
    await component.saveTask();
    await settle();

    expect(peripherals.removePhoto).not.toHaveBeenCalled();
  });

  it('removes the draft photo and deletes the old file after saving without it', async () => {
    const oldPhoto: TaskPhoto = { ...PHOTO, path: 'tasks/old.jpg', name: 'old.jpg' };
    await taskService.addTask({ title: 'Original', description: 'Descripción', photo: oldPhoto });
    await settle();

    component.startEdit(component.tasks()[0]);
    component.removeDraftPhoto();
    component.taskForm.setValue({ title: 'Editada', description: 'Nueva descripción' });
    await component.saveTask();
    await settle();

    expect(component.draftPhoto()).toBeNull();
    expect(peripherals.removePhoto).toHaveBeenCalledWith(oldPhoto);
    expect(component.tasks()[0].photo).toBeUndefined();
  });

  it('deletes the selected task after confirmation', async () => {
    await taskService.addTask({ title: 'Task one', description: 'Description one' });
    await settle();
    const task = component.tasks()[0];
    const present = vi.fn().mockResolvedValue(undefined);
    const alert = { present } as unknown as AlertElement;
    const createSpy = vi.spyOn(alertController, 'create').mockResolvedValue(alert);

    await component.confirmDelete(task);

    const options = createSpy.mock.calls[0]?.[0];

    if (!options) {
      throw new Error('Alert options were not captured');
    }

    const buttons = (options.buttons ?? []) as {
      role?: string;
      handler?: () => void | Promise<void>;
    }[];
    const confirmButton = buttons.find((button) => button.role === 'destructive');

    expect(present).toHaveBeenCalled();
    expect(options.message).toContain('Task one');

    await confirmButton?.handler?.();
    await settle();

    expect(component.tasks()).toHaveLength(0);
    expect(component.statusMessage()).toBe('Tarea eliminada');
  });

  it('cleans up the task photo after deletion without failing on storage errors', async () => {
    const photo: TaskPhoto = { ...PHOTO, path: 'tasks/delete.jpg', name: 'delete.jpg' };
    await taskService.addTask({ title: 'Con foto', description: 'Descripción', photo });
    await settle();
    const task = component.tasks()[0];
    peripherals.removePhoto.mockRejectedValueOnce(new Error('No se pudo eliminar'));
    const alert = { present: vi.fn().mockResolvedValue(undefined) } as unknown as AlertElement;
    const createSpy = vi.spyOn(alertController, 'create').mockResolvedValue(alert);

    await component.confirmDelete(task);

    const buttons = (createSpy.mock.calls[0]?.[0]?.buttons ?? []) as {
      role?: string;
      handler?: () => void | Promise<void>;
    }[];
    const confirmButton = buttons.find((button) => button.role === 'destructive');

    await confirmButton?.handler?.();
    await settle();

    expect(peripherals.removePhoto).toHaveBeenCalledWith(photo);
    expect(component.statusMessage()).toBe('Tarea eliminada');
  });

  it('cancels editing and clears the form', async () => {
    await taskService.addTask({ title: 'Original', description: 'Descripción' });
    await settle();
    const task = component.tasks()[0];

    component.startEdit(task);
    component.cancelEdit();

    expect(component.editingTaskId()).toBeNull();
    expect(component.taskForm.getRawValue()).toEqual({ title: '', description: '' });
    expect(component.tasks()).toHaveLength(1);
  });

  it('imports tasks, reports skipped records and renders import details', async () => {
    const imported = createTask('remote-1', {
      title: 'Importada',
      importInfo: {
        source: 'jsonplaceholder',
        sourceId: '1',
        importKey: 'jsonplaceholder:1',
        completed: true,
        sourceUserId: 1,
      },
    });
    vi.mocked(api.importTodos).mockReturnValue(
      of({ imported: [imported], skippedDuplicates: 1, skippedInvalid: 1, total: 3 }),
    );

    await component.importTasks();
    await settle();

    expect(component.statusMessage()).toContain('Se importaron 1 tareas');
    expect(component.statusMessage()).toContain('Se omitieron 2 registros');
    expect(component.importing()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="import-details"]')).toBeTruthy();
  });

  it('shows a synchronization error in the template', async () => {
    vi.mocked(api.getTasks).mockReturnValue(
      throwError(() => ({ status: 500, error: { error: 'El servidor no respondió' } })),
    );

    await component.syncNow();
    await settle();

    expect(component.syncStatus()).toBe('error');
    expect(fixture.nativeElement.querySelector('[data-testid="sync-error"]').textContent).toContain(
      'El servidor no respondió',
    );
  });

  it('logs out and navigates to the login page', async () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    await component.logout();

    expect(auth.logout).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });
});
