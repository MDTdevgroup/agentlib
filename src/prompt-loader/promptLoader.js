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

        // Escape special chars so user delimiters like '?' don't break regex logic.
        const escapedStart = this.delimiterStart.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const escapedEnd = this.delimiterEnd.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

        // Matches start delimiter, captures variable name (alphanumeric + dots), matches end.
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
        return this.template.replace(this.varRegex, (match, varPath) => {
            const cleanPath = varPath.trim();
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

    static _determineLoader(resourcePathOrUrl, parserName) {
        // SQLite requires a specific loader (db connection), regardless of path
        if (parserName === 'sqlite') return 'sqlite';

        // Otherwise, check protocol
        const isUrl = resourcePathOrUrl.startsWith('http://') || resourcePathOrUrl.startsWith('https://');
        return isUrl ? 'url' : 'file';
    }

    /**
     * Determines the parser name based on the resource path.
     * @param {string} resourcePath - The path or URL of the resource.
     * @returns {string} The name of the parser strategy ('yaml', 'json', 'sqlite', or 'customText').
     */
    static _determineParser(resourcePath) {
        const cleanPath = resourcePath.split('?')[0];
        const extension = path.extname(cleanPath).toLowerCase();

        const map = {
            '.yaml': 'yaml',
            '.yml': 'yaml',
            '.json': 'json',
            '.db': 'sqlite',
            '.sqlite': 'sqlite',
            '.txt': 'customText',
            '.md': 'customText'
        };

        return map[extension] || 'customText';
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
        // 1. Determine Strategies
        const parserName = options.parser || PromptLoader._determineParser(resourcePathOrUrl);
        const loaderName = PromptLoader._determineLoader(resourcePathOrUrl, parserName);

        // 2. Validate
        if (!loadStrategies[loaderName]) throw new Error(`Unknown loader: ${loaderName}`);
        if (!parseStrategies[parserName]) throw new Error(`Unknown parser: ${parserName}`);

        // 3. Universal Execution Flow
        // 'rawResource' adapts: it's a String for files, or a DbConnection for sqlite
        const rawResource = await loadStrategies[loaderName](resourcePathOrUrl);

        // The parser strategy handles its specific input type (String or DbConnection)
        const promptData = await parseStrategies[parserName](rawResource);

        return new PromptLoader(promptData, options);
    }

    /**
     * Retrieves an initialized Prompt object by its ID.
     * @param {string} id - The key of the prompt.
     * @returns {Prompt | undefined} The Prompt object, or undefined if not found.
     */
    getPrompt(id) {
        const prompt = this.prompts.get(id);
        if (!prompt) {
            console.error(`Prompt ID "${id}" does not exist.`);
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