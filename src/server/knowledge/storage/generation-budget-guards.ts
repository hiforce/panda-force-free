/** SQLite guards keep mixed-version writers inside the same installation ceilings. */
export const GENERATION_BUDGET_GUARDS = [
  `CREATE TRIGGER knowledge_generation_pending_limit AFTER INSERT ON knowledge_generation_pending BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM knowledge_generation_limits WHERE id=1)
        OR (SELECT COUNT(*) FROM knowledge_generation_pending)>(SELECT installationPending FROM knowledge_generation_limits WHERE id=1)
        OR (SELECT COUNT(*) FROM knowledge_generation_pending WHERE owner=NEW.owner)>(SELECT ownerPending FROM knowledge_generation_limits WHERE id=1)
        OR (SELECT COUNT(*) FROM knowledge_generation_pending WHERE owner=NEW.owner AND project=NEW.project)>
          COALESCE((SELECT pendingLimit FROM knowledge_generation_policies WHERE owner=NEW.owner AND project=NEW.project),0)
        THEN RAISE(ABORT,'knowledge_generation_budget') END;
    END;`,
  `CREATE TRIGGER knowledge_generation_usage_insert AFTER INSERT ON knowledge_generation_usage BEGIN
      INSERT INTO knowledge_generation_totals VALUES('installation','',NEW.day,NEW.used)
        ON CONFLICT(scope,identity,day) DO UPDATE SET used=used+excluded.used;
      INSERT INTO knowledge_generation_totals VALUES('owner',NEW.owner,NEW.day,NEW.used)
        ON CONFLICT(scope,identity,day) DO UPDATE SET used=used+excluded.used;
      SELECT CASE WHEN NEW.used>0 AND (NOT EXISTS(SELECT 1 FROM knowledge_generation_limits WHERE id=1) OR
        (SELECT used FROM knowledge_generation_totals WHERE scope='installation' AND identity='' AND day=NEW.day)>(SELECT installationDaily FROM knowledge_generation_limits WHERE id=1)
        OR (SELECT used FROM knowledge_generation_totals WHERE scope='owner' AND identity=NEW.owner AND day=NEW.day)>(SELECT ownerDaily FROM knowledge_generation_limits WHERE id=1))
        THEN RAISE(ABORT,'knowledge_generation_budget') END;
    END;`,
  `CREATE TRIGGER knowledge_generation_usage_update AFTER UPDATE OF used ON knowledge_generation_usage BEGIN
      UPDATE knowledge_generation_totals SET used=used+NEW.used-OLD.used WHERE scope='installation' AND identity='' AND day=NEW.day;
      UPDATE knowledge_generation_totals SET used=used+NEW.used-OLD.used WHERE scope='owner' AND identity=NEW.owner AND day=NEW.day;
      SELECT CASE WHEN NEW.used>OLD.used AND (NOT EXISTS(SELECT 1 FROM knowledge_generation_limits WHERE id=1) OR
        (SELECT used FROM knowledge_generation_totals WHERE scope='installation' AND identity='' AND day=NEW.day)>(SELECT installationDaily FROM knowledge_generation_limits WHERE id=1)
        OR (SELECT used FROM knowledge_generation_totals WHERE scope='owner' AND identity=NEW.owner AND day=NEW.day)>(SELECT ownerDaily FROM knowledge_generation_limits WHERE id=1))
        THEN RAISE(ABORT,'knowledge_generation_budget') END;
    END;`,
  `CREATE TRIGGER knowledge_generation_usage_remove AFTER DELETE ON knowledge_generation_usage BEGIN
      UPDATE knowledge_generation_totals SET used=used-OLD.used WHERE scope='installation' AND identity='' AND day=OLD.day;
      UPDATE knowledge_generation_totals SET used=used-OLD.used WHERE scope='owner' AND identity=OLD.owner AND day=OLD.day;
    END;`,
  `CREATE TRIGGER knowledge_generation_usage_identity BEFORE UPDATE OF owner,project,day ON knowledge_generation_usage BEGIN
      SELECT RAISE(ABORT,'knowledge_generation_usage_identity');
    END;`,
  `CREATE TRIGGER knowledge_generation_origin_pending AFTER INSERT ON knowledge_generation_origins BEGIN
      INSERT INTO knowledge_generation_pending SELECT id,owner,project FROM knowledge_tasks
        WHERE id=NEW.taskId AND state IN ('queued','running','waiting','review','committing');
    END;`,
  `CREATE TRIGGER knowledge_generation_task_pending AFTER UPDATE OF state ON knowledge_tasks
      WHEN NEW.state!=OLD.state AND EXISTS(SELECT 1 FROM knowledge_generation_origins WHERE taskId=NEW.id) BEGIN
      INSERT OR IGNORE INTO knowledge_generation_pending SELECT NEW.id,NEW.owner,NEW.project
        WHERE NEW.state IN ('queued','running','waiting','review','committing');
      DELETE FROM knowledge_generation_pending WHERE taskId=NEW.id AND NEW.state NOT IN ('queued','running','waiting','review','committing');
    END;`,
  `CREATE TRIGGER knowledge_generation_origin_removed AFTER DELETE ON knowledge_generation_origins BEGIN
      DELETE FROM knowledge_generation_pending WHERE taskId=OLD.taskId;
    END;`,
] as const;
