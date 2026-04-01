import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  getRedirectResult,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {
  deleteObject,
  getDownloadURL,
  getStorage,
  ref,
  uploadBytesResumable
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js';
import { firebaseConfig, functionsRegion } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app, functionsRegion);

const signInBtn = document.getElementById('signInBtn');
const signOutBtn = document.getElementById('signOutBtn');
const authFeedback = document.getElementById('authFeedback');
const authState = document.getElementById('authState');
const appShell = document.getElementById('appShell');
const workspaceSelect = document.getElementById('workspaceSelect');
const createWorkspaceBtn = document.getElementById('createWorkspaceBtn');
const refreshWorkspaceBtn = document.getElementById('refreshWorkspaceBtn');
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const uploadStatus = document.getElementById('uploadStatus');
const documentTable = document.getElementById('documentTable');
const sendChatBtn = document.getElementById('sendChatBtn');
const chatInput = document.getElementById('chatInput');
const chatHistory = document.getElementById('chatHistory');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');

let currentUser = null;
let documentsUnsub = null;
let activeWorkspaceId = null;

const processDocument = httpsCallable(functions, 'processDocument');
const askWorkspaceQuestion = httpsCallable(functions, 'askWorkspaceQuestion');
const searchWorkspace = httpsCallable(functions, 'searchWorkspace');

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

signInBtn.addEventListener('click', async () => {
  authFeedback.textContent = '';
  const isSmallScreen = window.matchMedia('(max-width: 900px)').matches;
  if (isSmallScreen) {
    await signInWithRedirect(auth, googleProvider);
    return;
  }

  try {
    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    const popupRecoverable = ['auth/popup-closed-by-user', 'auth/popup-blocked', 'auth/cancelled-popup-request'].includes(error.code);
    if (popupRecoverable) {
      authFeedback.textContent = 'Popup was blocked/closed. Redirecting to Google sign-in...';
      await signInWithRedirect(auth, googleProvider);
      return;
    }
    authFeedback.textContent = `Sign-in failed: ${error.message}`;
  }
});
signOutBtn.addEventListener('click', async () => signOut(auth));
refreshWorkspaceBtn.addEventListener('click', loadWorkspaces);
createWorkspaceBtn.addEventListener('click', createWorkspace);
uploadBtn.addEventListener('click', uploadSelectedFiles);
sendChatBtn.addEventListener('click', runChat);
searchBtn.addEventListener('click', runSearch);
workspaceSelect.addEventListener('change', () => {
  activeWorkspaceId = workspaceSelect.value;
  subscribeDocuments();
});

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const isChat = btn.dataset.tab === 'chat';
    document.getElementById('chatTab').hidden = !isChat;
    document.getElementById('searchTab').hidden = isChat;
  });
}

try {
  await getRedirectResult(auth);
} catch (error) {
  authFeedback.textContent = `Redirect sign-in failed: ${error.message}`;
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  const signedIn = Boolean(user);
  authState.hidden = signedIn;
  appShell.hidden = !signedIn;
  signInBtn.hidden = signedIn;
  signOutBtn.hidden = !signedIn;
  if (!signedIn) return;
  await loadWorkspaces();
});

async function loadWorkspaces() {
  if (!currentUser) return;
  const q = query(collection(db, 'workspaces'), orderBy('updatedAt', 'desc'));
  const snap = await getDocs(q);
  const rows = snap.docs.filter((d) => d.data().ownerId === currentUser.uid);
  if (!rows.length) {
    await createWorkspace();
    return;
  }
  workspaceSelect.innerHTML = rows
    .map((d) => `<option value="${d.id}">${d.data().name}</option>`)
    .join('');
  activeWorkspaceId = rows[0].id;
  subscribeDocuments();
}

async function createWorkspace() {
  if (!currentUser) return;
  const name = window.prompt('Workspace name', 'Course Workspace');
  if (!name) return;
  const newRef = await addDoc(collection(db, 'workspaces'), {
    ownerId: currentUser.uid,
    name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  activeWorkspaceId = newRef.id;
  await setDoc(doc(db, 'users', currentUser.uid), { lastActiveAt: serverTimestamp() }, { merge: true });
  await loadWorkspaces();
}

function subscribeDocuments() {
  if (!activeWorkspaceId) return;
  if (documentsUnsub) documentsUnsub();
  const q = query(collection(db, 'workspaces', activeWorkspaceId, 'documents'), orderBy('uploadedAt', 'desc'));
  documentsUnsub = onSnapshot(q, (snap) => {
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderDocuments(docs);
  });
}

async function uploadSelectedFiles() {
  if (!currentUser || !activeWorkspaceId) return;
  const files = [...fileInput.files];
  if (!files.length) return;
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) {
      uploadStatus.textContent = `${file.name}: File exceeds 10MB limit.`;
      continue;
    }
    const docRef = doc(collection(db, 'workspaces', activeWorkspaceId, 'documents'));
    const storagePath = `workspaces/${activeWorkspaceId}/${docRef.id}/${file.name}`;
    await setDoc(docRef, {
      ownerId: currentUser.uid,
      workspaceId: activeWorkspaceId,
      fileName: file.name,
      originalFileType: file.type || file.name.split('.').pop(),
      storagePath,
      uploadedAt: serverTimestamp(),
      processingStatus: 'Uploading',
      extractedTextAvailable: false,
      chunkCount: 0
    });
    await uploadFile(file, storagePath, docRef.id);
  }
  fileInput.value = '';
}

