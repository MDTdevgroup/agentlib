import { promises as fs } from 'fs';
import http from 'http';
import https from 'https';
import sqlite3 from 'sqlite3';

export const loadStrategies = {
    /**
     * Loads and parses a file from the local file system.
     * @param {string} path - The file path.
     * @returns {Promise<string>} The file contents.
     */
    file: async (path) => {
        try {
            const fileContents = await fs.readFile(path, 'utf-8');
            return fileContents;
        } catch (error) {
            throw new Error(`File loading error: ${error.message}`);
        }
    },

    /**
     * Loads and parses data from a URL.
     * @param {string} path - The URL.
     * @param {string} parserName - The key of the parser (e.g., 'json', 'yaml').
     * @returns {Promise<string>} The URL contents.
     */
    url: (path) => {
        const protocol = path.startsWith('https') ? https : http;

        return new Promise((resolve, reject) => {
            protocol.get(path, (response) => {
                let data = '';
                response.on('data', (chunk) => data += chunk);
                response.on('end', () => {
                    try {
                        // Use the specified parser
                        resolve(data);
                    } catch (error) {
                        reject(error); // Pass up parsing error
                    }
                });
            }).on('error', (error) => {
                reject(new Error(`URL loading error: ${error.message}`));
            });
        });
    },

    /**
     * Loads prompt data from an SQLite database.
     * @param {string} path - The path to the SQLite DB file.
     * @returns {Promise<object>} The prompt data object in key-value pairs of signature: { prompt: string, output: string }.
     */
    sqlite: (path) => {
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, (err) => {
                if (err) {
                    return reject(new Error(`SQLite connection error: ${err.message}`));
                }
            });
            resolve(db);
        });
    }
};