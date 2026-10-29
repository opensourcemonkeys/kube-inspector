-- Changes counted per hour, for the overview: the Stats queries over a week
-- or more read this instead of scanning changes with FINAL. Filled by the
-- materialized view below as rows are inserted, so it only holds changes
-- written after this migration; rollup_state records when that was, and
-- earlier periods are read from changes.
--
-- Only version 1 is counted: since the correlator writes each change once,
-- a higher version can only come from an older toolbox during an upgrade.
-- TTL is a placeholder: Store.EnsureRetention keeps it equal to changes'.
CREATE TABLE IF NOT EXISTS changes_hourly
(
    cluster       LowCardinality(String),
    hour          DateTime('UTC'),
    namespace     LowCardinality(String),
    verb          LowCardinality(String),
    attribution   LowCardinality(String),
    resource_key  LowCardinality(String),
    actor         String,
    changes       UInt64
)
ENGINE = SummingMergeTree(changes)
PARTITION BY toYYYYMM(hour)
ORDER BY (cluster, hour, namespace, verb, attribution, resource_key, actor)
TTL hour + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS changes_hourly_mv TO changes_hourly AS
SELECT
    cluster,
    toStartOfHour(event_time) AS hour,
    namespace,
    verb,
    attribution,
    if(api_group = '', resource, concat(resource, '.', api_group)) AS resource_key,
    if(username = '', concat('(', field_manager, ')'), username) AS actor,
    count() AS changes
FROM changes
WHERE version = 1
GROUP BY cluster, hour, namespace, verb, attribution, resource_key, actor;

-- When the rollup started: hours from then on are complete in it.
CREATE TABLE IF NOT EXISTS rollup_state
(
    name   String,
    since  DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree
ORDER BY name;

INSERT INTO rollup_state SELECT 'changes_hourly', now64(3);
