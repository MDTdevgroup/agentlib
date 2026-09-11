import { defineTool, withValidation } from "../../../index.js";

export const runQueryDeclaration = {
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
};

/**
 * Validates that the input query is a non-empty string.
 *
 * NOTE: Checking that query is a string validates argument shape, but does NOT authorize
 * the query or prevent SQL injection. In this demonstration example, model-generated queries
 * are executed against SQLite directly. Production applications should apply authorization,
 * query analysis, read-only DB permissions, or prepared statements.
 */
function validateRunQueryArgs(args) {
    if (!args || typeof args.query !== 'string' || !args.query.trim()) {
        throw new Error('Tool "run_query" requires a non-empty string "query" parameter');
    }
    return { query: args.query.trim() };
}

export async function runQuery(db, { query }, _context) {
    const rows = await db.all(query);
    return rows;
}

export function createRunQueryTool(db) {
    return defineTool(
        runQueryDeclaration,
        withValidation(validateRunQueryArgs, (args, context) => runQuery(db, args, context))
    );
}
