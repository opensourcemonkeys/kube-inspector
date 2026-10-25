-- One row per persisted change. ReplacingMergeTree(version) lets the
-- correlator re-write a row with a better attribution later; readers use FINAL.
-- TTLs here are placeholders: Store.EnsureRetention sets them from config.
CREATE TABLE IF NOT EXISTS changes
(
    event_id          UUID,
    version           UInt32,
    event_time        DateTime64(3, 'UTC'),
    cluster           LowCardinality(String),
    verb              LowCardinality(String),
    api_group         LowCardinality(String),
    api_version       LowCardinality(String),
    resource          LowCardinality(String),
    kind              LowCardinality(String),
    namespace         LowCardinality(String),
    name              String,
    object_uid        String,
    resource_version  String,
    username          String,
    user_uid          String,
    groups            Array(String),
    extra             String,
    impersonated_by   String,
    source_ips        Array(String),
    user_agent        String,
    audit_id          String,
    field_manager     LowCardinality(String),
    attribution       LowCardinality(String),
    changed_paths     Array(String),
    patch             String CODEC(ZSTD(3)),
    object_before     String CODEC(ZSTD(3)),
    object_after      String CODEC(ZSTD(3)),
    INDEX idx_event_id event_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_object_uid object_uid TYPE bloom_filter GRANULARITY 4,
    INDEX idx_username username TYPE bloom_filter GRANULARITY 4,
    INDEX idx_changed_paths changed_paths TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(event_time)
ORDER BY (cluster, resource, namespace, name, event_time, event_id)
TTL toDateTime(event_time) + INTERVAL 90 DAY;

-- Actor information from the audit and admission webhooks, waiting to be
-- matched to a change. Only needed for minutes; kept a day for debugging.
CREATE TABLE IF NOT EXISTS actor_hints
(
    hint_id           String,
    source            LowCardinality(String),
    ts                DateTime64(3, 'UTC'),
    cluster           LowCardinality(String),
    verb              LowCardinality(String),
    api_group         LowCardinality(String),
    resource          LowCardinality(String),
    subresource       LowCardinality(String),
    namespace         LowCardinality(String),
    name              String,
    object_uid        String,
    resource_version  String,
    content_hash      String,
    username          String,
    user_uid          String,
    groups            Array(String),
    extra             String,
    impersonated_by   String,
    source_ips        Array(String),
    user_agent        String,
    audit_id          String
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (cluster, name, ts)
TTL toDateTime(ts) + INTERVAL 1 DAY;

-- Every mutating request the audit webhook saw, successful or not. The API
-- server may resend a batch, so rows are deduplicated on audit_id.
CREATE TABLE IF NOT EXISTS audit_raw
(
    ts                DateTime64(3, 'UTC'),
    cluster           LowCardinality(String),
    audit_id          String,
    verb              LowCardinality(String),
    api_group         LowCardinality(String),
    api_version       LowCardinality(String),
    resource          LowCardinality(String),
    subresource       LowCardinality(String),
    namespace         LowCardinality(String),
    name              String,
    username          String,
    groups            Array(String),
    impersonated_by   String,
    source_ips        Array(String),
    user_agent        String,
    request_uri       String,
    response_code     Int32,
    response_reason   LowCardinality(String),
    response_message  String
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (cluster, ts, audit_id)
TTL toDateTime(ts) + INTERVAL 30 DAY;
