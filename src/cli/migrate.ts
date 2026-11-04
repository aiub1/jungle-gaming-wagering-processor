import { loadConfig } from '../infrastructure/config';
import { createOrm } from '../infrastructure/persistence/mikro-orm';

/** `bun src/cli/migrate.ts up|down|status` — migrations versionadas e reversíveis. */
const command = process.argv[2] ?? 'up';
const orm = await createOrm(process.env.DATABASE_URL ?? loadConfig().databaseUrl, 2);
try {
  const migrator = orm.migrator;
  if (command === 'up') {
    const applied = await migrator.up();
    console.log(JSON.stringify({ msg: 'migrations applied', applied: applied.map((m) => m.name) }));
  } else if (command === 'down') {
    const reverted = await migrator.down();
    console.log(JSON.stringify({ msg: 'migration reverted', reverted: reverted.map((m) => m.name) }));
  } else if (command === 'status') {
    console.log(JSON.stringify({ executed: await migrator.getExecuted(), pending: await migrator.getPending() }));
  } else {
    throw new Error(`unknown command ${command}`);
  }
} finally {
  await orm.close(true);
}
