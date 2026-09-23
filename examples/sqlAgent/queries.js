/**
 * Constructs a SQL query for calculating total sales for a given artist.
 *
 * NOTE: String interpolation of artistName is used here for demonstration purposes.
 * Production applications should use parameterized queries to prevent SQL injection.
 *
 * @param {string} artistName
 * @returns {string}
 */
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

/**
 * Constructs a SQL query for finding top tracks sold in a genre.
 *
 * @param {string} genreName
 * @param {number} limit
 * @returns {string}
 */
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
