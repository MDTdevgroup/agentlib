import sqlite3 from "sqlite3";
import { open } from "sqlite";

export async function initDB(dbPath = "./chinook.db") {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });
  return db;
}

export function generatorTools(db) {
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
        const safe = String(table).replace(/'/g, "''");
        const schema = await db.all(`PRAGMA table_info('${safe}');`);
        return schema;
      },
    },
  ];
}

export function executorTools(db) {
  const tools = [...generatorTools(db)];
  tools.push({
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
      const rows = await db.all(query);
      return rows;
    },
  });
  return tools;
}

// --- NEW: Main Agent (Router) Tools ---

/**
 * Returns the array of tool definitions for the Main (Router) Agent.
 * The 'func' for these tools just returns the arguments.
 * The orchestration logic lives in index.js.
 */
export function mainAgentTools(db) {
  return [
    {
      type: "function",
      name: "find_sales_for_artist",
      description: "Use this tool to find the total sales for a specific artist.",
      parameters: {
        type: "object",
        properties: {
          artistName: {
            type: "string",
            description: "The name of the artist to search for",
          },
        },
        required: ["artistName"],
      },
      func: async ({ artistName }) => {
        const generatedQuery = getSalesForArtist(artistName);
        const rows = await db.all(generatedQuery);  
        return rows;
      }, 
    },
    {
      type: "function",
      name: "find_top_tracks_in_genre",
      description: "Use this tool to find the top N tracks within a specific genre based on the number of units sold.",
      parameters: {
        type: "object",
        properties: {
          genreName: {
            type: "string",
            description: "The name of the genre, e.g., 'Rock' or 'Jazz'",
          },
          limit: {
            type: "number",
            description: "The number of top tracks to return",
          },
        },
        required: ["genreName", "limit"],
      },
      func: async ({ genreName, limit }) => {
        const generatedQuery = getTopTracksInGenre(genreName, limit);
        const rows = await db.all(generatedQuery);
        return rows;
      }, 
    },
    {
      type: "function",
      name: "generate_custom_sql_query",
      description: "Use this as a fallback for any complex SQL query that does not match the other available tools.",
      parameters: {
        type: "object",
        properties: {
          naturalLanguageQuery: {
            type: "string",
            description: "The user's full, original question to be passed to the SQL generator",
          },
        },
        required: ["naturalLanguageQuery"],
      },
      func: async (args) => args,
    }
  ];
}


// --- TEMPLATED QUERIES  ---

export function getSalesForArtist(artistName) {
  return `
    SELECT
      ar.Name AS ArtistName,
      SUM(ii.UnitPrice * ii.Quantity) AS TotalSales
    FROM artists ar
    JOIN albums al ON ar.ArtistId = al.ArtistId
    JOIN tracks t ON al.AlbumId = t.AlbumId
    JOIN invoice_items ii ON t.TrackId = ii.TrackId
    WHERE ar.Name = '${artistName}'
    GROUP BY ar.Name;
  `;
}

export function getTopTracksInGenre(genreName, limit) {
  return `
    SELECT
      t.Name AS TrackName,
      g.Name AS GenreName,
      SUM(ii.Quantity) AS UnitsSold
    FROM genres g
    JOIN tracks t ON g.GenreId = t.GenreId
    JOIN invoice_items ii ON t.TrackId = ii.TrackId
    WHERE g.Name = '${genreName}'
    GROUP BY t.Name, g.Name
    ORDER BY UnitsSold DESC
    LIMIT ${limit};
  `;
}