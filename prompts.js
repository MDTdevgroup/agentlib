import fs from 'fs';
import yaml from 'js-yaml';

/**
 * Loads text values from a YAML file.
 * @param {string} filePath - The path to the YAML file.
 * @returns {Object} - The parsed YAML content as a JavaScript object.
 */
function loadYaml(filePath) {
    try {
        const fileContents = fs.readFileSync(filePath, 'utf8');
        return yaml.load(fileContents);
    } catch (error) {
        console.error(`Error loading YAML file: ${error.message}`);
        throw error;
    }
}

export default  loadYaml;