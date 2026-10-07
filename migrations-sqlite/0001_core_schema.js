/**
 * Consolidated SQLite schema — the SQLite-equivalent of the full Postgres
 * migration history, used when DB_CLIENT=sqlite.
 *
 * Mapping notes:
 *  - uuid PKs            -> TEXT, default lower(hex(randomblob(16)))
 *  - bytea (hex strings) -> BLOB
 *  - jsonb               -> TEXT holding a JSON string (parsed on read)
 *  - timestamp/timestamptz -> TEXT ISO8601 via CURRENT_TIMESTAMP (knex datetime)
 *  - inet                -> TEXT
 *  - PG enum             -> TEXT + CHECK constraint
 *  - jsonb tag expansion trigger (event_tags) -> native SQLite triggers over
 *    json_each()
 *  - to_tsvector NIP-50  -> FTS5 virtual table events_fts keyed on events.rowid
 */
exports.up = async function (knex) {
  await knex.schema.createTable('events', (table) => {
    table.text('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'))
    table.binary('event_id').unique().notNullable().index()
    table.binary('event_pubkey').notNullable().index()
    table.integer('event_kind').unsigned().notNullable().index()
    table.integer('event_created_at').unsigned().notNullable().index()
    table.text('event_content').notNullable()
    table.text('event_tags')
    table.binary('event_signature').notNullable()
    table.timestamp('first_seen', { useTz: false }).defaultTo(knex.fn.now())
    table.timestamp('deleted_at', { useTz: false }).nullable()
    table.integer('expires_at').unsigned().nullable().index()
    table.text('remote_address').nullable()
    table.text('event_deduplication').nullable()
  })

  await knex.raw(`
    CREATE UNIQUE INDEX replaceable_events_idx
    ON events ( event_pubkey, event_kind, event_deduplication )
    WHERE
      (
        event_kind = 0
        OR event_kind = 3
        OR event_kind = 41
        OR (event_kind >= 10000 AND event_kind < 20000)
      )
      OR (event_kind >= 30000 AND event_kind < 40000);
  `)

  // Hot read path: REQ with authors+kinds ordered by created_at DESC, event_id ASC.
  await knex.raw(`
    CREATE INDEX events_active_pubkey_kind_created_at_idx
    ON events (event_pubkey, event_kind, event_created_at DESC, event_id)
  `)

  await knex.raw(`
    CREATE INDEX events_deleted_at_partial_idx
    ON events (deleted_at)
    WHERE deleted_at IS NOT NULL
  `)

  await knex.schema.createTable('event_tags', (table) => {
    table.text('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'))
    table.binary('event_id').notNullable()
    table.text('tag_name').notNullable()
    table.text('tag_value').notNullable()
  })

  await knex.schema.table('event_tags', (table) => {
    table.index('event_id')
    table.index(['tag_name', 'tag_value'])
  })

  // Expand the JSON event_tags column into rows, mirroring the Postgres
  // process_event_tags() trigger: only single-character tag names with a
  // non-empty value are indexed.
  await knex.raw(`
    CREATE TRIGGER insert_event_tags AFTER INSERT ON events
    FOR EACH ROW
    BEGIN
      INSERT INTO event_tags (event_id, tag_name, tag_value)
      SELECT NEW.event_id, json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]')
      FROM json_each(NEW.event_tags) AS je
      WHERE length(json_extract(je.value, '$[0]')) = 1
        AND json_extract(je.value, '$[1]') IS NOT NULL
        AND json_extract(je.value, '$[1]') <> '';
    END;
  `)

  await knex.raw(`
    CREATE TRIGGER update_event_tags AFTER UPDATE OF event_tags ON events
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
  `)

  await knex.raw(`
    CREATE TRIGGER delete_event_tags AFTER DELETE ON events
    FOR EACH ROW
    BEGIN
      DELETE FROM event_tags WHERE event_id = OLD.event_id;
    END;
  `)

  // NIP-50 full-text search: FTS5 index over event_content, keyed on the
  // events table's implicit rowid.
  await knex.raw(`CREATE VIRTUAL TABLE events_fts USING fts5(event_content)`)
  await knex.raw(`
    CREATE TRIGGER insert_events_fts AFTER INSERT ON events
    FOR EACH ROW
    BEGIN
      INSERT INTO events_fts (rowid, event_content) VALUES (NEW.rowid, NEW.event_content);
    END;
  `)
  await knex.raw(`
    CREATE TRIGGER delete_events_fts AFTER DELETE ON events
    FOR EACH ROW
    BEGIN
      DELETE FROM events_fts WHERE rowid = OLD.rowid;
    END;
  `)
  await knex.raw(`
    CREATE TRIGGER update_events_fts AFTER UPDATE OF event_content ON events
    FOR EACH ROW
    BEGIN
      UPDATE events_fts SET event_content = NEW.event_content WHERE rowid = OLD.rowid;
    END;
  `)

  await knex.schema.createTable('users', (table) => {
    table.binary('pubkey').primary()
    table.boolean('is_admitted').defaultTo(0)
    table.boolean('is_vanished').notNullable().defaultTo(false)
    table.bigint('balance').defaultTo(0)
    table.datetime('tos_accepted_at', { useTz: false, precision: 3 })
    table.timestamps(true, true, false)
  })

  await knex.schema.createTable('invoices', (table) => {
    table.text('id').primary()
    table.binary('pubkey').notNullable().index()
    table.text('bolt11').notNullable()
    table.bigint('amount_requested').unsigned().notNullable()
    table.bigint('amount_paid').unsigned()
    table.enu('unit', ['msats', 'sats', 'btc'], { useNative: false })
    table.enu('status', ['pending', 'completed', 'expired'], { useNative: false })
    table.text('description')
    table.text('verify_url')
    table.datetime('confirmed_at', { useTz: false, precision: 3 })
    table.datetime('expires_at', { useTz: false, precision: 3 })
    table.timestamps(true, true, false)
  })

  await knex.raw(`
    CREATE INDEX invoices_pending_created_at_idx
    ON invoices (created_at)
    WHERE status = 'pending'
  `)

  await knex.schema.createTable('nip05_verifications', (table) => {
    table.binary('pubkey').notNullable().primary()
    table.text('nip05').notNullable()
    table.text('domain').notNullable()
    table.boolean('is_verified').notNullable().defaultTo(false)
    table.timestamp('last_verified_at', { useTz: true }).nullable()
    table.timestamp('last_checked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.integer('failure_count').notNullable().defaultTo(0)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['domain'], 'idx_nip05_verifications_domain')
    table.index(['is_verified'], 'idx_nip05_verifications_is_verified')
    table.index(['last_checked_at'], 'idx_nip05_verifications_last_checked_at')
  })

  await knex.schema.createTable('invite_codes', (table) => {
    table.string('code', 64).primary()
    table.binary('created_by').nullable()
    table.binary('claimed_by').nullable()
    table.timestamp('expires_at', { useTz: true }).nullable()
    table.integer('remaining_uses').nullable().defaultTo(1)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.raw(
    'ALTER TABLE invite_codes ADD CONSTRAINT chk_remaining_uses_non_negative CHECK (remaining_uses >= 0)'
  )
  await knex.raw(
    'CREATE INDEX idx_invite_codes_expires_at ON invite_codes(expires_at) WHERE expires_at IS NOT NULL'
  )

  await knex.schema.createTable('dvm_jobs', (table) => {
    table.binary('id').primary()
    table.binary('requester_pubkey').notNullable()
    table.integer('kind').unsigned().notNullable()
    table.integer('worker_index').nullable()
    table
      .enu('status', ['submitted', 'picked_up', 'completed', 'failed', 'timed_out'], { useNative: false })
      .notNullable()
      .defaultTo('submitted')
    table.binary('result_event_id').nullable()
    table.text('error').nullable()
    table.timestamp('picked_up_at', { useTz: true }).nullable()
    table.timestamp('completed_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['requester_pubkey'], 'idx_dvm_jobs_requester_pubkey')
    table.index(['status', 'created_at'], 'idx_dvm_jobs_status_created_at')
    table.index(['kind'], 'idx_dvm_jobs_kind')
  })

  await knex.schema.createTable('reports', (table) => {
    table.increments('id').primary()
    table.binary('event_id').notNullable()
    table.binary('reporter_pubkey').notNullable()
    table.binary('reported_pubkey').nullable()
    table.binary('reported_event_id').nullable()
    table
      .enu('report_type', ['nudity', 'malware', 'profanity', 'illegal', 'spam', 'impersonation', 'other'], { useNative: false })
      .notNullable()
    table.float('weight').notNullable()
    table.boolean('actionable').notNullable().defaultTo(false)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['event_id'], 'idx_reports_event_id')
    table.index(['reported_pubkey'], 'idx_reports_reported_pubkey')
    table.index(['reported_event_id'], 'idx_reports_reported_event_id')
    table.index(['reporter_pubkey'], 'idx_reports_reporter_pubkey')
    table.index(['actionable', 'created_at'], 'idx_reports_actionable_created_at')
  })

  await knex.raw(`
    CREATE INDEX reports_actionable_reported_event_id_idx
    ON reports (reported_event_id)
    WHERE actionable = true AND reported_event_id IS NOT NULL
  `)
  await knex.raw(`
    CREATE INDEX reports_actionable_reported_pubkey_idx
    ON reports (reported_pubkey)
    WHERE actionable = true AND reported_pubkey IS NOT NULL
  `)

  await knex.schema.createTable('notification_outbox', (table) => {
    table.text('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'))
    table.text('event_type').notNullable()
    table.text('payload').notNullable()
    table
      .enu('status', ['pending', 'processing', 'delivered', 'dead'], { useNative: false })
      .notNullable()
      .defaultTo('pending')
    table.integer('attempt_count').unsigned().notNullable().defaultTo(0)
    table.timestamp('available_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.text('last_error').nullable()
    table.timestamp('delivered_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['status', 'available_at', 'created_at'], 'idx_notification_outbox_dispatch')
    table.index(['event_type', 'created_at'], 'idx_notification_outbox_event_type_created_at')
  })

  await knex.schema.createTable('notification_delivery_log', (table) => {
    table.text('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'))
    table.text('outbox_id').nullable()
    table.text('event_type').notNullable()
    table.text('target_id').notNullable()
    table.enu('target_type', ['http', 'discord', 'slack', 'telegram'], { useNative: false }).notNullable()
    table.enu('status', ['success', 'failed'], { useNative: false }).notNullable()
    table.integer('attempt_number').unsigned().notNullable()
    table.text('error_snippet').nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['created_at'], 'idx_notification_delivery_log_created_at')
    table.index(['event_type', 'created_at'], 'idx_notification_delivery_log_event_created_at')
    table.foreign('outbox_id').references('id').inTable('notification_outbox').onDelete('SET NULL')
  })
}

exports.down = async function (knex) {
  await knex.raw('DROP TRIGGER IF EXISTS update_events_fts')
  await knex.raw('DROP TRIGGER IF EXISTS delete_events_fts')
  await knex.raw('DROP TRIGGER IF EXISTS insert_events_fts')
  await knex.raw('DROP TABLE IF EXISTS events_fts')
  await knex.raw('DROP TRIGGER IF EXISTS delete_event_tags')
  await knex.raw('DROP TRIGGER IF EXISTS update_event_tags')
  await knex.raw('DROP TRIGGER IF EXISTS insert_event_tags')
  await knex.schema.dropTableIfExists('notification_delivery_log')
  await knex.schema.dropTableIfExists('notification_outbox')
  await knex.schema.dropTableIfExists('reports')
  await knex.schema.dropTableIfExists('dvm_jobs')
  await knex.schema.dropTableIfExists('invite_codes')
  await knex.schema.dropTableIfExists('nip05_verifications')
  await knex.schema.dropTableIfExists('invoices')
  await knex.schema.dropTableIfExists('users')
  await knex.schema.dropTableIfExists('event_tags')
  await knex.schema.dropTableIfExists('events')
}
