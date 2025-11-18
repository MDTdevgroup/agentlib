import { loadStrategies } from './loadStrategies.js';
import { parseStrategies } from './parseStrategies.js';
import path from 'path'; // Import 'path' module to handle file extensions

// --- Resource Path Descriptors (Removed for simplicity) ---
// Note: FilePath, URLPath, and ResourcePath classes have been removed.

// --- Atomic Prompt Class (Custom Implementation - Flat Variables Only) ---

class Prompt {
    /**
     * @param {string} templateString The raw prompt string.
     * @param {string} startDel The start delimiter, e.g., '{{'
     * @param {string} endDel The end delimiter, e.g., '}}'
     */
    constructor(templateString, startDel = '{{', endDel = '}}') {
        this.template = templateString;
        this.delimiterStart = startDel;
        this.delimiterEnd = endDel;

        // Escape characters for RegExp use
        const escapedStart = this.delimiterStart.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const escapedEnd = this.delimiterEnd.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

        // Regex now looks for valid variable names (including dots, but we only use the full string)
        this.varRegex = new RegExp(`${escapedStart}\\s*([a-zA-Z0-9_.]+)\\s*${escapedEnd}`, 'g');

        this.variables = this._discoverVariables();
    }

    /**
     * Discovers all unique variables in the template.
     * @returns {Set<string>} A set of variable names.
     */
    _discoverVariables() {
        const vars = new Set();
        let match;
        this.varRegex.lastIndex = 0;
        while ((match = this.varRegex.exec(this.template)) !== null) {
            vars.add(match[1].trim());
        }
        this.varRegex.lastIndex = 0;
        return vars;
    }

    /**
     * Formats the prompt template with the given variables.
     * @param {object} variables - An object where keys are variable names.
     * @returns {string} The formatted prompt string.
     */
    format(variables = {}) {
        // NATIVE REPLACEMENT LOGIC - ONLY LOOKS UP FLAT KEYS
        return this.template.replace(this.varRegex, (match, varPath) => {
            const cleanPath = varPath.trim();

            // Direct Lookup - Assuming flat variables (e.g., variables['user_name'])
            const value = variables[cleanPath];

            // If value is undefined, leave the variable intact
            return value !== undefined ? String(value) : match;
        });
    }

    /**
     * @returns {string[]} An array of variable names found in the prompt.
     */
    getVars() {
        return Array.from(this.variables);
    }
}


// --- Main Prompt Loader Class ---

/**
 * Handles loading prompts from various sources and provides
 * access to formatted Prompt objects.
 * * Use the static `PromptLoader.create()` method to instantiate.
 */
class PromptLoader {
    /**
     * Private constructor. Use `PromptLoader.create()` to instantiate.
     * @param {object} promptData - The raw, parsed object (e.g., { "greeting": { "prompt": "..." } })
     * @param {object} [options] - Options passed from create, including delimiter settings.
     */
    constructor(promptData, options = {}) {
        this.prompts = new Map();

        const startDel = options.delimiterStart || '{{';
        const endDel = options.delimiterEnd || '}}';

        for (const [key, value] of Object.entries(promptData)) {
            let promptString;

            // Handle different data structures
            if (typeof value === 'string') {
                // E.g., { "greeting": "Hello {{name}}" }
                promptString = value;
            } else if (value && typeof value.prompt === 'string') {
                // E.g., { "greeting": { "prompt": "Hello {{name}}", "output": "..." } }
                promptString = value.prompt;
            }

            if (promptString) {
                // Pass custom delimiters to the Prompt constructor
                this.prompts.set(key, new Prompt(promptString, startDel, endDel));
            } else {
                console.warn(`No valid prompt string found for key: ${key}`);
            }
        }
    }

    /**
     * Determines the parser name based on the resource path.
     * @param {string} resourcePath - The path or URL of the resource.
     * @returns {string} The name of the parser strategy ('yaml', 'json', 'sqlite', or 'customText').
     */
    static _determineParser(resourcePath) {
        // Remove query parameters for cleaner path analysis
        const cleanPath = resourcePath.split('?')[0];
        const extension = path.extname(cleanPath).toLowerCase();

        switch (extension) {
            case '.yaml':
            case '.yml':
                return 'yaml';
            case '.json':
                return 'json';
            case '.db':
            case '.sqlite':
                return 'sqlite';
            case '.txt':
            case '.md':
                return 'customText';
            default:
                // For local files without a known extension, default to customText.
                return 'customText';
        }
    }

    /**
     * Asynchronously creates and initializes a PromptLoader.
     * This is the main entry point for the class.
     * @param {string} resourcePathOrUrl - The file path or URL to the prompt resource.
     * @param {object} [options] - Optional settings.
     * @param {string} [options.parser] - Explicitly set the parser (overrides extension analysis).
     * @returns {Promise<PromptLoader>} A new, initialized PromptLoader instance.
     */
    static async create(resourcePathOrUrl, options = {}) {
        let rawData;
        let promptData;
        let parserName;

        // Determine the resource type (file vs. url)
        const isUrl = resourcePathOrUrl.startsWith('http://') || resourcePathOrUrl.startsWith('https://');
        const resourceType = isUrl ? 'url' : 'file';

        // 1. Load the raw data based on resource type
        if (resourceType === 'file') {
            rawData = await loadStrategies.file(resourcePathOrUrl);
        } else if (resourceType === 'url') {
            rawData = await loadStrategies.url(resourcePathOrUrl);
        }

        // 2. Determine the parser to use
        parserName = options.parser // Priority 1: Explicit parser from options
            || PromptLoader._determineParser(resourcePathOrUrl); // Priority 2: Based on path extension

        // 3. Parse the raw data
        if (!parseStrategies[parserName]) {
            throw new Error(`Unknown parser: ${parserName}`);
        }

        // Handle sqlite's async parser separately
        if (parserName === 'sqlite') {
            // SQLite requires the DB connection object, which is returned by loadStrategies.sqlite
            const dbConnection = await loadStrategies.sqlite(resourcePathOrUrl);
            promptData = await parseStrategies.sqlite(dbConnection);
        } else {
            // All other parsers expect rawData (a string)
            promptData = parseStrategies[parserName](rawData);
        }

        // 4. Pass the options object, including delimiters, to the constructor
        return new PromptLoader(promptData, options);
    }

    /**
     * Retrieves an initialized Prompt object by its ID.
     * @param {string} signatureID - The key of the prompt.
     * @returns {Prompt | undefined} The Prompt object, or undefined if not found.
     */
    getPrompt(signatureID) {
        const prompt = this.prompts.get(signatureID);
        if (!prompt) {
            console.error(`Prompt signature "${signatureID}" does not exist.`);
            return undefined;
        }
        return prompt;
    }

    /**
     * @returns {Map<string, Prompt>} A map of all loaded prompt objects.
     */
    getAllPrompts() {
        return this.prompts;
    }
}


// --- Exports ---

export {
    PromptLoader,
    Prompt,
};