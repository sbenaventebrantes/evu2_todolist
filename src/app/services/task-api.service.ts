import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

import { environment } from '../../environments/environment';
import type { ImportResult, TaskListResponse } from '../models/sync.model';
import type { Task } from '../models/task.model';

@Injectable({ providedIn: 'root' })
export class TaskApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/api`;

  getTasks(since?: string | null): Observable<TaskListResponse> {
    const params = since ? new HttpParams().set('since', since) : undefined;
    return this.http.get<TaskListResponse>(`${this.baseUrl}/tasks`, { params });
  }

  putTask(task: Task, opId: string): Observable<{ task: Task }> {
    return this.http.put<{ task: Task }>(`${this.baseUrl}/tasks`, { ...task, opId });
  }

  deleteTask(id: string, opId: string, deletedAt: string): Observable<{ task: Task }> {
    const params = new HttpParams().set('opId', opId).set('deletedAt', deletedAt);
    return this.http.delete<{ task: Task }>(`${this.baseUrl}/tasks/${encodeURIComponent(id)}`, { params });
  }

  importTodos(): Observable<ImportResult> {
    return this.http.post<ImportResult>(`${this.baseUrl}/import/todos`, {});
  }
}
