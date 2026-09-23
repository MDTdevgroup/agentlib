import { createListTablesTool } from "./list-tables.js";
import { createGetSchemaTool } from "./get-schema.js";
import { createRunQueryTool } from "./run-query.js";
import { createFindSalesForArtistTool } from "./find-sales-for-artist.js";
import { createFindTopTracksInGenreTool } from "./find-top-tracks-in-genre.js";
import { createGenerateCustomSqlQueryTool } from "./generate-custom-sql-query.js";

/**
 * Tools for the SQL Generator Agent (discovers schema).
 *
 * @param {object} db - Connected database client.
 * @returns {Array<object>} Fused tool definitions.
 */
export function generatorTools(db) {
    return [
        createListTablesTool(db),
        createGetSchemaTool(db),
    ];
}

/**
 * Tools for the SQL Executor Agent (schema discovery + query execution).
 *
 * @param {object} db - Connected database client.
 * @returns {Array<object>} Fused tool definitions.
 */
export function executorTools(db) {
    return [
        ...generatorTools(db),
        createRunQueryTool(db),
    ];
}

/**
 * Tools for the Main Router Agent (templated queries + generator delegation fallback).
 *
 * @param {object} db - Connected database client.
 * @returns {Array<object>} Fused tool definitions.
 */
export function mainAgentTools(db) {
    return [
        createFindSalesForArtistTool(db),
        createFindTopTracksInGenreTool(db),
        createGenerateCustomSqlQueryTool(db),
    ];
}
