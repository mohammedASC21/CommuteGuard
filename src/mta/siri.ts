import type { ObservationBatch, QueryMode, StopCall, VehicleObservation } from './types.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;
const time = (value: unknown): string | undefined => {
  const s = text(value);
  return s && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s)) ? s : undefined;
};
const number = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;

function label(value: unknown, separator: string, issues: string[], field: string): string | undefined {
  if (value === undefined) return undefined;
  if (text(value)) return text(value);
  if (Array.isArray(value) && value.length && value.every(v => text(v) !== undefined)) return value.join(separator);
  issues.push(`INVALID_${field}`);
  return undefined;
}

function distance(primary: unknown, legacy: unknown, issues: string[], field: string): number | undefined {
  const a = number(primary, 0, Infinity);
  const b = number(legacy, 0, Infinity);
  if (primary !== undefined && a === undefined) issues.push(`INVALID_${field}`);
  if (legacy !== undefined && b === undefined) issues.push(`INVALID_LEGACY_${field}`);
  if (a !== undefined && b !== undefined && a !== b) {
    issues.push(`CONFLICTING_${field}`);
    return undefined;
  }
  return primary !== undefined ? a : b;
}

function call(raw: unknown, issues: string[]): StopCall {
  const c = object(raw);
  const distances = object(object(c.Extensions).Distances);
  const result: StopCall = {
    staticReference: { stopId: text(c.StopPointRef), stopName: label(c.StopPointName, ' / ', issues, 'StopPointName'),
      scheduledArrival: time(c.AimedArrivalTime), scheduledDeparture: time(c.AimedDepartureTime) },
    realtimePrediction: {
      expectedArrival: time(c.ExpectedArrivalTime), expectedDeparture: time(c.ExpectedDepartureTime),
      distanceFromStopMeters: distance(c.DistanceFromStop, distances.DistanceFromCall, issues, 'DistanceFromStop'),
      stopsFromCall: distance(c.NumberOfStopsAway, distances.StopsFromCall, issues, 'NumberOfStopsAway'),
    },
  };
  if (!result.staticReference.stopId) issues.push('MISSING_OR_INVALID_STOP_ID');
  for (const key of ['ExpectedArrivalTime', 'ExpectedDepartureTime', 'AimedArrivalTime', 'AimedDepartureTime'] as const) {
    if (c[key] !== undefined && !time(c[key])) issues.push(`INVALID_${key}`);
  }
  for (const key of ['DistanceFromCall', 'StopsFromCall'] as const) {
    if (distances[key] !== undefined && number(distances[key], 0, Infinity) === undefined) issues.push(`INVALID_${key}`);
  }
  return result;
}

/** Parse untrusted JSON. Reject bad envelopes; keep partial candidates with explicit issues. */
export function parseSiri(raw: unknown, context: QueryMode): ObservationBatch {
  const service = object(object(object(raw).Siri).ServiceDelivery);
  if (!Object.keys(service).length) throw new Error('MTA_INVALID_ENVELOPE');
  if (service.ErrorCondition !== undefined || service.Status === false) throw new Error('MTA_SERVICE_ERROR');
  const deliveries = service[context === 'vehicle' ? 'VehicleMonitoringDelivery' : 'StopMonitoringDelivery'];
  if (!Array.isArray(deliveries) || !deliveries.length) throw new Error('MTA_MISSING_DELIVERY');
  const batch: ObservationBatch = {
    source: 'mta-bus-time-siri', context, responseTimestamp: time(service.ResponseTimestamp),
    deliveries: [], observations: [], issues: [],
  };
  if (!batch.responseTimestamp) batch.issues.push('MISSING_OR_INVALID_RESPONSE_TIMESTAMP');
  for (const delivery of deliveries) {
    const d = object(delivery);
    if (d.ErrorCondition !== undefined || d.Status === false) throw new Error('MTA_SERVICE_ERROR');
    if (!Object.keys(d).length) throw new Error('MTA_INVALID_DELIVERY');
    batch.deliveries.push({ responseTimestamp: time(d.ResponseTimestamp), validUntil: time(d.ValidUntil) });
    if (!time(d.ResponseTimestamp)) batch.issues.push('MISSING_OR_INVALID_DELIVERY_TIMESTAMP');
    if (!time(d.ValidUntil)) batch.issues.push('MISSING_OR_INVALID_VALID_UNTIL');
    const activities = d[context === 'vehicle' ? 'VehicleActivity' : 'MonitoredStopVisit'];
    if (activities === undefined) {
      batch.issues.push('NO_ACTIVITY_FIELD');
      continue;
    }
    if (!Array.isArray(activities)) throw new Error('MTA_INVALID_ACTIVITY_LIST');
    for (const activity of activities) {
      const a = object(activity);
      const j = object(a.MonitoredVehicleJourney);
      const frame = object(j.FramedVehicleJourneyRef);
      const location = object(j.VehicleLocation);
      const issues: string[] = [];
      const o: VehicleObservation = {
        source: 'mta-bus-time-siri', context,
        vehicleId: text(j.VehicleRef), tripId: text(frame.DatedVehicleJourneyRef),
        serviceDate: text(frame.DataFrameRef), routeId: text(j.LineRef), timestamp: time(a.RecordedAtTime),
        latitude: number(location.Latitude, -90, 90), longitude: number(location.Longitude, -180, 180),
        progressRate: text(j.ProgressRate), progressStatus: label(j.ProgressStatus, ',', issues, 'ProgressStatus'), blockId: text(j.BlockRef),
        staticAssignment: {
          directionId: text(j.DirectionRef), destinationId: text(j.DestinationRef),
          destinationName: label(j.DestinationName, ' / ', issues, 'DestinationName'), originScheduledDeparture: time(j.OriginAimedDepartureTime),
        },
        onwardCalls: [], issues,
      };
      for (const field of ['vehicleId', 'tripId', 'serviceDate', 'routeId', 'timestamp', 'latitude', 'longitude'] as const) {
        if (o[field] === undefined) issues.push(`MISSING_OR_INVALID_${field}`);
      }
      if (j.OriginAimedDepartureTime !== undefined && !o.staticAssignment.originScheduledDeparture) issues.push('INVALID_SCHEDULED_DEPARTURE');
      if (j.MonitoredCall !== undefined) o.monitoredCall = call(j.MonitoredCall, issues);
      else issues.push('MISSING_MONITORED_CALL');
      const onward = object(j.OnwardCalls).OnwardCall;
      if (onward !== undefined) {
        if (!Array.isArray(onward)) issues.push('INVALID_ONWARD_CALLS');
        else o.onwardCalls = onward.map(c => call(c, issues));
      }
      batch.observations.push(o);
    }
  }
  if (!batch.observations.length) batch.issues.push('NO_CANDIDATES');
  return batch;
}
