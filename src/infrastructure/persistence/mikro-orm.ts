import { MikroORM, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20261106000001InitialSchema } from './migrations/Migration20261106000001InitialSchema';

/**
 * MikroORM é usado pelo que ele faz bem aqui: pool, `em.fork().transactional()`
 * com isolamento explícito, `em.execute()` dentro da transação e o Migrator
 * (versionado e reversível). Não há entidades mapeadas: o domínio não depende
 * do ORM e as queries críticas (FOR UPDATE, UPDATE condicionado por version,
 * ON CONFLICT, SKIP LOCKED) são SQL explícito nos repositórios.
 */
export function ormOptions(databaseUrl: string, poolMax = 10): Options {
  return {
    clientUrl: databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { min: 0, max: poolMax },
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false, // schema é escrito à mão na migration; sem snapshot gerado
      migrationsList: [
        { name: 'Migration20261106000001InitialSchema', class: Migration20261106000001InitialSchema },
      ],
    },
    debug: false,
  };
}

export async function createOrm(databaseUrl: string, poolMax = 10): Promise<MikroORM> {
  return MikroORM.init(ormOptions(databaseUrl, poolMax));
}
