import sqlite3 from "sqlite3";
import { open } from "sqlite";

// Initialize sqlite connection (async)
export async function initDB(dbPath = "./Chinook.db") {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });
  return db;
}

export function makeSQLTools(db) {
  return [
    {
      type: "function",
      name: "list_tables",
      description: "List available tables in the database",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      func: async () => {
        const rows = await db.all("SELECT name FROM sqlite_master WHERE type='table';");
        return rows.map(r => r.name);
      },
    },
    {
      type: "function",
      name: "get_schema",
      description: "Get schema of a table",
      parameters: {
        type: "object",
        properties: {
          table: {
            type: "string",
            description: "The name of the table to get schema for",
          },
        },
        required: ["table"],
      },
      func: async ({ table }) => {
        const schema = await db.all(`PRAGMA table_info(${table});`);
        return schema;
      },
    },
    {
      type: "function",
      name: "run_query",
      description: "Run a SQL SELECT query and return results",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The SQL SELECT query to execute",
          },
        },
        required: ["query"],
      },
      func: async ({ query }) => {
        try {
          const rows = await db.all(query);
          return rows;
        } catch (err) {
          return { error: err.message };
        }
      },
    },
  ];
}
