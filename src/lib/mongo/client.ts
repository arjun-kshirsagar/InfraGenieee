import { MongoClient, type Db } from 'mongodb';

declare global {
  var __infragenieMongoClientPromise: Promise<MongoClient> | undefined;
}

function mongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not configured.');
  return uri;
}

export function mongoDbName(): string {
  const dbName = process.env.MONGODB_DB;
  if (!dbName) throw new Error('MONGODB_DB is not configured.');
  return dbName;
}

export function getMongoClient(): Promise<MongoClient> {
  if (!globalThis.__infragenieMongoClientPromise) {
    const client = new MongoClient(mongoUri(), {
      appName: 'InfraGenie',
    });
    globalThis.__infragenieMongoClientPromise = client.connect();
  }

  return globalThis.__infragenieMongoClientPromise;
}

export async function getMongoDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(mongoDbName());
}
