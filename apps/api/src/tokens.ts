// Injection tokens for the services app.ts builds before Nest. The Nest modules receive them through LegacyModule until each
// area moves in (ROADMAP, step 3).
export const CONFIG = Symbol('config');
export const DB = Symbol('db');
export const JOBS = Symbol('jobs');
export const STORAGE = Symbol('storage');
export const AGENTS = Symbol('agents');
export const LIMITERS = Symbol('limiters');
