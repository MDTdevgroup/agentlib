import { loadStrategies } from './loadStrategies.js';
import { parseStrategies } from './parseStrategies.js';

// --- Resource Path Descriptors ---

class ResourcePath {
    constructor(type) {
        if (this.constructor === ResourcePath) {
            throw new Error("Abstract class 'ResourcePath' cannot be instantiated directly.");
        }
        this.type = type;
    }
}

/**
 * Represents a generic file resource (e.g., .txt, .md).
 * Defaults to the 'customText' parser.
 */
class FilePath extends ResourcePath {
    constructor(path) {
        super("file");
        this.path = path;
    }
}

/**
 * Represents a YAML file resource.
 * Defaults to the 'yaml' parser.
 */
class YAMLPath extends ResourcePath {
    constructor(path) {
        super("yaml");
        this.path = path;
    }
}

/**
 * Represents a JSON file resource.
 * Defaults to the 'json' parser.
 */
class JSONPath extends ResourcePath {
    constructor(path) {
        super("json");
        this.path = path;
    }
}

/**
 * Represents a resource located at a remote URL.
 * Defaults to the 'json' parser.
 * @param {string} path - The API endpoint.
 */
class URLPath extends ResourcePath {
    constructor(path) {
        super("url");
        this.path = path;
    }
}

/**
 * Represents a resource located in an SQLite database file.
 * Defaults to the 'sqlite' parser.
 */
class SQLitePath extends ResourcePath {
    constructor(path) {
        super("sqlite");
        this.path = path;
    }
}

// --- Atomic Prompt Class ---

/**
 * Represents a single, formattable prompt.
 */
class Prompt {
    /**
     * @param {string} templateString The raw prompt string, e.g., "Hello, {name}!"
     * @param {string[]} delimiter The start and end delimiters, e.g., ['{', '}']
     */
    constructor(templateString, delimiter = ['{', '}']) {
        this.template = templateString;
        this.delimiterStart = delimiter[0];
        this.delimiterEnd = delimiter[1];
        // Create a regex to find variables, e.g., /\{([^}]+)\}/g
        this.varRegex = new RegExp(`\\${this.delimiterStart}([^\\${this.delimiterEnd}]+)\\${this.delimiterEnd}`, 'g');
        this.variables = this._discoverVariables();
    }

    /**
     * Discovers all unique variables in the template.
     * @returns {Set<string>} A set of variable names.
     */
    _discoverVariables() {
        const vars = new Set();
        let match;
        while ((match = this.varRegex.exec(this.template)) !== null) {
            vars.add(match[1]); // Add the captured group
        }
        return vars;
    }

    /**
     * Formats the prompt template with the given variables.
     * @param {object} variables - An object where keys are variable names.
     * @returns {string} The formatted prompt string.
     */
    format(variables = {}) {
        return this.template.replace(this.varRegex, (match, varName) => {
            const value = variables[varName];
            return value !== undefined ? String(value) : match; // Keep unfound vars
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
     */
    constructor(promptData) {
        this.prompts = new Map();

        for (const [key, value] of Object.entries(promptData)) {
            let promptString;

            // Handle different data structures
            if (typeof value === 'string') {
                // E.g., { "greeting": "Hello {name}" }
                promptString = value;
            } else if (value && typeof value.prompt === 'string') {
                // E.g., { "greeting": { "prompt": "Hello {name}", "output": "..." } }
                promptString = value.prompt;
            }

            if (promptString) {
                this.prompts.set(key, new Prompt(promptString));
            } else {
                console.warn(`No valid prompt string found for key: ${key}`);
            }
        }
    }

    /**
     * Asynchronously creates and initializes a PromptLoader.
     * This is the main entry point for the class.
     * @param {ResourcePath} resource - An instance of FilePath, URLPath, etc.
     * @param {object} [options] - Optional settings.
     * @param {string} [options.parser] - Explicitly set the parser (e.g., 'yaml', 'json', 'customText').
     * @returns {Promise<PromptLoader>} A new, initialized PromptLoader instance.
     */
    static async create(resource, options = {}) {
        let rawData;
        let promptData;

        // 1. Load the raw data based on resource type
        switch (resource.type) {
            case 'file':
            case 'yaml':
            case 'json':
                rawData = await loadStrategies.file(resource.path);
                break;
            case 'url':
                rawData = await loadStrategies.url(resource.path);
                break;
            case 'sqlite':
                rawData = await loadStrategies.sqlite(resource.path); // rawData is the db connection
                break;
            default:
                throw new Error(`Unsupported resource type: ${resource.type}`);
        }

        // 2. Determine the parser to use
        let parserName = options.parser; // Priority 1: Explicit parser from options
        if (!parserName) {
            // Priority 2: Default parser based on resource type
            switch (resource.type) {
                case 'yaml':
                    parserName = 'yaml';
                    break;
                case 'json':
                    parserName = 'json';
                    break;
                case 'url':
                    parserName = 'json'; // Default for URLs
                    break;
                case 'sqlite':
                    parserName = 'sqlite';
                    break;
                case 'file':
                default:
                    parserName = 'customText'; // Default for generic 'file'
                    break;
            }
        }

        // 3. Parse the raw data
        if (!parseStrategies[parserName]) {
            throw new Error(`Unknown parser: ${parserName}`);
        }

        // Handle sqlite's async parser separately
        if (parserName === 'sqlite') {
            promptData = await parseStrategies.sqlite(rawData); // rawData is the db object
        } else {
            promptData = parseStrategies[parserName](rawData); // rawData is a string
        }

        return new PromptLoader(promptData);
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
    FilePath,
    YAMLPath,
    JSONPath,
    URLPath,
    SQLitePath,
    ResourcePath,
};