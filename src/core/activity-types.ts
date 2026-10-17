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
  loads: {
    unit: 'pedestrian-trips-per-hour';
    maxLoad: number;
    edgeTraversals: number;
    edges: EdgeLoadReport['edges'];
  };
  assumptions: string[];
}
