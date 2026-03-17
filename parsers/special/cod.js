// File to parse coded analysis products "COD" into GeoJSON format
// These contain information of frontal boundaries and high and low pressure centers

export default function parseCOD(lines) {
    const features = [];

    const sectionPrefixes = new Set(['HIGHS', 'LOWS', 'OCFNT', 'COLD', 'WARM', 'TROF', 'STNRY']);
    let activeSection = null;
    let pendingPressure = null;

    function parseLatLon(token) {
        if (!/^\d{6,7}$/.test(token)) {
            return null;
        }

        const lat = parseInt(token.slice(0, 3), 10) / 10;
        const lon = -(parseInt(token.slice(3), 10) / 10);

        if (Number.isNaN(lat) || Number.isNaN(lon)) {
            return null;
        }

        return [lon, lat];
    }

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine === '$$') {
            continue;
        }

        const lineParts = trimmedLine.split(/\s+/);
        const firstToken = lineParts[0];

        let tokens;
        if (sectionPrefixes.has(firstToken)) {
            activeSection = firstToken;
            tokens = lineParts.slice(1);

            if (activeSection !== 'HIGHS' && activeSection !== 'LOWS') {
                pendingPressure = null;
            }
        } else {
            tokens = lineParts;
        }

        if (!activeSection) {
            continue;
        }

        // Check for high pressure centers
        if (activeSection === 'HIGHS' || activeSection === 'LOWS') {
            let index = 0;

            if (pendingPressure !== null && tokens.length > 0) {
                const coords = parseLatLon(tokens[0]);
                if (coords) {
                    features.push({
                        type: 'Feature',
                        properties: { type: activeSection === 'HIGHS' ? 'high' : 'low', pressure: pendingPressure },
                        geometry: {
                            type: 'Point',
                            coordinates: coords
                        }
                    });
                    index = 1;
                }
                pendingPressure = null;
            }

            for (; index < tokens.length; index += 2) {
                const pressureToken = tokens[index];
                const coordinateToken = tokens[index + 1];
                const pressure = parseInt(pressureToken, 10);

                if (Number.isNaN(pressure)) {
                    continue;
                }

                if (!coordinateToken) {
                    pendingPressure = pressure;
                    break;
                }

                const coords = parseLatLon(coordinateToken);
                if (!coords) {
                    continue;
                }

                features.push({
                    type: 'Feature',
                    properties: { type: activeSection === 'HIGHS' ? 'high' : 'low', pressure },
                    geometry: {
                        type: 'Point',
                        coordinates: coords
                    }
                });
            }

            continue;
        }

        // Check for frontal boundaries (e.g., OCFNT, COLD, WARM, STNRY, TROF)
        if (['OCFNT', 'COLD', 'WARM', 'STNRY', 'TROF'].includes(activeSection)) {
            const coordinates = [];
            for (const token of tokens) {
                const coords = parseLatLon(token);
                if (coords) {
                    coordinates.push(coords);
                }
            }

            if (coordinates.length >= 2) {
                features.push({
                    type: 'Feature',
                    properties: { type: activeSection.toLowerCase() },
                    geometry: {
                        type: 'LineString',
                        coordinates
                    }
                });
            }
        }
    }

    return {
        type: 'FeatureCollection',
        features
    };
}


/*

EXAMPLE COD PRODUCT

992
ASUS02 KWBC 171500
CODSUS

CODED SURFACE FRONTAL POSITIONS
NWS WEATHER PREDICTION CENTER COLLEGE PARK MD
1232 PM EDT TUE MAR 17 2026

VALID 031715Z
HIGHS 1022 3611306 1031 3340912 1024 3901073 1026 4441170 1027 4201207 1022
6350928 1021 6860622 1026 4021155 1030 2840972
LOWS 961 5430704 974 5821450 1008 7791493 995 5641252 993 5591111 1012 3321184
1011 2921120 982 4980651
OCFNT 5440707 5450696 5430688
COLD 5440687 5270667 5110658 5030653
STNRY 1700959 1870975 2011001 2181012 2391018
WARM 5440688 5460667 5420631 5360592 5260546 5150520 5000501 4840491 4780488
TROF 6090492 6000436 6060357 6030269
OCFNT 5851453 5931421 5891346 5821301 5751277 5641252
COLD 5641252 5451263 5251284 4941327 4791360
STNRY 4791360 4661389 4561413 4501430
TROF 5741449 5561455 5361473 5251488 5141506
STNRY 5571113 5511166 5521207 5621237 5641252
WARM 5591110 5421074 4821037 4531024 4171018 3851007 3680992 3600975 3530961
TROF 4170777 3960777 3740789 3540817 3430844
COLD 5090716 4890729 4680746 4520765 4380796 4320824
TROF 4670795 4600818 4580859 4620888 4710918
TROF 4431064 4241081 4091108
TROF 3941028 3751033 3531048 3341065
TROF 5961472 6231512 6471538
TROF 7791486 7541457 7221458 7041478 6901499
TROF 7801495 7931504 8061493
TROF 6011329 6201327 6401323 6551319
TROF 5500705 5860689 6190659
TROF 5691107 5941113 6251107 6701051
TROF 5261133 5011125 4721129 4611133
TROF 5411240 5201222 4951200 4701190 4511189
TROF 3911233 3571215 3311183
TROF 3691154 3271139 2921120
TROF 2921121 2701106 2321081 2001057 1821041
TROF 5410709 5330739 5310786 5370843 5410873
COLD 4970651 4860654 4610668 4470662 4230659 3990669 3450707 2800759 2470799
2120854 1830904 1600943
WARM 4980651 5010652 5030653

$$

*/