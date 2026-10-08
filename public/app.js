const COLUMNS = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'In progress' },
  { key: 'done', label: 'Done' },
];
const $ = (id) => document.getElementById(id);

let token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user') || 'null');
let tasks = [];
let socket = null;
let registering = false;
let editingId = null;

// ---------- API helper ----------
async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token) { signOut(); throw new Error('Session expired.'); }
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

// ---------- Auth ----------
function setAuthMode(reg) {
  registering = reg;
  $('name-field').hidden = !reg;
  $('auth-sub').textContent = reg ? 'Create an account to start tracking tasks.' : 'Sign in to see your tasks.';
  $('auth-submit').textContent = reg ? 'Create account' : 'Sign in';
  $('auth-toggle').textContent = reg ? 'Have an account? Sign in' : 'New here? Create an account';
  $('auth-error').textContent = '';
}
$('auth-toggle').onclick = () => setAuthMode(!registering);

$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const data = await api(registering ? '/auth/register' : '/auth/login', 'POST', f);
    token = data.token; user = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    e.target.reset();
    start();
  } catch (err) { $('auth-error').textContent = err.message; }
};

function signOut() {
  token = null; user = null; tasks = [];
  localStorage.removeItem('token'); localStorage.removeItem('user');
  if (socket) socket.disconnect();
  $('app-view').hidden = true; $('auth-view').hidden = false;
}
$('logout-btn').onclick = signOut;

// ---------- Real-time ----------
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  socket.on('connect', () => { $('live').textContent = 'Live'; $('live').classList.add('on'); });
  socket.on('disconnect', () => { $('live').textContent = 'Offline'; $('live').classList.remove('on'); });
  socket.on('task:upsert', upsert);
  socket.on('task:delete', ({ id }) => { tasks = tasks.filter((t) => t.id !== id); render(); });
}
function upsert(task) {
  const i = tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) tasks[i] = task; else tasks.unshift(task);
  render();
}

// ---------- Rendering (textContent only, so task text can never inject HTML) ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function card(t) {
  const c = el('article', 'card');
  c.append(el('h3', '', t.title));
  if (t.description) c.append(el('p', 'desc', t.description));
  const meta = el('div', 'meta');
  meta.append(el('span', `tag ${t.priority}`, t.priority));
  if (t.due_date) {
    const late = t.status !== 'done' && t.due_date < new Date().toISOString().slice(0, 10);
    meta.append(el('span', late ? 'due late' : 'due', (late ? 'Overdue · ' : 'Due ') + t.due_date));
  }
  c.append(meta);

  const idx = COLUMNS.findIndex((x) => x.key === t.status);
  const bar = el('div', 'bar');
  const btn = (label, fn, cls = '') => { const b = el('button', 'mini ' + cls, label); b.onclick = fn; bar.append(b); };
  if (idx > 0) btn('← ' + COLUMNS[idx - 1].label, () => move(t, COLUMNS[idx - 1].key));
  if (idx < 2) btn(COLUMNS[idx + 1].label + ' →', () => move(t, COLUMNS[idx + 1].key));
  btn('Edit', () => openDialog(t));
  btn('Delete', () => remove(t), 'danger');
  c.append(bar);
  return c;
}

function render() {
  const board = $('board');
  board.replaceChildren();
  for (const col of COLUMNS) {
    const items = tasks.filter((t) => t.status === col.key);
    const section = el('section', 'col');
    const head = el('h2', '', col.label);
    head.append(el('span', 'count', String(items.length)));
    section.append(head);
    if (!items.length) section.append(el('p', 'empty', col.key === 'todo' ? 'Nothing here. Add a task to get started.' : 'No tasks yet.'));
    items.forEach((t) => section.append(card(t)));
    board.append(section);
  }
}

// ---------- Actions ----------
const fail = (err) => alert(err.message);
const move = (t, status) => api(`/tasks/${t.id}`, 'PUT', { status }).then(upsert).catch(fail);
const remove = (t) => confirm(`Delete "${t.title}"?`) &&
  api(`/tasks/${t.id}`, 'DELETE').then(() => { tasks = tasks.filter((x) => x.id !== t.id); render(); }).catch(fail);

function openDialog(t) {
  editingId = t ? t.id : null;
  const f = $('task-form');
  $('dialog-title').textContent = t ? 'Edit task' : 'Add task';
  f.title.value = t?.title ?? '';
  f.description.value = t?.description ?? '';
  f.priority.value = t?.priority ?? 'medium';
  f.due_date.value = t?.due_date ?? '';
  $('task-dialog').showModal();
}
$('add-btn').onclick = () => openDialog(null);
$('cancel-btn').onclick = () => $('task-dialog').close();

$('task-form').onsubmit = (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const req = editingId ? api(`/tasks/${editingId}`, 'PUT', f) : api('/tasks', 'POST', f);
  req.then((t) => { upsert(t); $('task-dialog').close(); }).catch(fail);
};

// ---------- Start ----------
async function start() {
  if (!token) { $('auth-view').hidden = false; $('app-view').hidden = true; return; }
  $('auth-view').hidden = true; $('app-view').hidden = false;
  $('who').textContent = user?.name || '';
  try { tasks = await api('/tasks'); render(); connectSocket(); } catch (err) { /* signOut already handled 401 */ }
}
setAuthMode(false);
start();
