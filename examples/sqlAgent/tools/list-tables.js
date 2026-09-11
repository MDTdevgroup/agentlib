import { defineTool } from "../../../index.js";

export const listTablesDeclaration = {
    type: "function",
    name: "list_tables",
    description: "List available tables in the database",
    parameters: {
        type: "object",
        properties: {},
        required: [],
    },
};

export async function listTables(db, _args, _context) {
    const rows = await db.all("SELECT name FROM sqlite_master WHERE type='table';");
    return rows.map(r => r.name);
}

export function createListTablesTool(db) {
    return defineTool(listTablesDeclaration, (args, context) => listTables(db, args, context));
}
