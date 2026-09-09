-- Build Brief v2 Phase 5 (§5.3): "nearest-asset suggestion from GPS" needs a
-- one-time affine calibration from real-world GPS to campmap.webp
-- image-pixel space (assets already carry map_x/map_y — migration 0027).
-- Stored as three reference points (label/lat/lng/map_x/map_y) rather than a
-- precomputed matrix so admin can add/edit/replace a point from the map UI
-- and have the transform recompute live — three non-collinear points is the
-- minimum and the expected count; the app computes the affine transform in
-- JS from whatever points exist (see mapCalibration in db.js).
CREATE TABLE map_calibration_points (
  id       serial PRIMARY KEY,
  label    text NOT NULL,
  lat      double precision NOT NULL,
  lng      double precision NOT NULL,
  map_x    double precision NOT NULL,
  map_y    double precision NOT NULL
);
