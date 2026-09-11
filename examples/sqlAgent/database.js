import { loadOptional } from "../../src/util/optional-dep.js";

/**
 * Initializes and connects to the SQLite database.
 *
 * @param {string} [dbPath="./chinook.db"] - Path to the SQLite database file.
 * @returns {Promise<object>} The connected SQLite database client.
 */
export async function initDB(dbPath = "./chinook.db") {
    const sqlite3Module = await loadOptional("sqlite3", "SQL database driver", {
        installCommand: "npm install sqlite3 sqlite",
    });
    const sqlite3 = sqlite3Module.default || sqlite3Module;
    const { open } = await loadOptional("sqlite", "SQL database driver", {
        installCommand: "npm install sqlite3 sqlite",
    });
    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database,
    });
    return db;
}
