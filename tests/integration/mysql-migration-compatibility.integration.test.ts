import { test, expect } from "bun:test";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry, migrationChecksum, type DatabaseModule } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlIdentityModule } from "../../src/server/database/modules/identity.js";
import { mysqlCreationModule } from "../../src/server/database/modules/creation.js";
import { MySQLIdentityCredentials } from "../../src/server/auth/mysql-credentials.js";
import { createStoredAdministrator } from "../../src/server/auth/administrator-store.js";

const fixtures: { module: DatabaseModule; original: string; expanded: string }[] = [
  {
    module: mysqlIdentityModule,
    original: "ee8c8fe88bba34a77c9df0649c4067cabba839a5d6d26aa107bc08b9b85e4fb7",
    expanded: "14dc54c168c25f1f770b0b0d86f0c3e716465fc39a0e34427f0901f70bfdb84e",
  },
  {
    module: mysqlCreationModule,
    original: "98a063a9ecb491bd88e3281d3739af0dab2a372d380d0c29e3f74dd416edb1a0",
    expanded: "0cafd0bfc40297f367ea53b98caf413f0d28ac03b43ed8d60cf01b8581adcbd2",
  },
];

for (const fixture of fixtures) {
  for (const lineage of ["original", "expanded"] as const) {
    for (const recovery of ["complete", "uncheckpointed", "failed"] as const) {
      const interrupted = recovery !== "complete";
      test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
        `${fixture.module.id} upgrades ${lineage} v1 from ${recovery} history without losing data`,
        async () => {
          const database = await isolatedMySQLDatabase("upgrade"),
            module = fixture.module,
            v1 = module.migrations.mysql![0]!,
            steps = lineage === "original" ? v1.steps : v1.historicalSteps![0]!,
            plan = { version: 1, steps },
            checksum = migrationChecksum(module.id, plan),
            connection = new MySQLSchemaConnection(database.sql),
            registry = new DatabaseRegistry().register(module);
          expect(checksum).toBe(fixture[lineage]);
          try {
            if (interrupted) {
              await connection.exclusive(async () => {
                const checkpoint = recovery === "failed" ? steps.length - 1 : 0;
                await connection.record(module.id, {
                  version: 1,
                  checksum,
                  step: checkpoint,
                  state: recovery === "failed" ? "failed" : "running",
                });
                for (const step of steps.slice(0, Math.max(1, checkpoint))) await connection.execute(step.sql);
              });
            } else {
              await new DatabaseRegistry()
                .register({ ...module, migrations: { mysql: [plan] }, inspect: async () => [] })
                .upgrade(connection);
            }
            const before = await connection.history(module.id, 1);
            const firstTable = steps[0]!.id;
            if (firstTable === "panda_force_identity_credentials")
              await database.sql`INSERT INTO panda_force_identity_credentials(id,data) VALUES('retained','unchanged')`;
            else if (firstTable === "panda_force_identity_settings")
              await database.sql`INSERT INTO panda_force_identity_settings(id,record,revision) VALUES(1,'unchanged',7)`;
            else await database.sql`INSERT INTO panda_force_creation_ledgers(namespace) VALUES('retained')`;
            const administrator = createStoredAdministrator("upgrade.admin", "Upgrade-test-password1!");
            if (!interrupted && module.id === "identity")
              await new MySQLIdentityCredentials(database.sql).saveAdministrator(administrator);
            expect(await registry.upgrade(connection)).toEqual([]);
            const after = await connection.history(module.id, 1);
            expect(after).toMatchObject({ checksum, state: "complete", step: steps.length });
            if (!interrupted) expect(after).toEqual(before);
            expect((await connection.history(module.id, 2))?.state).toBe("complete");
            if (firstTable === "panda_force_identity_credentials")
              expect(
                (await database.sql`SELECT data FROM panda_force_identity_credentials WHERE id='retained'`)[0]?.data,
              ).toBe("unchanged");
            else if (firstTable === "panda_force_identity_settings")
              expect(
                (await database.sql`SELECT record,revision FROM panda_force_identity_settings WHERE id=1`)[0],
              ).toMatchObject({ record: "unchanged", revision: 7 });
            else
              expect(
                (await database.sql`SELECT namespace FROM panda_force_creation_ledgers WHERE namespace='retained'`)[0]
                  ?.namespace,
              ).toBe("retained");
            if (!interrupted && module.id === "identity")
              expect(await new MySQLIdentityCredentials(database.sql).administrator()).toEqual(administrator);
            expect(await registry.upgrade(new MySQLSchemaConnection(database.sql))).toEqual([]);
            await database.sql`UPDATE panda_force_schema_migrations SET checksum=${"f".repeat(64)} WHERE module=${module.id} AND version=1`;
            await expect(registry.upgrade(new MySQLSchemaConnection(database.sql))).rejects.toMatchObject({
              code: "changedMigration",
              module: module.id,
            });
          } finally {
            await database.close();
          }
        },
        60000,
      );
    }
  }
}
