-- The leader's heartbeat, a row every recorder.heartbeatInterval while it is
-- watching. A stretch without one longer than recorder.gapThreshold is a gap:
-- changes made then were not seen by any informer. Kept 30 days, longer than
-- the 7-day coverage the health report shows.
CREATE TABLE IF NOT EXISTS recorder_heartbeats
(
    ts                DateTime64(3, 'UTC'),
    cluster           LowCardinality(String),
    identity          LowCardinality(String),
    watched_resources UInt32,
    pending           UInt32
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (cluster, ts)
TTL toDateTime(ts) + INTERVAL 30 DAY;
