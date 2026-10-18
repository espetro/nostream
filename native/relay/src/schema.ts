// Core NIP-01 schema — a flattened equivalent of
// migrations-sqlite/0001_core_schema.js on devin/1791411469-sqlite-poc,
// applied as plain SQL strings at first boot (no knex in this binary).
// Only the tables a relay needs to serve EVENT/REQ are kept: events +
// event_tags (+ their triggers). users/invoices/nip05/invites/dvm/reports/
// outbox and the NIP-50 FTS5 table are intentionally out of scope here —
// see native/relay/README.md "Excluded".

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  event_id BLOB UNIQUE NOT NULL,
  event_pubkey BLOB NOT NULL,
  event_kind INTEGER UNSIGNED NOT NULL,
  event_created_at INTEGER UNSIGNED NOT NULL,
  event_content TEXT NOT NULL,
  event_tags TEXT,
  event_signature BLOB NOT NULL,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,
  expires_at INTEGER UNSIGNED,
  remote_address TEXT,
  event_deduplication TEXT,
  -- 0 = pending sig verification, 1 = verified (servable), -1 = failed
  verified INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS events_event_id_idx ON events (event_id);
CREATE INDEX IF NOT EXISTS events_event_pubkey_idx ON events (event_pubkey);
CREATE INDEX IF NOT EXISTS events_event_kind_idx ON events (event_kind);
CREATE INDEX IF NOT EXISTS events_event_created_at_idx ON events (event_created_at);
CREATE INDEX IF NOT EXISTS events_expires_at_idx ON events (expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS replaceable_events_idx
ON events ( event_pubkey, event_kind, event_deduplication )
WHERE
  (
    event_kind = 0
    OR event_kind = 3
    OR event_kind = 41
    OR (event_kind >= 10000 AND event_kind < 20000)
  )
  OR (event_kind >= 30000 AND event_kind < 40000);

CREATE INDEX IF NOT EXISTS events_active_pubkey_kind_created_at_idx
ON events (event_pubkey, event_kind, event_created_at DESC, event_id);

CREATE INDEX IF NOT EXISTS events_deleted_at_partial_idx
ON events (deleted_at)
WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_tags (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  event_id BLOB NOT NULL,
  tag_name TEXT NOT NULL,
  tag_value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS event_tags_event_id_idx ON event_tags (event_id);
CREATE INDEX IF NOT EXISTS event_tags_tag_name_tag_value_idx ON event_tags (tag_name, tag_value);
CREATE INDEX IF NOT EXISTS event_tags_covering_idx ON event_tags (event_id, tag_name, tag_value);

CREATE TRIGGER IF NOT EXISTS insert_event_tags AFTER INSERT ON events
FOR EACH ROW
BEGIN
  INSERT INTO event_tags (event_id, tag_name, tag_value)
  SELECT NEW.event_id, json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]')
  FROM json_each(NEW.event_tags) AS je
  WHERE length(json_extract(je.value, '$[0]')) = 1
    AND json_extract(je.value, '$[1]') IS NOT NULL
    AND json_extract(je.value, '$[1]') <> '';
END;

CREATE TRIGGER IF NOT EXISTS update_event_tags AFTER UPDATE OF event_tags ON events
FOR EACH ROW
BEGIN
  DELETE FROM event_tags WHERE event_id = OLD.event_id;
  INSERT INTO event_tags (event_id, tag_name, tag_value)
  SELECT NEW.event_id, json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]')
  FROM json_each(NEW.event_tags) AS je
  WHERE length(json_extract(je.value, '$[0]')) = 1
    AND json_extract(je.value, '$[1]') IS NOT NULL
    AND json_extract(je.value, '$[1]') <> '';
END;

CREATE TRIGGER IF NOT EXISTS delete_event_tags AFTER DELETE ON events
FOR EACH ROW
BEGIN
  DELETE FROM event_tags WHERE event_id = OLD.event_id;
END;
`;
