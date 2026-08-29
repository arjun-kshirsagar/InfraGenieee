import type { Collection, WithId } from 'mongodb';

import { getMongoDb } from '@/lib/mongo/client';
import { prdDocumentSchema, type PrdDocument } from '@/types/prd';
import type { PrdDocumentSummary } from '@/lib/prd/store';

interface StoredPrdDocument {
  userId: string;
  documentId: string;
  document: PrdDocument;
  createdAt: string;
  updatedAt: string;
}

let indexesReady: Promise<void> | null = null;

async function collection(): Promise<Collection<StoredPrdDocument>> {
  const db = await getMongoDb();
  const col = db.collection<StoredPrdDocument>('prd_documents');

  indexesReady ??= Promise.all([
    col.createIndex({ userId: 1, documentId: 1 }, { unique: true }),
    col.createIndex({ userId: 1, createdAt: -1 }),
  ]).then(() => undefined);

  await indexesReady;
  return col;
}

function toSummary(row: Pick<StoredPrdDocument, 'documentId' | 'document' | 'createdAt'>): PrdDocumentSummary {
  return {
    id: row.documentId,
    title: row.document.title,
    createdAt: row.document.createdAt || row.createdAt,
  };
}

function parseStored(row: WithId<StoredPrdDocument> | null): PrdDocument | null {
  if (!row) return null;
  const parsed = prdDocumentSchema.safeParse(row.document);
  return parsed.success ? parsed.data : null;
}

export async function saveUserPrdDocument(userId: string, document: PrdDocument): Promise<PrdDocument> {
  const parsed = prdDocumentSchema.parse(document);
  const col = await collection();
  const now = new Date().toISOString();

  await col.updateOne(
    { userId, documentId: parsed.id },
    {
      $set: {
        userId,
        documentId: parsed.id,
        document: parsed,
        createdAt: parsed.createdAt,
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  return parsed;
}

export async function saveUserPrdDocuments(
  userId: string,
  documents: readonly PrdDocument[],
): Promise<PrdDocumentSummary[]> {
  const saved: PrdDocumentSummary[] = [];
  for (const document of documents) {
    const doc = await saveUserPrdDocument(userId, document);
    saved.push({ id: doc.id, title: doc.title, createdAt: doc.createdAt });
  }
  return saved.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listUserPrdDocuments(userId: string): Promise<PrdDocumentSummary[]> {
  const col = await collection();
  const rows = await col
    .find(
      { userId },
      {
        projection: {
          _id: 0,
          documentId: 1,
          document: 1,
          createdAt: 1,
        },
        sort: { createdAt: -1 },
      },
    )
    .toArray();

  return rows.map(toSummary);
}

export async function getUserPrdDocument(userId: string, documentId: string): Promise<PrdDocument | null> {
  const col = await collection();
  const row = await col.findOne({ userId, documentId });
  return parseStored(row);
}
