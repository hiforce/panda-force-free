CREATE TABLE package_source_stages (
          id TEXT PRIMARY KEY, actor TEXT NOT NULL, operationId TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN('templates','skills')),
          request TEXT NOT NULL, limits TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
          state TEXT NOT NULL CHECK(state IN('reserved','acquiring','writing','ready','failed','cancelled','removing','removed')),
          reservedBytes INTEGER NOT NULL CHECK(reservedBytes>=0), digest TEXT, origin TEXT, failure TEXT,
          token TEXT, expiresAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
          UNIQUE(actor,operationId),CHECK((token IS NULL)=(expiresAt IS NULL)),
          CHECK((state IN('acquiring','writing'))=(token IS NOT NULL)),
          CHECK(state!='writing' OR digest IS NOT NULL),CHECK(state!='ready' OR (digest IS NOT NULL AND origin IS NOT NULL)),
          CHECK(state!='removed' OR reservedBytes=0)
        );
        CREATE INDEX package_source_stages_actor ON package_source_stages(actor,state,updatedAt);
        CREATE TABLE package_source_stage_events (
          id TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,at INTEGER NOT NULL,digest TEXT,failure TEXT,
          PRIMARY KEY(id,revision),FOREIGN KEY(id) REFERENCES package_source_stages(id)
        );
        PRAGMA user_version=1;
