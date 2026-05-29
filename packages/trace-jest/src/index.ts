/**
 * @tracegraph/jest — TraceGraph reporter for Jest.
 *
 * Reporter usage in jest.config.js:
 *   module.exports = {
 *     reporters: ['default', '@tracegraph/jest'],
 *   };
 *
 * Or with options:
 *   module.exports = {
 *     reporters: [
 *       'default',
 *       ['@tracegraph/jest', {}],
 *     ],
 *   };
 *
 * Reporter usage via CLI:
 *   tracegraph run -- jest --reporters=default --reporters=@tracegraph/jest
 */
export { TraceGraphJestReporter } from './reporter';

/**
 * Default export so Jest can load the reporter via the short-form string
 * `'@tracegraph/jest'` without the user needing to specify the class name.
 */
export { TraceGraphJestReporter as default } from './reporter';
