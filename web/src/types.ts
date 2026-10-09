export interface City {
  version: number;
  repo: { name: string; source: string; remote?: string; ref: string; commit: string; analyzedAt: string };
  stats: {
    files: number; dirs: number; loc: number; lines: number; bytes: number;
    languages: Record<string, { files: number; loc: number }>;
    skipped: Record<string, number>;
  };
  bounds: { w: number; d: number };
  districts: District[];
  buildings: Building[];
}

export interface District {
  path: string; name: string; depth: number; parent: number;
  x: number; z: number; w: number; d: number;
}

export interface Building {
  path: string; name: string; district: number; lang: string;
  x: number; z: number; w: number; d: number;
  loc: number; lines: number; bytes: number;
}

export type Metric = 'loc' | 'lines' | 'bytes';
export type ScaleMode = 'sqrt' | 'linear' | 'log';
export type ColorMode = 'language' | 'size' | 'depth';
