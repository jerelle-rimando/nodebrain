import crypto from 'crypto';
import path from 'path';
import { LocalIndex } from 'vectra';
import type { FeatureExtractionPipeline } from '@xenova/transformers';

const INDEX_PATH = path.join(process.env.NODEBRAIN_DATA_DIR ?? path.join(process.cwd(), 'data'), 'rag-index');

let index: LocalIndex | null = null;
// The promise, not the pipeline, is cached: startup init, task queries and
// background ingestion can all ask for the model before the first load finishes.
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      console.log('[RAG] Loading local embedding model (first run downloads ~25MB)...');
      // Dynamically imported: @xenova/transformers pulls in onnxruntime-node (a 9.3MB
      // native Windows DLL). A top-level import forced Node to load it at process
      // boot even though it's only needed once an agent actually queries RAG.
      const { pipeline } = await import('@xenova/transformers');
      const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      console.log('[RAG] Embedding model ready');
      return extractor;
    })();
    // A failed load (e.g. offline first run) must not be cached forever.
    extractorPromise.catch(() => { extractorPromise = null; });
  }
  return extractorPromise;
}

// vectra allows one update at a time: a second beginUpdate() while one is open
// throws "Update already in progress". Background ingestion can overlap another
// ingestion or a Memory-tab delete, so every index write goes through here.
let writeChain: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
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

function chunkText(text: string): string[] {
  const chunkSize = 500;
  const overlap = 50;
  const chunks: string[] = [];

  for (let i = 0; i < text.length; i += chunkSize - overlap) {
    const chunk = text.slice(i, i + chunkSize).trim();
    if (chunk.length > 20) chunks.push(chunk);
  }
  return chunks;
}

// Per-agent cap, in stored chunks (one chunk per instruction under 500 chars).
// Each chunk is ~8.4KB in index.json and vectra keeps the whole index in RAM,
// cloning it on every write. 200 chunks is ~1.7MB per agent on disk; 20 agents
// stay under ~35MB, small next to a local 2.5GB model on an 8GB machine. With
// retrieval at 1 (local) or 5 (cloud) results, 200 distinct instructions is
// already far more history than retrieval can surface.
const MAX_CHUNKS_PER_AGENT = 200;

// Oldest-first ids to evict so `incoming` new chunks fit under the cap. Evicts
// whole sources, never part of one, so a long instruction isn't left truncated.
// Age is the ISO `timestamp` written at ingestion (sorts lexicographically).
function idsToEvict(items: { id: string; metadata: Record<string, unknown> }[], agentId: string, incoming: number): string[] {
  const bySource = new Map<string, { ids: string[]; oldest: string }>();
  for (const item of items) {
    if (item.metadata.agentId !== agentId) continue;
    const source = String(item.metadata.source ?? item.id);
    const ts = String(item.metadata.timestamp ?? '');
    const group = bySource.get(source) ?? { ids: [], oldest: ts };
    group.ids.push(item.id);
    if (ts < group.oldest) group.oldest = ts;
    bySource.set(source, group);
  }

  let total = [...bySource.values()].reduce((n, g) => n + g.ids.length, 0) + incoming;
  const evict: string[] = [];
  for (const group of [...bySource.values()].sort((a, b) => a.oldest.localeCompare(b.oldest))) {
    if (total <= MAX_CHUNKS_PER_AGENT) break;
    evict.push(...group.ids);
    total -= group.ids.length;
  }
  return evict;
}

