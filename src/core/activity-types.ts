import type { RouteResult, EdgeLoadReport } from './types.js';
export type DayType = 'weekday' | 'weekend';
export type TripPurpose = 'work' | 'school' | 'shopping' | 'park' | 'clinic';
export interface ActivityInput {
  hour: number;
  dayType: DayType;
  includeRoutes?: boolean;
}
export interface ActivityRoute {
  purpose: TripPurpose;
  direction: 'outbound' | 'homeward';
  objectId: string;
  tripsPerHour: number;
  expectedOnNetwork: number;
  route: RouteResult;
}
export interface ActivitySnapshot {
  hour: number;
  dayType: DayType;
  profileId: string;
  population: number;
  plannedTrips: number;
  servedTrips: number;
  unservedTrips: number;
  expectedOnNetwork: number;
  purposes: { id: TripPurpose; outbound: number; homeward: number; unserved: number; onNetwork: number }[];
  routes: ActivityRoute[];
  objects: { id: string; name: string; kind: string; capacity: number | null }[];
  loads: {
    unit: 'pedestrian-trips-per-hour';
    maxLoad: number;
    edgeTraversals: number;
    edges: EdgeLoadReport['edges'];
  };
  assumptions: string[];
}

export interface ActivityRouteChange {
  key: string;
  purpose: TripPurpose;
  direction: 'outbound' | 'homeward';
  buildingId: string;
  objectBeforeId: string | null;
  objectAfterId: string | null;
  tripsBefore: number;
  tripsAfter: number;
  onNetworkBefore: number;
  onNetworkAfter: number;
  distanceBeforeM: number | null;
  distanceAfterM: number | null;
  secondsBefore: number | null;
  secondsAfter: number | null;
  distanceDeltaM: number | null;
  secondsDelta: number | null;
  shorter: boolean;
  longer: boolean;
  newRoute: boolean;
  lostRoute: boolean;
}

export interface ActivityEdgeChange {
  edgeId: string;
  loadBefore: number;
  loadAfter: number;
  delta: number;
  forwardBefore: number;
  forwardAfter: number;
  backwardBefore: number;
  backwardAfter: number;
  eligibleBefore: boolean;
  eligibleAfter: boolean;
}

export interface ActivityObjectLoad {
  objectId: string;
  name: string;
  kind: string;
  capacity: number | null;
  tripsBefore: number;
  tripsAfter: number;
  onNetworkBefore: number;
  onNetworkAfter: number;
  loadPercentBefore: number | null;
  loadPercentAfter: number | null;
}

export interface NormativeCheck {
  objectId: string;
  objectName: string;
  kind: string;
  title: string;
  source: string;
  sourceUrl: string;
  limit: number;
  unit: 'm';
  tripsBefore: number;
  tripsAfter: number;
  withinBefore: number;
  withinAfter: number;
  withinPercentBefore: number | null;
  withinPercentAfter: number | null;
  capacity: number | null;
  capacityLoadPercentAfter: number | null;
  applicability: string;
  caveat: string;
}

export interface ActivityComparison {
  before: ActivitySnapshot;
  after: ActivitySnapshot;
  summary: {
    populationBefore: number;
    populationAfter: number;
    plannedTripsBefore: number;
    plannedTripsAfter: number;
    servedTripsBefore: number;
    servedTripsAfter: number;
    newlyServedTrips: number;
    newlyServedPeople: number;
    shorterRouteTrips: number;
    shorterRoutePeople: number;
    longerRouteTrips: number;
    meanDistanceBeforeM: number | null;
    meanDistanceAfterM: number | null;
    meanDistanceDeltaM: number | null;
    meanSecondsBefore: number | null;
    meanSecondsAfter: number | null;
    meanSecondsDelta: number | null;
  };
  routes: ActivityRouteChange[];
  edges: ActivityEdgeChange[];
  objects: ActivityObjectLoad[];
  normative: NormativeCheck[];
  assumptions: string[];
}
