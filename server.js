require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('Set JWT_SECRET in .env');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  dateStrings: true, // DATE columns come back as 'YYYY-MM-DD'
  connectionLimit: 10,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Auth ----------
const sign = (u) => jwt.sign({ id: u.id, name: u.name }, SECRET, { expiresIn: '7d' });

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  try {
    req.user = jwt.verify(header.startsWith('Bearer ') ? header.slice(7) : '', SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

app.post('/api/auth/register', async (req, res) => {
  const { name = '', email = '', password = '' } = req.body;
  if (!name.trim() || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
    return res.status(400).json({ error: 'Enter a name, a valid email and a password of 8+ characters.' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const [r] = await db.execute(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name.trim(), email.toLowerCase(), hash]
    );
    const user = { id: r.insertId, name: name.trim() };
    res.status(201).json({ token: sign(user), user });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That email already has an account.' });
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email = '', password = '' } = req.body;
  const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  const user = { id: u.id, name: u.name };
  res.json({ token: sign(user), user });
});

// ---------- Tasks (every query is scoped to the signed-in user) ----------
const STATUS = ['todo', 'doing', 'done'];
const PRIORITY = ['low', 'medium', 'high'];

function pickFields(body) {
  const out = {};
  if (body.title !== undefined) out.title = String(body.title).trim().slice(0, 200);
  if (body.description !== undefined) out.description = String(body.description).slice(0, 5000);
  if (body.status !== undefined && STATUS.includes(body.status)) out.status = body.status;
  if (body.priority !== undefined && PRIORITY.includes(body.priority)) out.priority = body.priority;
  if (body.due_date !== undefined) out.due_date = /^\d{4}-\d{2}-\d{2}$/.test(body.due_date) ? body.due_date : null;
  return out;
}

const getTask = async (id, userId) => {
  const [rows] = await db.execute('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [id, userId]);
  return rows[0];
};
const notify = (userId, event, payload) => io.to(`user:${userId}`).emit(event, payload);

app.get('/api/tasks', requireAuth, async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.json(rows);
});

app.post('/api/tasks', requireAuth, async (req, res) => {
  const f = pickFields(req.body);
  if (!f.title) return res.status(400).json({ error: 'Give the task a title.' });
  const [r] = await db.execute(
    'INSERT INTO tasks (user_id, title, description, status, priority, due_date) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.id, f.title, f.description ?? '', f.status ?? 'todo', f.priority ?? 'medium', f.due_date ?? null]
  );
  const task = await getTask(r.insertId, req.user.id);
  notify(req.user.id, 'task:upsert', task);
  res.status(201).json(task);
});

app.put('/api/tasks/:id', requireAuth, async (req, res) => {
  const f = pickFields(req.body);
  if (f.title === '') return res.status(400).json({ error: 'A task needs a title.' });
  const keys = Object.keys(f);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to update.' });
  const [r] = await db.execute(
    `UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND user_id = ?`,
    [...keys.map((k) => f[k]), req.params.id, req.user.id]
  );
  if (!r.affectedRows) return res.status(404).json({ error: 'Task not found.' });
  const task = await getTask(req.params.id, req.user.id);
  notify(req.user.id, 'task:upsert', task);
  res.json(task);
});

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  const [r] = await db.execute('DELETE FROM tasks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Task not found.' });
  notify(req.user.id, 'task:delete', { id: Number(req.params.id) });
  res.status(204).end();
});

// ---------- Real-time: one room per user, so all their tabs and devices stay in sync ----------
io.use((socket, next) => {
  try {
    const user = jwt.verify(socket.handshake.auth.token || '', SECRET);
    socket.join(`user:${user.id}`);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Task manager running at http://localhost:${PORT}`));
