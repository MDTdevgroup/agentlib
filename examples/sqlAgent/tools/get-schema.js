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

export async function getSchema(db, { table }, _context) {
    const safe = String(table).replace(/'/g, "''");
    const schema = await db.all(`PRAGMA table_info('${safe}');`);
    return schema;
}

export function createGetSchemaTool(db) {
    return defineTool(getSchemaDeclaration, (args, context) => getSchema(db, args, context));
}
