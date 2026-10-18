declare const __CV_VERSION__: string | undefined;

/** Injected at build time by tsup (see tsup.config.ts). */
export const VERSION: string = typeof __CV_VERSION__ === 'string' ? __CV_VERSION__ : '0.0.0-dev';
