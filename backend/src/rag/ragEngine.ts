import path from 'path';
import { LocalIndex } from 'vectra';
import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';

const INDEX_PATH = path.join(process.env.NODEBRAIN_DATA_DIR ?? path.join(process.cwd(), 'data'), 'rag-index');

let index: LocalIndex | null = null;
let extractor: FeatureExtractionPipeline | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    console.log('[RAG] Loading local embedding model (first run downloads ~25MB)...');
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('[RAG] Embedding model ready');
  }
  return extractor;
}

async function getIndex(): Promise<LocalIndex> {
  if (!index) {
    index = new LocalIndex(INDEX_PATH);
    if (!(await index.isIndexCreated())) {
      await index.createIndex();
      console.log('[RAG] Vector index created at', INDEX_PATH);
    }
  }
  return index;
}

async function getEmbedding(text: string): Promise<number[]> {
  const embed = await getExtractor();
  const output = await embed(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data) as number[];
}

export async function ingestText(
  text: string,
  source: string,
  agentId?: string,
): Promise<void> {
  const idx = await getIndex();

  const chunkSize = 500;
  const overlap = 50;
  const chunks: string[] = [];

  for (let i = 0; i < text.length; i += chunkSize - overlap) {
    const chunk = text.slice(i, i + chunkSize).trim();
    if (chunk.length > 20) chunks.push(chunk);
  }

  console.log(`[RAG] Ingesting ${chunks.length} chunks from "${source}"`);

  for (let i = 0; i < chunks.length; i++) {
    const vector = await getEmbedding(chunks[i]);
    await idx.insertItem({
      vector,
      metadata: {
        text: chunks[i],
        source,
        agentId: agentId ?? '',
        chunkIndex: i,
        timestamp: new Date().toISOString(),
      },
    });
  }
}

export async function queryRelevantContext(
  query: string,
  agentId?: string,
  topK = 5,
): Promise<string[]> {
  const idx = await getIndex();
  const queryVector = await getEmbedding(query);

  const filter = agentId ? { agentId: { $eq: agentId } } : undefined;

  const results = await idx.queryItems(queryVector, '', topK, filter);

  return results
    .filter(r => r.score > 0.5)
    .map(r => r.item.metadata.text as string);
}

export async function listMemories(
  agentId: string,
): Promise<{ id: string; text: string; source: string; timestamp: string }[]> {
  const idx = await getIndex();
  const items = await idx.listItems();
  return items
    .filter((item) => item.metadata.agentId === agentId)
    .map((item) => ({
      id: item.id,
      text: item.metadata.text as string,
      source: item.metadata.source as string,
      timestamp: item.metadata.timestamp as string,
    }));
}

export async function deleteMemory(itemId: string): Promise<boolean> {
  const idx = await getIndex();
  const items = await idx.listItems();
  const exists = items.some((item) => item.id === itemId);
  if (!exists) return false;
  await idx.deleteItem(itemId);
  return true;
}

export async function clearAgentMemory(agentId: string): Promise<number> {
  const idx = await getIndex();
  const items = await idx.listItems();
  const matching = items.filter((item) => item.metadata.agentId === agentId);
  for (const item of matching) {
    await idx.deleteItem(item.id);
  }
  return matching.length;
}

export async function initRag(): Promise<void> {
  await getIndex();
  await getExtractor();
}