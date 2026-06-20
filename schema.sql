-- SnoKing Food Safety — latest food-establishment inspection rating per place,
-- King County (Public Health Socrata) + Snohomish County (EnvisionConnect portal).
-- One row per establishment (its most recent graded inspection). Re-ingest upserts.
CREATE TABLE IF NOT EXISTS establishments (
  id           TEXT PRIMARY KEY,   -- "king:<business_id>" | "sno:<FacilityId>"
  county       TEXT NOT NULL,      -- 'king' | 'snohomish'
  name         TEXT NOT NULL,
  address      TEXT,
  city         TEXT,
  zip          TEXT,
  lat          REAL,
  lon          REAL,
  cuisine      TEXT,               -- inferred type: pizza/mexican/chinese/... (see ingester)
  rating       INTEGER,            -- unified 1..4 (1=best/green .. 4=worst/red), NULL=unknown
  rating_label TEXT,               -- "Excellent" / "Good" / "Okay" / "Needs to Improve"
  grade        INTEGER,            -- King County official grade 1..4 (NULL for Snohomish)
  score        REAL,               -- inspection points, lower=better (KC rolling score / Sno violation points)
  result       TEXT,               -- "Satisfactory" / "Unsatisfactory" (King; NULL for Snohomish)
  inspect_date TEXT,               -- ISO date of the inspection this rating reflects
  first_date   TEXT,               -- earliest inspection on record (≈ "in operation since")
  report_url   TEXT,               -- link to the official inspection report / lookup
  detail       TEXT,               -- JSON: latest inspection's violations + history summary (for the popup)
  rating_avg   REAL,               -- mean rating over the last 5 inspections (1.0..4.0)
  rating_avg_all REAL,             -- mean rating over all stored inspections
  rating_routine INTEGER,          -- rating of the most recent ROUTINE inspection (ignores reinspections)
  rating_worst INTEGER,            -- worst (highest) rating across all stored inspections
  poor_frac    REAL,               -- fraction of routine inspections rated Okay-or-worse (0..1, chronic-offender signal)
  worst_points REAL,               -- highest single-inspection point score on record (worst inspection)
  tract_id     TEXT,               -- census tract region_id (point-in-polygon), for the stats choropleth
  prev_rating  INTEGER,            -- the rating before the most recent change (NULL = first/new rating); set by the upsert
  rating_changed_at TEXT,          -- inspect_date when the current rating took effect (powers the "recently changed" view)
  updated_at   TEXT                -- ingest timestamp (ISO8601)
);
-- Funny inspector narratives (Snohomish v_memo), curated at ingest -> the /bloopers reel.
CREATE TABLE IF NOT EXISTS bloopers (
  id         TEXT PRIMARY KEY,     -- "<FacilityId>:<date>:<code>"
  name       TEXT NOT NULL,
  city       TEXT,
  date       TEXT,                 -- inspection date
  tag        TEXT,                 -- emoji tag
  label      TEXT,                 -- violation description
  text       TEXT NOT NULL,        -- the narrative (the funny part)
  report_url TEXT,
  lat        REAL,
  lon        REAL
);
CREATE INDEX IF NOT EXISTS idx_bloopers_date ON bloopers(date);
CREATE INDEX IF NOT EXISTS idx_est_county  ON establishments(county);
CREATE INDEX IF NOT EXISTS idx_est_rating  ON establishments(rating);
CREATE INDEX IF NOT EXISTS idx_est_cuisine ON establishments(cuisine);
CREATE INDEX IF NOT EXISTS idx_est_tract   ON establishments(tract_id);
CREATE INDEX IF NOT EXISTS idx_est_geo     ON establishments(lat, lon);
CREATE INDEX IF NOT EXISTS idx_est_updated ON establishments(updated_at);   -- makes MAX(updated_at) (the cache-version probe in every endpoint) a 1-row index read, not a full scan
