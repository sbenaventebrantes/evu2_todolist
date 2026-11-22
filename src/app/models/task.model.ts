export interface TaskPhoto {
  path: string;
  name: string;
  mimeType: string;
  dataUrl?: string;
}

export interface TaskLocation {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  capturedAt: string;
}

export interface TaskImportInfo {
  source: string;
  sourceId: string;
  importKey: string;
  completed?: boolean;
  sourceUserId?: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  createdAt?: string;
  updatedAt?: string;
  deleted?: boolean;
  photo?: TaskPhoto;
  location?: TaskLocation;
  importInfo?: TaskImportInfo;
  lastOpId?: string;
}

export interface TaskDraft {
  title: string;
  description: string;
  photo?: TaskPhoto;
  location?: TaskLocation;
}
