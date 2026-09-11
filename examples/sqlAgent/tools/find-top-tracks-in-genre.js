import { defineTool } from "../../../index.js";
import { getTopTracksInGenre } from "../queries.js";

export const findTopTracksInGenreDeclaration = {
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
};

export async function findTopTracksInGenre(db, { genreName, limit }, _context) {
    const generatedQuery = getTopTracksInGenre(genreName, limit);
    const rows = await db.all(generatedQuery);
    return rows;
}

export function createFindTopTracksInGenreTool(db) {
    return defineTool(
        findTopTracksInGenreDeclaration,
        (args, context) => findTopTracksInGenre(db, args, context)
    );
}
