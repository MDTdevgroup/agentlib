import { defineTool } from "../../../index.js";

export const getSchemaDeclaration = {
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
};

/**
 * Gets table schema via PRAGMA table_info.
 *
 * NOTE: SQLite drivers do not support query-level cancellation via AbortSignal.
 * Checking signal?.throwIfAborted?.() guarantees cooperative cancellation before
 * initiating database work.
 */
export async function getSchema(db, { table }, { signal } = {}) {
    signal?.throwIfAborted?.();
    const safe = String(table).replace(/'/g, "''");
    const schema = await db.all(`PRAGMA table_info('${safe}');`);
    return schema;
}

export function createGetSchemaTool(db) {
    return defineTool(getSchemaDeclaration, (args, context) => getSchema(db, args, context));
}
