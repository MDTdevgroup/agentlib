import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { Agent } from "../../src/Agent.js";
import { ToolLoader } from "../../src/ToolLoader.js";
import { z } from 'zod';

/**
 * Initializes the SQLite database.
 * 
 * @param {string} dbPath - The path to the SQLite DB file.
 * @returns {Promise<sqlite3.Database>} The database connection.
 */
export async function initDB(dbPath = "./chinook.db") {
    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database,
    });
    return db;
}

/**
 * Returns the basic database interaction tools.
 * 
 * @param {sqlite3.Database} db - The active database connection.
 * @returns {Array} List of tool definitions.
 */
export function getDbTools(db) {
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
                const rows = await db.all(query);
                return rows;
            },
        }
    ];
}

/**
 * Returns the tool definitions for the Main (Router) Agent.
 * Includes specific analytical tools and the generic SQL generator tool.
 * 
 * @param {sqlite3.Database} db 
 * @param {LLMService} llmService 
 * @param {PromptLoader} promptLoader 
 * @returns {Array} List of tool definitions.
 */
export function mainAgentTools(db, llmService, promptLoader) {
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
            description: "Use this tool to generate and execute a custom SQL query for complex questions that are not covered by other tools.",
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
            func: async ({ naturalLanguageQuery }) => {
                // Initialize the Generator Agent as a sub-routine
                return runGeneratorAgent(db, llmService, promptLoader, naturalLanguageQuery);
            }
        }
    ];
}

/**
 * Orchestrates the Generator Agent.
 * This agent explores the schema and uses the Executor Agent to run queries.
 */
async function runGeneratorAgent(db, llmService, promptLoader, query) {
    console.log(`\n[GeneratorAgent] Starting task: "${query}"`);

    const generatorTools = new ToolLoader();

    // Generator has access to schema tools but NOT direct query execution
    const schemaTools = getDbTools(db).filter(t => t.name !== 'run_query');
    generatorTools.addTools(schemaTools);

    // Generator has access to the Executor Agent as a tool
    generatorTools.addTools([executorAgentTool(db, llmService, promptLoader)]);

    const generatorAgent = new Agent(llmService, {
        toolLoader: generatorTools,
    });

    generatorAgent.addInput({
        role: "system",
        content: promptLoader.getPrompt("sql_generator_sys_prompt").format()
    });

    generatorAgent.addInput({
        role: "user",
        content: query
    });

    let result = "Failed to generate query.";

    for (let i = 0; i < 15; i++) {
        const step = await generatorAgent.run();

        // Log tool usage
        if (step.executed && step.executed.length > 0) {
            step.executed.forEach(tool => {
                console.log(`[GeneratorAgent] Call: ${tool.name} `);
            });
        }

        // Check for completion
        // If the agent returns text without NEW function calls, we consider it done
        const hasPendingToolCalls = step.rawResponse.output.some(item => item.type === "function_call");
        if (!hasPendingToolCalls && step.output) {
            console.log(`[GeneratorAgent] Finished.`);
            result = step.output;
            break;
        }
    }

    return result;
}

/**
 * Defines the Executor Agent tool.
 * This agent validates and executes the SQL query.
 */
function executorAgentTool(db, llmService, promptLoader) {
    return {
        type: "function",
        name: "execute_sql_query",
        description: "Executes a SQL query after validating it. Returns the results and an explanation.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The SQL query to execute",
                },
            },
            required: ["query"],
        },
        func: async ({ query }) => {
            return runExecutorAgent(db, llmService, promptLoader, query);
        }
    };
}

/**
 * Orchestrates the Executor Agent.
 */
async function runExecutorAgent(db, llmService, promptLoader, query) {
    console.log(`\n  [ExecutorAgent] Validating and executing query...`);

    const executorTools = new ToolLoader();
    // Executor has full DB access
    executorTools.addTools(getDbTools(db));

    const executorOutputSchema = z.object({
        sql_output: z.array(
            z.array(
                z.object({
                    column: z.string(),
                    value: z.union([z.string(), z.number(), z.null()]),
                })
            )
        ).describe("The raw results from the SQL query execution"),
        explanation_summary: z.string().describe("A clear explanation of the query and summary of findings")
    });

    const executorAgent = new Agent(llmService, {
        toolLoader: executorTools,
        outputSchema: executorOutputSchema
    });

    executorAgent.addInput({
        role: "system",
        content: promptLoader.getPrompt("sql_executor_sys_prompt").format()
    });

    executorAgent.addInput({
        role: "user",
        content: `Validate and then execute this SQL query: ${query}`
    });

    let finalResult = null;
    for (let i = 0; i < 10; i++) {
        const step = await executorAgent.run();

        if (step.executed && step.executed.length > 0) {
            step.executed.forEach(tool => {
                console.log(`  [ExecutorAgent] Call: ${tool.name}`);
            });
        }

        if (step.output && step.output.sql_output) {
            finalResult = step.output;
            console.log(`  [ExecutorAgent] Execution successful.`);
            break;
        }
    }

    return JSON.stringify(finalResult, null, 2);
}

// --- Parameterized SQL Queries ---

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
