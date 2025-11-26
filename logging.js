/*
(c) 2024 Tyler Granzow - Apache License 2.0

This file simply is a logger to log messages to the service.log file.
The file is capped at 10,000 lines to prevent it from growing too large.

*/

// Import
const fs = require('node:fs');

// Function to log messages asynchronously
function nosyncLog(message) {
    // Convert to EST and format date
    const date = new Date();
    const estDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const formattedDate = estDate.toLocaleString('en-US', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const logMessage = `[${formattedDate} EST] ${message}\n`;

    // Read existing logs
    try {
        const existingLogs = fs.existsSync('service.log')
            ? fs.readFileSync('service.log', 'utf8')
            : '';

        // Split logs into lines and keep only the latest 9999 lines
        let logLines = existingLogs.split('\n');
        if (logLines.length > 9999) {
            logLines = logLines.slice(0, 9999);
        }

        // Prepend new message and join lines back together
        fs.writeFileSync('service.log', logMessage + logLines.join('\n'));
    } catch (err) {
        console.error('Error writing to log file:', err);
        console.log('Original message:', message);
    }
}

async function log(message) {
    // Convert to EST and format date
    const date = new Date();
    const estDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const formattedDate = estDate.toLocaleString('en-US', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const logMessage = `[${formattedDate} EST] ${message}\n`;

    // Read existing logs
    try {
        const existingLogs = fs.existsSync('service.log')
            ? fs.readFileSync('service.log', 'utf8')
            : '';

        // Split logs into lines and keep only the latest 999 lines
        let logLines = existingLogs.split('\n');
        if (logLines.length > 999) {
            logLines = logLines.slice(0, 999);
        }

        // Prepend new message and join lines back together
        fs.writeFileSync('service.log', logMessage + logLines.join('\n'));
    } catch (err) {
        console.error('Error writing to log file:', err);
        console.log('Original message:', message);
    }
}

// Export the nosyncLog function
module.exports = {
    nosyncLog, log
};