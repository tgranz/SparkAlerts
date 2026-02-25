/*
Coordinate Extraction Utilities

Functions for extracting and parsing coordinates from NWS alert messages.
*/

/**
 * Extract coordinates from LAT...LON format or decimal coordinate pairs
 * @param {string} rawText - Alert message text
 * @param {Array} capCoordinates - Optional coordinates from CAP XML
 * @returns {Array|null} Array of [lat, lon] pairs or null if no coordinates found
 */
function extractCoordinates(rawText, capCoordinates = null) {
    let coordinates = [];
    
    // Try LAT...LON format first
    const latLonMatch = rawText.match(/LAT\.\.\.LON\s+([\d\s]+)/);
    
    if (latLonMatch) {
        const nums = latLonMatch[1].trim().split(/\s+/);
        console.log(`Extracted ${nums.length / 2} coordinate pairs from LAT...LON`);
        
        for (let i = 0; i < nums.length; i += 2) {
            const latStr = nums[i];
            const lonStr = nums[i + 1];
            
            // Handle both 4-digit and 5-digit longitude formats
            const lat = parseFloat(latStr.slice(0, 2) + '.' + latStr.slice(2));
            const lonInt = lonStr.length === 5 ? lonStr.slice(0, 3) : lonStr.slice(0, 2);
            const lonDec = lonStr.length === 5 ? lonStr.slice(3) : lonStr.slice(2);
            const lon = -parseFloat(lonInt + '.' + lonDec);
            
            coordinates.push({lat, lon});
        }
        
        // Standardize coordinates to [[lat, lon], ...]
        if (Array.isArray(coordinates)) {
            const standardCoordinates = coordinates
                .map(item => {
                    // handle already-array form [lat, lon]
                    if (Array.isArray(item) && item.length >= 2) {
                        return [Number(item[0]), Number(item[1])];
                    }
                    // handle object form {lat, lon}
                    if (item && typeof item === 'object' && 'lat' in item && 'lon' in item) {
                        return [Number(item.lat), Number(item.lon)];
                    }
                    return null;
                })
                .filter(pair => pair && isFinite(pair[0]) && isFinite(pair[1]));
            
            coordinates = standardCoordinates;
        }
    } else {
        // Try extracting decimal coordinate pairs (e.g., "40.85,-124.07 40.84,-124.06" or space-separated pairs like "41.05 -100.22 41.04 -99.02")
        // This regex handles both comma-separated and space-separated coordinates
        const decPairRe = /(-?\d{1,2}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/g;
        let m;
        const decCoords = [];
        
        while ((m = decPairRe.exec(rawText)) !== null) {
            const lat = parseFloat(m[1]);
            const lon = parseFloat(m[2]);
            if (isFinite(lat) && isFinite(lon)) {
                decCoords.push([lat, lon]);
            }
        }
        
        if (decCoords.length > 0) {
            coordinates = decCoords;
            console.log(`Extracted ${decCoords.length} decimal coordinate pairs from message text`);
        } else {
            coordinates = null;
        }
    }
    
    // Only use capCoordinates as a fallback if absolutely nothing found in text
    // This prevents CAP polygon coordinates from overwriting message coordinates
    if ((!coordinates || coordinates.length === 0) && Array.isArray(capCoordinates) && capCoordinates.length > 0) {
        coordinates = capCoordinates;
        console.log(`Using ${capCoordinates.length} coordinate pairs from CAP geometry as fallback`);
    }
    
    return coordinates;
}

/**
 * Create GeoJSON Polygon geometry from coordinate pairs
 * @param {Array} coordinates - Array of [lat, lon] pairs
 * @returns {Object|null} GeoJSON Polygon geometry or null
 */
function createPolygonGeometry(coordinates) {
    if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 3) {
        return null;
    }
    
    // Convert [lat, lon] pairs to [lon, lat] for GeoJSON format
    const geoJsonCoords = coordinates.map(pair => [pair[1], pair[0]]);
    
    // Close the polygon if not already closed
    const first = geoJsonCoords[0];
    const last = geoJsonCoords[geoJsonCoords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        geoJsonCoords.push([...first]);
    }
    
    return {
        type: 'Polygon',
        coordinates: [geoJsonCoords]
    };
}

module.exports = {
    extractCoordinates,
    createPolygonGeometry
};
