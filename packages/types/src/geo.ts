/** WGS84 lat/lng. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** Encoded polyline (Google polyline algorithm). */
export type EncodedPolyline = string;

export interface BoundingBox {
  sw: LatLng;
  ne: LatLng;
}
