export interface City {
  version: number;
  repo: { name: string; source: string; remote?: string; ref: string; commit: string; analyzedAt: string };
  commits: Commit[];
  churn: boolean;
  stats: {
    files: number; dirs: number; loc: number; lines: number; bytes: number;
    languages: Record<string, { files: number; loc: number }>;
    skipped: Record<string, number>;
  };
  bounds: { w: number; d: number };
  districts: District[];
  buildings: Building[];
}

export interface Commit { hash: string; date: string; author: string; subject: string }

export interface District {
  path: string; name: string; depth: number; parent: number;
  x: number; z: number; w: number; d: number;
}

export interface Building {
  path: string; name: string; district: number; lang: string;
  x: number; z: number; w: number; d: number;
  /** Change points: [commit index, loc, lines, bytes]; loc -1 = file absent from that commit on. */
  h: [number, number, number, number][];
  /** Sparse churn: [commit index, commits, lines changed] landing in (previous sample, this sample]. */
  ch?: [number, number, number][];
}

export type Metric = 'loc' | 'lines' | 'bytes';
export type ScaleMode = 'sqrt' | 'linear' | 'log';
export type ColorMode = 'language' | 'size' | 'depth' | 'churn' | 'hotspot';
