// Print presence only. Never print values, lengths, prefixes, or environment dumps.
const available = Boolean(process.env.MTA_BUS_TIME_API_KEY?.trim());
console.log(`MTA_BUS_TIME_API_KEY available server-side: ${available}`);
if (!available) process.exitCode = 1;
