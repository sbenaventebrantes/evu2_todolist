import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { AppComponent } from './app.component';
import { AuthService } from './services/auth.service';
import { createAuthDouble } from './testing/test-doubles';

describe('AppComponent', () => {
  it('creates the app and restores a persisted session', async () => {
    const auth = createAuthDouble();

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    }).compileComponents();

    const fixture = TestBed.createComponent(AppComponent);

    expect(fixture.componentInstance).toBeTruthy();
    expect(auth.restoreSession).toHaveBeenCalledTimes(1);
    expect(vi.isMockFunction(auth.restoreSession)).toBe(true);
  });
});