// Embeds outside the write lock (CPU-bound, no index access), then inserts the
// chunks and evicts over-cap ones in a single update: one index.json rewrite.
// `skipIf` runs inside the lock, so a check-then-insert can't race another write.
async function insertChunks(
  text: string,
  source: string,
  agentId: string,
  skipIf?: (idx: LocalIndex) => Promise<boolean>,
): Promise<number> {
  const chunks = chunkText(text);
  if (chunks.length === 0) return 0;

  const vectors: number[][] = [];
  for (const chunk of chunks) vectors.push(await getEmbedding(chunk));

  return withWriteLock(async () => {
    const idx = await getIndex();
    if (skipIf && (await skipIf(idx))) return 0;
    const evict = agentId ? idsToEvict(await idx.listItems(), agentId, chunks.length) : [];
    const timestamp = new Date().toISOString();

    await idx.beginUpdate();
    try {
      for (const id of evict) await idx.deleteItem(id);
      for (let i = 0; i < chunks.length; i++) {
        await idx.insertItem({
          vector: vectors[i],
          metadata: { text: chunks[i], source, agentId, chunkIndex: i, timestamp },
        });
      }
      await idx.endUpdate();
    } catch (err) {
      idx.cancelUpdate();
      throw err;
    }
    if (evict.length > 0) console.log(`[RAG] Evicted ${evict.length} oldest memories for agent ${agentId} (cap ${MAX_CHUNKS_PER_AGENT})`);
    return chunks.length;
  });
}

export async function ingestText(
  text: string,
  source: string,
  agentId?: string,
): Promise<void> {
  const count = await insertChunks(text, source, agentId ?? '');
  console.log(`[RAG] Ingested ${count} chunks from "${source}"`);
}

// Stores a completed task's instruction as agent memory. Deduped per agent on
// the whitespace-normalized text: a scheduled agent re-runs the same instruction
// every time, and one stored copy is all retrieval can use. Returns false when
// an identical instruction was already stored, or the agent no longer exists.
// `agentExists` is checked inside the write lock: ingestion runs in the
// background, and an agent deleted mid-embedding would otherwise get its
// memory written after clearAgentMemory already ran, orphaned for good.
export async function ingestTaskInstruction(
  instruction: string,
  agentId: string,
  agentExists: () => boolean = () => true,
): Promise<boolean> {
  if (!agentId) return false;
  const normalized = instruction.trim().replace(/\s+/g, ' ');
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  const source = `task-instruction:${hash}`;

  const count = await insertChunks(normalized, source, agentId, async (idx) => {
    if (!agentExists()) return true;
    const existing = await idx.listItemsByMetadata({ agentId: { $eq: agentId }, source: { $eq: source } });
    return existing.length > 0;
  });
  return count > 0;
}

// agentId is required and always applied: memory is per-agent, and an
// unfiltered query would return every agent's (i.e. every client's) memories.
export async function queryRelevantContext(
  query: string,
  agentId: string,
  topK = 5,
): Promise<string[]> {
  if (!agentId) return [];
  const idx = await getIndex();
  const queryVector = await getEmbedding(query);

  const results = await idx.queryItems(queryVector, '', topK, { agentId: { $eq: agentId } });

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

// Deletes only if the item belongs to agentId. A memory owned by another agent
// is reported as not found, the same as a missing one.
export async function deleteMemory(agentId: string, itemId: string): Promise<boolean> {
  if (!agentId) return false;
  const idx = await getIndex();
  const items = await idx.listItems();
  const owned = items.some((item) => item.id === itemId && item.metadata.agentId === agentId);
  if (!owned) return false;
  await withWriteLock(() => idx.deleteItem(itemId));
  return true;
}

// vectra removes items in place (spliced from the array, file rewritten on
// endUpdate); there are no tombstones, so nothing needs rebuilding afterwards.
export async function clearAgentMemory(agentId: string): Promise<number> {
  const idx = await getIndex();
  // Listed inside the lock so an ingestion queued ahead of this is included.
  return withWriteLock(async () => {
    const items = await idx.listItems();
    const matching = items.filter((item) => item.metadata.agentId === agentId);
    if (matching.length === 0) return 0;
    // One update for the whole batch: a bare deleteItem() rewrites index.json each time.
    await idx.beginUpdate();
    try {
      for (const item of matching) await idx.deleteItem(item.id);
      await idx.endUpdate();
    } catch (err) {
      idx.cancelUpdate();
      throw err;
    }
    return matching.length;
  });
}

export async function initRag(): Promise<void> {
  await getIndex();
  await getExtractor();
}
