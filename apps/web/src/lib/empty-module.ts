// Browser stub for Node built-ins that workspace packages import but never call in the browser (see next.config.mjs).
export const readFileSync = (): never => {
  throw new Error('node:fs is not available in the browser');
};
export default {};
