# Workspace Knowledge Base (Firebase + GitHub Pages)

This repository implements a static SaaS-style frontend with a secure Firebase serverless backend for **document-grounded chat + search**.

## Current stack and integration points

- **Frontend:** static `index.html` + `app.html`, vanilla JS, CSS, deployed on GitHub Pages.
- **Auth:** Firebase Authentication (Google popup).
- **Data model:** Firestore with top-level `workspaces`, plus `documents`, `queries`, and `chatSessions` subcollections.
- **File storage:** Firebase Storage under `workspaces/{workspaceId}/{documentId}/{fileName}`.
- **Backend:** Firebase Cloud Functions (callable) for extraction, chunking, embeddings, retrieval, grounded answers, and ranked search.
- **AI calls:** OpenAI calls are server-side only via Functions secret `OPENAI_API_KEY`.

## Architecture choice and why

I used a practical and maintainable baseline:

1. Upload files from browser to Firebase Storage (auth-scoped).
2. Save document metadata in Firestore with processing state.
3. Trigger callable `processDocument` from frontend after upload.
4. Function extracts text (TXT/MD direct, PDF via `pdf-parse`, DOCX via `mammoth`).
5. Chunk extracted text, generate embeddings (`text-embedding-3-small`), persist chunks in `documentChunks`.
6. For chat/search, embed the query, compute cosine similarity over workspace chunks, and:
   - **Search:** return ranked snippets directly.
   - **Chat:** send top chunks to chat model (`gpt-4.1-mini`) with strict grounded prompt and citation payload.

This keeps secrets off the frontend, works with static hosting, and is easy to evolve later (swap vector backend, add more parsers, etc.).

## Data model

- `users/{userId}`
- `workspaces/{workspaceId}`
- `workspaces/{workspaceId}/documents/{documentId}`
- `workspaces/{workspaceId}/documents/{documentId}/documentChunks/{chunkId}`
- `workspaces/{workspaceId}/queries/{queryId}`
- `workspaces/{workspaceId}/chatSessions/{sessionId}/messages/{messageId}`

### Document metadata fields

- `ownerId`
- `workspaceId`
- `fileName`
- `originalFileType`
- `storagePath`
- `uploadedAt`
- `processingStatus` (`Uploading`, `Extracting`, `Indexing`, `Ready`, `Failed`)
- `extractedTextAvailable`
- `chunkCount`
- `failureReason` (when failed)

## Environment variables and secrets

### Frontend (`assets/firebase-config.js`)
Set your Firebase web config values:

- `apiKey`
- `authDomain`
- `projectId`
- `storageBucket`
- `messagingSenderId`
- `appId`
- `functionsRegion`

### Functions secret

```bash
firebase functions:secrets:set OPENAI_API_KEY
```

## Local development

1. Install Firebase CLI.
2. Install function dependencies:

```bash
cd functions
npm install
cd ..
```

3. Update `assets/firebase-config.js`.
4. Run emulators:

```bash
firebase emulators:start
```

5. Serve frontend locally (example):

```bash
python -m http.server 8080
```

Then open `http://localhost:8080/app.html`.

## Deploy

### Deploy functions

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

### Deploy frontend (GitHub Pages)

- Push `index.html`, `app.html`, and `assets/` to your Pages branch (`main` or `gh-pages` per repo config).
- Ensure the deployed frontend points to the same Firebase project as your functions.

## Upload, processing, chat, and search flow

1. User signs in and creates/selects workspace.
2. User uploads one or more docs.
3. Frontend writes metadata doc (`Uploading`) and uploads file to Storage.
4. Frontend calls `processDocument`.
5. Function updates status through `Extracting` -> `Indexing` -> `Ready`.
6. Chat tab sends question to `askWorkspaceQuestion` and renders answer + citations.
7. Search tab sends query to `searchWorkspace` and renders ranked snippets.

## Supported types

- `.txt`
- `.md`
- `.pdf`
- `.docx`

Unsupported types return a friendly error and `Failed` status.

## Security rules guidance

- `firestore.rules` enforces owner-scoped workspace/document access.
- `storage.rules` currently requires authenticated users; tighten path ownership checks using custom claims/workspace ACL if needed for production multi-user sharing.
- Cloud Functions verify auth and workspace ownership before retrieval/answering.

## Constraints and risks

- Firestore vector-in-document approach is practical for small/medium corpora but should be migrated to a dedicated vector store for very large workspaces.
- PDF/DOCX extraction quality depends on source formatting.
- Current UI uses a single default chat session; easy to extend to multi-session threads.
- Current retrieval runs similarity in function memory; for large scale, move retrieval to indexed vector backend.
