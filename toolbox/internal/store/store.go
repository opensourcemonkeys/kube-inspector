// Package store is toolbox's ClickHouse layer: schema migrations, batched
// writers for the three tables, and the read queries behind the REST API.
package store

import (
	"context"
	"crypto/tls"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"

	"github.com/kubeinspector/toolbox/internal/config"
)

//go:embed migrations/*.sql
var migrations embed.FS

type Store struct {
	conn driver.Conn
	db   string
}

// Open connects, creates the database if needed and applies migrations.
func Open(ctx context.Context, c config.ClickHouse) (*Store, error) {
	if err := createDatabase(ctx, c); err != nil {
		return nil, err
	}
	conn, err := clickhouse.Open(options(c, c.Database))
	if err != nil {
		return nil, err
	}
	if err := conn.Ping(ctx); err != nil {
		return nil, fmt.Errorf("clickhouse ping: %w", err)
	}
	s := &Store{conn: conn, db: c.Database}
	if err := s.migrate(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

func options(c config.ClickHouse, db string) *clickhouse.Options {
	o := &clickhouse.Options{
		Addr:        c.Addr,
		Auth:        clickhouse.Auth{Database: db, Username: c.Username, Password: c.Password},
		DialTimeout: 10 * time.Second,
		Compression: &clickhouse.Compression{Method: clickhouse.CompressionLZ4},
	}
	if c.Secure {
		o.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return o
}

func createDatabase(ctx context.Context, c config.ClickHouse) error {
	conn, err := clickhouse.Open(options(c, "default"))
	if err != nil {
		return err
	}
	defer conn.Close()
	return conn.Exec(ctx, "CREATE DATABASE IF NOT EXISTS "+quoteIdent(c.Database))
}

func quoteIdent(s string) string { return "`" + strings.ReplaceAll(s, "`", "``") + "`" }

func (s *Store) Close() error { return s.conn.Close() }

func (s *Store) Ping(ctx context.Context) error { return s.conn.Ping(ctx) }

// migrate applies every migrations/NNNN_*.sql not yet recorded in
// schema_migrations, statement by statement (the native protocol takes one
// statement per Exec). Replicas may race here on first start; every statement
// is IF NOT EXISTS, so the loser just re-applies no-ops.
func (s *Store) migrate(ctx context.Context) error {
	if err := s.conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations
		(version UInt32, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY version`); err != nil {
		return err
	}
	applied := map[uint32]bool{}
	rows, err := s.conn.Query(ctx, "SELECT version FROM schema_migrations")
	if err != nil {
		return err
	}
	for rows.Next() {
		var v uint32
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()

	files, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(files)
	for _, f := range files {
		base := strings.TrimPrefix(f, "migrations/")
		n, err := strconv.ParseUint(strings.SplitN(base, "_", 2)[0], 10, 32)
		if err != nil {
			return fmt.Errorf("migration %s: name must start with a number", base)
		}
		if applied[uint32(n)] {
			continue
		}
		b, _ := migrations.ReadFile(f)
		for _, stmt := range splitStatements(string(b)) {
			if err := s.conn.Exec(ctx, stmt); err != nil {
				return fmt.Errorf("migration %s: %w", base, err)
			}
		}
		if err := s.conn.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES (?)", uint32(n)); err != nil {
			return err
		}
		slog.Info("applied migration", "file", base)
	}
	return nil
}

// splitStatements splits on ";" at line ends and drops comment-only chunks.
// Migrations must not put a semicolon at the end of a line inside a string.
func splitStatements(sql string) []string {
	var out []string
	var cur strings.Builder
	for _, line := range strings.Split(sql, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "--") {
			continue
		}
		cur.WriteString(line)
		cur.WriteString("\n")
		if strings.HasSuffix(trimmed, ";") {
			if stmt := strings.TrimSuffix(strings.TrimSpace(cur.String()), ";"); stmt != "" {
				out = append(out, stmt)
			}
			cur.Reset()
		}
	}
	if stmt := strings.TrimSpace(cur.String()); stmt != "" {
		out = append(out, stmt)
	}
	return out
}

// EnsureRetention sets the TTLs from config, but only when they differ: a TTL
// change rewrites data, so doing it unconditionally on every start would be
// expensive. materialize_ttl_after_modify=0 leaves old parts to expire on the
// next merge rather than rewriting them now.
func (s *Store) EnsureRetention(ctx context.Context, r config.Retention) error {
	want := map[string]struct {
		col  string
		days int
	}{
		"changes":   {"event_time", r.ChangesDays},
		"audit_raw": {"ts", r.AuditRawDays},
	}
	for table, w := range want {
		var engine string
		row := s.conn.QueryRow(ctx,
			"SELECT engine_full FROM system.tables WHERE database = ? AND name = ?", s.db, table)
		if err := row.Scan(&engine); err != nil {
			return fmt.Errorf("read ttl of %s: %w", table, err)
		}
		if strings.Contains(engine, fmt.Sprintf("toIntervalDay(%d)", w.days)) {
			continue
		}
		q := fmt.Sprintf("ALTER TABLE %s MODIFY TTL toDateTime(%s) + INTERVAL %d DAY SETTINGS materialize_ttl_after_modify = 0",
			table, w.col, w.days)
		if err := s.conn.Exec(ctx, q); err != nil {
			return fmt.Errorf("set ttl of %s: %w", table, err)
		}
		slog.Info("retention updated", "table", table, "days", w.days)
	}
	return nil
}
