import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import OpenAI from 'openai';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';

initializeApp();

const db = getFirestore();
const storage = getStorage();
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4.1-mini';
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 180;

function requireAuth(auth) {
  if (!auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  return auth.uid;
}

async function assertWorkspaceOwner(uid, workspaceId) {
  const workspace = await db.collection('workspaces').doc(workspaceId).get();
  if (!workspace.exists) throw new HttpsError('not-found', 'Workspace not found.');
  if (workspace.data().ownerId !== uid) {
    throw new HttpsError('permission-denied', 'Workspace access denied.');
  }
}

function splitIntoChunks(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  let start = 0;
  while (start < cleaned.length) {
    const end = Math.min(start + CHUNK_SIZE, cleaned.length);
    chunks.push(cleaned.slice(start, end));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks.filter((chunk) => chunk.length > 80);
}

async function embedTexts(client, input) {
  const response = await client.embeddings.create({ model: EMBEDDING_MODEL, input });
  return response.data.map((r) => r.embedding);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

async function extractText(fileBuffer, fileName, mimeType) {
  const ext = fileName.toLowerCase().split('.').pop();
  if (mimeType === 'text/plain' || ext === 'txt' || ext === 'md') return fileBuffer.toString('utf-8');
  if (mimeType === 'application/pdf' || ext === 'pdf') {
    const parsed = await pdf(fileBuffer);
    return parsed.text;
  }
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    const parsed = await mammoth.extractRawText({ buffer: fileBuffer });
    return parsed.value;
  }
  throw new HttpsError('invalid-argument', `Unsupported file type for ${fileName}.`);
}

export const processDocument = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  const uid = requireAuth(request.auth);
  const { workspaceId, documentId } = request.data || {};
  if (!workspaceId || !documentId) throw new HttpsError('invalid-argument', 'workspaceId and documentId required.');
  await assertWorkspaceOwner(uid, workspaceId);

  const docRef = db.collection('workspaces').doc(workspaceId).collection('documents').doc(documentId);
  const documentSnap = await docRef.get();
  if (!documentSnap.exists) throw new HttpsError('not-found', 'Document metadata not found.');
  const docData = documentSnap.data();

  const client = new OpenAI({ apiKey: OPENAI_API_KEY.value() });

  try {
    await docRef.set({ processingStatus: 'Extracting', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const [buffer] = await storage.bucket().file(docData.storagePath).download();
    const extractedText = await extractText(buffer, docData.fileName, docData.originalFileType);

    await docRef.set({ processingStatus: 'Indexing', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const chunks = splitIntoChunks(extractedText);
    const vectors = await embedTexts(client, chunks);

    const batch = db.batch();
    const chunksRef = docRef.collection('documentChunks');
    const existing = await chunksRef.get();
    existing.docs.forEach((d) => batch.delete(d.ref));
    chunks.forEach((chunk, idx) => {
      const chunkRef = chunksRef.doc();
      batch.set(chunkRef, {
        ownerId: uid,
        workspaceId,
        documentId,
        chunkIndex: idx,
        text: chunk,
        embedding: vectors[idx],
        sectionLabel: `Chunk ${idx + 1}`,
        createdAt: FieldValue.serverTimestamp()
      });
    });
    batch.set(
      docRef,
      {
        processingStatus: 'Ready',
        extractedTextAvailable: true,
        chunkCount: chunks.length,
        indexedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    await batch.commit();
    return { ok: true, chunkCount: chunks.length };
  } catch (error) {
    await docRef.set(
      {
        processingStatus: 'Failed',
        failureReason: error.message,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    throw new HttpsError('internal', `Document processing failed: ${error.message}`);
  }
});

async function findTopChunks(client, workspaceId, queryText, topK = 6) {
  const [queryEmbedding] = await embedTexts(client, [queryText]);
  const docs = await db.collectionGroup('documentChunks').where('workspaceId', '==', workspaceId).get();

  const scored = docs.docs
    .map((d) => {
      const data = d.data();
      const score = cosineSimilarity(queryEmbedding, data.embedding);
      return { id: d.id, score, ...data };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

export const searchWorkspace = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  const uid = requireAuth(request.auth);
  const { workspaceId, query } = request.data || {};
  if (!workspaceId || !query) throw new HttpsError('invalid-argument', 'workspaceId and query required.');
  await assertWorkspaceOwner(uid, workspaceId);

  const client = new OpenAI({ apiKey: OPENAI_API_KEY.value() });
  const top = await findTopChunks(client, workspaceId, query, 10);

  const results = await Promise.all(
    top.map(async (row) => {
      const docSnap = await db.collection('workspaces').doc(workspaceId).collection('documents').doc(row.documentId).get();
      return {
        documentId: row.documentId,
        fileName: docSnap.exists ? docSnap.data().fileName : 'Unknown file',
        snippet: row.text.slice(0, 280),
        sectionLabel: row.sectionLabel,
        score: row.score
      };
    })
  );

  await db.collection('workspaces').doc(workspaceId).collection('queries').add({
    ownerId: uid,
    query,
    mode: 'search',
    createdAt: FieldValue.serverTimestamp(),
    resultCount: results.length
  });

  return { results };
});

export const askWorkspaceQuestion = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  const uid = requireAuth(request.auth);
  const { workspaceId, question } = request.data || {};
  if (!workspaceId || !question) throw new HttpsError('invalid-argument', 'workspaceId and question required.');
  await assertWorkspaceOwner(uid, workspaceId);

  const client = new OpenAI({ apiKey: OPENAI_API_KEY.value() });
  const top = await findTopChunks(client, workspaceId, question, 6);
  if (!top.length || top[0].score < 0.2) {
    return { answer: "I couldn't find that in the uploaded documents.", citations: [] };
  }

  const context = top
    .map((chunk, idx) => `SOURCE ${idx + 1} | docId=${chunk.documentId} | ${chunk.sectionLabel}\n${chunk.text}`)
    .join('\n\n');

  const completion = await client.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content:
          'Answer only using the provided sources. If unsupported, say exactly: I couldn\'t find that in the uploaded documents. If conflict exists, explain conflict with citations.'
      },
      { role: 'user', content: `Question: ${question}\n\nSources:\n${context}` }
    ]
  });

  const answer = completion.choices?.[0]?.message?.content?.trim() || "I couldn't find that in the uploaded documents.";

  const citations = await Promise.all(
    top.slice(0, 3).map(async (chunk) => {
      const docSnap = await db.collection('workspaces').doc(workspaceId).collection('documents').doc(chunk.documentId).get();
      return {
        documentId: chunk.documentId,
        fileName: docSnap.exists ? docSnap.data().fileName : 'Unknown file',
        snippet: chunk.text.slice(0, 280),
        sectionLabel: chunk.sectionLabel,
        score: chunk.score
      };
    })
  );

  await db
    .collection('workspaces')
    .doc(workspaceId)
    .collection('chatSessions')
    .doc('default')
    .collection('messages')
    .add({
      ownerId: uid,
      question,
      answer,
      citations,
      createdAt: FieldValue.serverTimestamp()
    });

  return { answer, citations };
});
