/** These are diagnostics, never a reliability decision. Missing fields remain missing. */
export type QueryMode = 'vehicle' | 'stop';
export interface StopCall {
  staticReference: { stopId?: string; stopName?: string; scheduledArrival?: string; scheduledDeparture?: string };
  realtimePrediction: {
    expectedArrival?: string;
    expectedDeparture?: string;
    distanceFromStopMeters?: number;
    stopsFromCall?: number;
  };
}
export interface VehicleObservation {
  source: 'mta-bus-time-siri';
  context: QueryMode;
  vehicleId?: string;
  tripId?: string;
  serviceDate?: string;
  routeId?: string;
  /** RecordedAtTime, never substituted with server/fetch time. */
  timestamp?: string;
  /** MTA describes coordinates as recorded OR inferred. */
  latitude?: number;
  longitude?: number;
  progressRate?: string;
  progressStatus?: string;
  blockId?: string;
  staticAssignment: {
    directionId?: string;
    destinationId?: string;
    destinationName?: string;
    originScheduledDeparture?: string;
  };
  monitoredCall?: StopCall;
  onwardCalls: StopCall[];
  issues: string[];
}
export interface ObservationBatch {
  source: 'mta-bus-time-siri';
  context: QueryMode;
  responseTimestamp?: string;
  deliveries: { responseTimestamp?: string; validUntil?: string }[];
  observations: VehicleObservation[];
  issues: string[];
}
