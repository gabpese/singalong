// Injection tokens for the services app.ts builds before Nest. The Nest modules receive them through LegacyModule.
export const CONFIG = Symbol('config');
export const JOBS = Symbol('jobs');
export const STORAGE = Symbol('storage');
export const LIMITERS = Symbol('limiters');
export const MAILER = Symbol('mailer');
