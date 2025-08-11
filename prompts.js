import fs from 'fs';
import yaml from 'js-yaml';
import { readFileSync } from 'fs';

class ResourcePath {
    constructor(type) {
        this.type = type;
    }
}

class FilePath extends ResourcePath {
    constructor(path) {
        super("file");
        this.path = path;
    }
}

class URLPath extends ResourcePath {
    constructor(path) {
        super("url");
        this.path = path;
    }
}

function parseTextFile(Data) {

    const sections = Data.split(/^!/m);
    const sectionDict = sections.reduce((acc, section) => {
        const lines = section.trim().split('\n');
        const key = lines.shift();
        if (key) {
            acc[key] = lines.join('\n');
        }
        return acc;
    }, {});
    return sectionDict;

}

const loadStrategies = {

    file: (path) => {
        try {
            const fileContents = readFileSync(path, 'utf-8');
            return yaml.load(fileContents);
        } catch (error) {
            throw new Error(`File loading error: ${error.message}`);
        }
    },

    sqlite: (path) => {
        const sqlite = (path) => {
            return new Promise((resolve, reject) => {
                const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, (err) => {
                    if (err) {
                        reject(new Error(`SQLite connection error: ${err.message}`));
                        return;
                    }

                    db.all('SELECT signature, prompt, output FROM prompt_store', [], (err, rows) => {
                        if (err) {
                            reject(new Error(`SQLite query error: ${err.message}`));
                        } else {
                            const data = {};
                            rows.forEach(row => {
                                data[row.signature] = { prompt: row.prompt, output: row.output };
                            });
                            resolve(data);
                        }
                    });

                    db.close((err) => {
                        if (err) {
                            console.error(`SQLite close error: ${err.message}`);
                        }
                    });
                });
            });
        };
    },

    url: (path) => {
        return new Promise((resolve, reject) => {
            const protocol = path.startsWith('https') ? https : http;

            protocol.get(path, (response) => {
                let data = '';

                response.on('data', (chunk) => {
                    data += chunk;
                });

                response.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (error) {
                        reject(new Error(`URL JSON parsing error: ${error.message}`));
                    }
                });
            }).on('error', (error) => {
                reject(new Error(`URL loading error: ${error.message}`));
            });
        });
    },

};

class PromptHandler {
    constructor(resource) {
        this.data = loadStrategies[resource.type](resource.path)
    }

    getAllPrompts() {
        return this.data
    }

    getPrompt(signatureID) {
        try {
            const signatureValues = this.data[signatureID];
            return signatureValues

        } catch {
            console.error(`Signature "${signatureID}"  does not exist in the data.`);
            return undefined;
        }


    }
}



function loadYaml(filePath) {
    try {
        const fileContents = fs.readFileSync(filePath, 'utf8');
        return yaml.load(fileContents);
    } catch (error) {
        console.error(`Error loading YAML file: ${error.message}`);
        throw error;
    }
}


export {PromptHandler, FilePath, URLPath, ResourcePath, parseTextFile, loadYaml}; ;