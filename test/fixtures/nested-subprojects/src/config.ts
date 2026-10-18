/** Application settings — not a build tool config. */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Paths mentioned here are data, not entry points.
  legacyHandler: './legacy.ts',
  templates: 'templates/mail.ts',
};