function uploadFile(file, storagePath, documentId) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, storagePath), file, {
      contentType: file.type || 'application/octet-stream'
    });
    task.on(
      'state_changed',
      (snapshot) => {
        const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
        uploadStatus.textContent = `${file.name}: Uploading ${pct}%`;
      },
      async (error) => {
        uploadStatus.textContent = `${file.name}: Upload failed.`;
        await setDoc(
          doc(db, 'workspaces', activeWorkspaceId, 'documents', documentId),
          { processingStatus: 'Failed', failureReason: error.message, updatedAt: serverTimestamp() },
          { merge: true }
        );
        reject(error);
      },
      async () => {
        uploadStatus.textContent = `${file.name}: Extracting text...`;
        await setDoc(
          doc(db, 'workspaces', activeWorkspaceId, 'documents', documentId),
          { processingStatus: 'Extracting', updatedAt: serverTimestamp() },
          { merge: true }
        );
        await processDocument({ workspaceId: activeWorkspaceId, documentId });
        uploadStatus.textContent = `${file.name}: Ready`;
        resolve();
      }
    );
  });
}

function renderDocuments(rows) {
  if (!rows.length) {
    documentTable.innerHTML = '<p class="muted">No documents yet. Upload files to start grounding answers.</p>';
    return;
  }
  documentTable.innerHTML = rows
    .map((row) => `
      <div class="table-row">
        <div><strong>${row.fileName}</strong><div class="muted">${row.originalFileType || 'unknown'}</div></div>
        <div><span class="status-badge status-${(row.processingStatus || 'uploading').toLowerCase()}">${row.processingStatus || 'Uploading'}</span></div>
        <div class="muted">Chunks: ${row.chunkCount || 0}</div>
        <div class="inline-actions">
          <button class="btn" onclick="window.__kbDelete('${row.id}', '${row.storagePath || ''}')">Delete</button>
        </div>
      </div>`)
    .join('');
}

window.__kbDelete = async (documentId, storagePath) => {
  if (!window.confirm('Delete this file and indexed chunks?')) return;
  try {
    if (storagePath) await deleteObject(ref(storage, storagePath));
  } catch (error) {
    console.warn('Storage deletion failed', error);
  }
  await deleteDoc(doc(db, 'workspaces', activeWorkspaceId, 'documents', documentId));
};

async function runChat() {
  const question = chatInput.value.trim();
  if (!question || !activeWorkspaceId) return;
  appendMessage('You', question, []);
  chatInput.value = '';
  const response = await askWorkspaceQuestion({ workspaceId: activeWorkspaceId, question });
  appendMessage('Assistant', response.data.answer, response.data.citations || []);
}

function appendMessage(author, text, citations) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message';
  const sources = citations
    .map(
      (c) => `<div class="source-card"><strong>${c.fileName}</strong><p>${c.snippet}</p><small>${c.sectionLabel || ''}</small></div>`
    )
    .join('');
  wrapper.innerHTML = `<strong>${author}:</strong><p>${text}</p>${sources}`;
  chatHistory.prepend(wrapper);
}

async function runSearch() {
  const text = searchInput.value.trim();
  if (!text || !activeWorkspaceId) return;
  const response = await searchWorkspace({ workspaceId: activeWorkspaceId, query: text });
  const results = response.data.results || [];
  if (!results.length) {
    searchResults.innerHTML = '<p class="muted">No matching passages were found in your uploaded documents.</p>';
    return;
  }
  searchResults.innerHTML = results
    .map(
      (r) => `<article class="search-result"><strong>${r.fileName}</strong> <small>score: ${r.score.toFixed(3)}</small><p>${r.snippet}</p><small>${r.sectionLabel || ''}</small></article>`
    )
    .join('');
}
