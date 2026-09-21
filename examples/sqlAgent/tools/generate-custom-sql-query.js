import { defineTool } from "../../../index.js";

export const generateCustomSqlQueryDeclaration = {
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
};

export async function generateCustomSqlQuery(_db, args, { signal } = {}) {
    signal?.throwIfAborted?.();
    return args;
}

export function createGenerateCustomSqlQueryTool(db) {
    return defineTool(
        generateCustomSqlQueryDeclaration,
        (args, context) => generateCustomSqlQuery(db, args, context)
    );
}
