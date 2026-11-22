import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';

import { environment } from '../../environments/environment';
import { TokenStore } from '../services/token.store';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const token = inject(TokenStore).token();

  if (!token || !request.url.startsWith(environment.apiUrl)) {
    return next(request);
  }

  return next(request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
};
