# Test fixtures

Fixtures are offline inputs, never current transit information or active commute configuration. No credential or authenticated request URL is retained. Real captures preserve source values; gzip is storage compression only. The full automated suite reads fixtures here, not from a development experiment archive.

| Fixture | Purpose / provenance |
| --- | --- |
| `siri-vm.synthetic.json` | Invented documentation-shaped VM parser input; no live evidence |
| `reliability/current-trip.ts` | Explicitly synthetic normalized current-trip data; includes historical Bx10/origin configuration for generic regression tests |
| `bx10-vm-v2.sanitized.json.gz` | Real October 20, 2026 VM response: v2 array labels/distances and malformed/conflicting-field regressions |
| `bx10-sm-v2.sanitized.json.gz` | Real October 20, 2026 SM response: previous-trip/layover and v2 stop-call parsing |
| `bx10-stops.sanitized.json.gz` | Official Bus Time OneBusAway discovery snapshot used to verify historical stop order/direction |
| `bx10-terminal-history.sanitized.json.gz` | Full required 30-pair normalized historical experiment, October 20, 2026 about 1:15–1:31 PM New York: vehicle 9851's temporary assignment, disappearance, layover and previous-trip regression, including every prefix |
| `siri-vm-commute.sanitized.json.gz`, `siri-sm-commute.sanitized.json.gz` | Real first VM/SM pair of that terminal experiment, about 1:15:40 PM New York; protects separate current/stop journey context |
| `bx28-stops.sanitized.json` | Official October 20, 2026 Bx28 stop discovery: boarding 103617 precedes alighting 100080 on direction-1 Fordham trips |
| `bx28-static-branches.sanitized.json` | Compact official static-feed audit of eligible Fordham stop-order variants and shorter excluded branches |

The **historical Bx10** target was stop 103620, direction 0, an origin. These values remain only to protect regression behavior; the active application is **Bx28 / 103617 / direction 1 / intermediate stop**. The full terminal sequence must not be discarded or trimmed just to reduce file count: it protects against falsely treating one temporary assignment or a previous trip as verified boarding service.

Six inputs previously stored among development documents were relocated here during cleanup. Their decoded contents are unchanged; the VM/SM/discovery JSON inputs were compressed. Other experiment snapshots, duplicate source copies and one-off reports were removed after test references were updated.

Sources: [official SIRI VM](https://bustime.mta.info/developers/siri/vehicle-monitoring), [SM](https://bustime.mta.info/developers/siri/stop-monitoring), [journey field documentation](https://bustime.mta.info/developers/siri/monitored-vehicle-journey), [official static/discovery API](https://bustime.mta.info/developers/restful-api), [Bronx GTFS](https://rrgtfsfeeds.s3.amazonaws.com/gtfs_bx.zip). No new live collection is needed to run these tests.
