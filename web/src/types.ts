export interface City {
  version: number;
  repo: { name: string; source: string; remote?: string; path?: string; ref: string; commit: string; analyzedAt: string };
  commits: Commit[];
  churn: boolean;
  authors?: Author[];
  /** Multi-repo worlds: each repo is a top-level district (district 0 is the world root). */
  repos?: RepoInfo[];
  links?: Link[];
  stats: {
    files: number; dirs: number; loc: number; lines: number; bytes: number;
    languages: Record<string, { files: number; loc: number }>;
    skipped: Record<string, number>;
  };
  bounds: { w: number; d: number };
  districts: District[];
  buildings: Building[];
}

export interface Commit { hash: string; date: string; author: string; subject: string; repo?: number }
export interface RepoInfo { name: string; source: string; remote?: string; path?: string; ref: string; commit: string; district: number; churn: boolean }
/** dependency: from depends on to (evidence, importing files → imported directory); people: shared contributors. */
export interface Link { from: number; to: number; kind: 'dependency' | 'people'; evidence?: string[]; files?: [number, number][]; people?: string[]; peopleCount?: number }
export interface Author { name: string; commits: number; files: number; last: number }

export interface District {
  path: string; name: string; depth: number; parent: number;
  x: number; z: number; w: number; d: number;
}

export interface Building {
  path: string; name: string; district: number; lang: string;
  x: number; z: number; w: number; d: number;
  /** Change points: [commit index, loc, lines, bytes, complexity]; loc -1 = absent from that commit on. */
  h: [number, number, number, number, number][];
  /** Sparse churn: [commit index, commits, lines changed, newest commit unix time] in (previous sample, this sample]. */
  ch?: [number, number, number, number][];
  /** [author index, owner's commits to the file, distinct authors]. */
  own?: [number, number, number];
  /** Change coupling: [building index, shared commits, degree %]. */
  cpl?: [number, number, number][];
  repo?: number;
  /** Same-repo files (building indices) and package directories (district indices) this file imports. */
  imp?: number[];
  impd?: number[];
}

export type Metric = 'loc' | 'lines' | 'bytes' | 'complexity';
export type ScaleMode = 'sqrt' | 'linear' | 'log';
export type ColorMode = 'language' | 'hotspot' | 'churn' | 'complexity' | 'age' | 'owner' | 'knowledge' | 'compare' | 'depth' | 'dependents';

export const SCHEMA_VERSION = 5;
