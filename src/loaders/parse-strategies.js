import yaml from 'js-yaml';

export const parseStrategies = {
    /**
     * Parses a YAML string.
     * @param {string} data - The raw YAML string.
     * @returns {object} The parsed JavaScript object.
     */
    yaml: (data) => {
        try {
            return yaml.load(data);
        } catch (error) {
            throw new Error(`YAML parsing error: ${error.message}`);
        }
    },

    /**
     * Parses a JSON string.
     * @param {string} data - The raw JSON string.
     * @returns {object} The parsed JavaScript object.
     */
    json: (data) => {
        try {
            return JSON.parse(data);
        } catch (error) {
            throw new Error(`JSON parsing error: ${error.message}`);
        }
    },

    /**
     * Parses a sqlite database.
     * @param {object} db - The sqlite database.
     * @returns {object} The parsed sqlite database in key-value pairs of signature: { prompt: string, output: string }.
     */
    sqlite: (db) => {
        return new Promise((resolve, reject) => {
            const query = 'SELECT signature, prompt, output FROM prompt_store';
            db.all(query, [], (err, rows) => {
                if (err) {
                    return reject(new Error(`SQLite query error: ${err.message}`));
                }

                const data = {};
                rows.forEach(row => {
                    data[row.signature] = { prompt: row.prompt, output: row.output };
                });

                db.close((err) => {
                    if (err) {
                        console.error(`SQLite close error: ${err.message}`);
                    }
                });
                resolve(data);
            });
        });
    },

    /**
     * Parses a custom text format.
     * Sections are delimited by a delimiter at the start of a line (default is '#').
     * The first line of a section is the key.
     * @param {string} data - The raw text data.
     * @param {string} delimiter - The delimiter at the start of a line (default is '#').
     * @returns {object} A dictionary of sections.
     */
    customText: (data, delimiter = '#') => {
        // Use RegExp to split only on delimiters at the beginning of a line
        const sections = data.split(new RegExp(`^${delimiter}`, 'm'));
        const sectionDict = sections.reduce((acc, section) => {
            const lines = section.trim().split('\n');
            const key = lines.shift();
            if (key) {
                acc[key.trim()] = lines.join('\n');
            }
            return acc;
        }, {});
        return sectionDict;
    }
};