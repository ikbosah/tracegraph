/**
 * T1.4 — CJS register hook
 *
 * Load via: NODE_OPTIONS='--require @tracegraph/trace-js/register-cjs'
 *
 * Identical behaviour to register.ts; runs via CJS require() at startup.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { init } from './register';
init();
