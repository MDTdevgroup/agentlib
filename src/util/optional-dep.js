import { makeException } from './exception.js';

/**
 * Lazily loads an optional peer dependency.
 * If the package is not installed, throws a structured `MissingDependency` Exception
 * with actionable install commands.
 *
 * @param {string} pkgName - The package or subpath to import (e.g. 'sqlite3', '@a2a-js/sdk')
 * @param {string} featureName - The name of the feature requiring this package (e.g. 'SQLite prompt store')
 * @param {object|string} [options] - Configuration options or direct install command string
 * @param {string} [options.installCommand] - Custom install command to suggest (e.g. 'npm install @a2a-js/sdk express')
 * @param {string} [options.customMessage] - Full custom error message to display
 * @returns {Promise<any>} The imported module namespace or default export
 */
export async function loadOptional(pkgName, featureName, options = {}) {
    const opts = typeof options === 'string' ? { installCommand: options } : options;
    const installCmd = opts.installCommand || `npm install ${pkgName}`;

    try {
        return await import(pkgName);
    } catch (err) {
        const isNotFound = err?.code === 'ERR_MODULE_NOT_FOUND' ||
            err?.code === 'MODULE_NOT_FOUND' ||
            err?.message?.includes('Cannot find package') ||
            err?.message?.includes('Cannot find module');

        if (isNotFound) {
            const message = opts.customMessage || `The ${featureName} requires '${pkgName}'.\nInstall with: ${installCmd}`;
            throw makeException('MissingDependency', message, { cause: err });
        }
        throw err;
    }
}
