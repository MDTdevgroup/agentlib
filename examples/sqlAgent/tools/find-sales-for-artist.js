import { defineTool } from "../../../index.js";
import { getSalesForArtist } from "../queries.js";

export const findSalesForArtistDeclaration = {
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
};

/**
 * Finds sales for a specific artist.
 *
 * NOTE: SQLite drivers do not support query-level cancellation via AbortSignal.
 * Checking signal?.throwIfAborted?.() guarantees cooperative cancellation before
 * initiating database work.
 */
export async function findSalesForArtist(db, { artistName }, { signal } = {}) {
    signal?.throwIfAborted?.();
    const generatedQuery = getSalesForArtist(artistName);
    const rows = await db.all(generatedQuery);
    return rows;
}

export function createFindSalesForArtistTool(db) {
    return defineTool(
        findSalesForArtistDeclaration,
        (args, context) => findSalesForArtist(db, args, context)
    );
}
