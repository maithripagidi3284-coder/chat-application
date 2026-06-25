// @ts-nocheck
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const app    = express();
const http   = createServer(app);
const io     = new Server(http, { cors: { origin: '*' } });
const pool   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const PORT          = 3000;
const ACCESS_SECRET  = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_SECRET + '_refresh';

// ── DB setup ──────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   TEXT   UNIQUE NOT NULL,
      email      TEXT   UNIQUE,
      password   TEXT   NOT NULL,
      bio        TEXT   DEFAULT '',
      avatar_url TEXT   DEFAULT NULL,
      is_public  BOOLEAN DEFAULT TRUE
    );

    -- Migrate existing users table if columns are missing
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio        TEXT    DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT    DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_public  BOOLEAN DEFAULT TRUE;

    CREATE TABLE IF NOT EXISTS rooms (
      id         SERIAL PRIMARY KEY,
      name       TEXT   UNIQUE NOT NULL,
      password   TEXT,
      created_by TEXT   NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      room       TEXT      NOT NULL,
      user_id    INTEGER   NOT NULL,
      username   TEXT      NOT NULL,
      content    TEXT      NOT NULL,
      is_edited  BOOLEAN   DEFAULT FALSE,
      is_deleted BOOLEAN   DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reactions (
      id         SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL,
      username   TEXT    NOT NULL,
      emoji      TEXT    NOT NULL,
      UNIQUE(message_id, username, emoji)
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      token      TEXT    UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS invites (
      id          SERIAL PRIMARY KEY,
      room        TEXT NOT NULL,
      from_user   TEXT NOT NULL,
      to_user     TEXT NOT NULL,
      status      TEXT DEFAULT 'pending',
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      id          SERIAL PRIMARY KEY,
      from_user   TEXT NOT NULL,
      to_user     TEXT NOT NULL,
      status      TEXT DEFAULT 'pending',
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_user, to_user)
    );
    CREATE TABLE IF NOT EXISTS friends (
      id         SERIAL PRIMARY KEY,
      user_a     TEXT NOT NULL,
      user_b     TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_a, user_b)
    );

    -- Seed default rooms if not exist
    INSERT INTO rooms (name, created_by) VALUES
      ('General',    'system'),
      ('Technology', 'system'),
      ('Gaming',     'system'),
      ('Music',      'system'),
      ('Movies',     'system')
    ON CONFLICT (name) DO NOTHING;
  `);
  console.log('DB tables ready');
}
initDB().catch(console.error);

// ── Helpers ───────────────────────────────────────────────────────────────────
const makeTokens = (user) => {
  const accessToken  = jwt.sign({ id: user.id, username: user.username }, ACCESS_SECRET,  { expiresIn: '7d' });
  const refreshToken = jwt.sign({ id: user.id, username: user.username }, REFRESH_SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken };
};

const allowedOrigins = [
  'https://chat-application-cyan-delta.vercel.app',
  /^https:\/\/chat-application-.*\.vercel\.app$/,
  'http://localhost:3000',
  'http://localhost:5173'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.some(o => o instanceof RegExp ? o.test(origin) : o === origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS: ' + origin));
    }
  },
  credentials: true
}));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' })); // allow base64 avatars

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, ACCESS_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};
// ── AI Bot route ──────────────────────────────────────────────────────────────
app.post('/api/bot', auth, async (req, res) => {
  const { userMessage, contextMessages, currentUsername } = req.body;
  if (!userMessage) return res.status(400).json({ error: 'Missing userMessage' });

  const systemPrompt = `You are a helpful AI assistant in a group chat room. You can see the recent conversation history.
Current user asking: ${currentUsername}
Recent conversation:
${contextMessages || ''}

Be concise, helpful, and friendly. You're in a chat room so keep responses reasonably short unless detail is needed.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err?.error?.message || 'Bot request failed' });
    }

    const data = await response.json();
    res.json({ reply: data.choices?.[0]?.message?.content || "Sorry, I couldn't generate a response." });
  } catch (err) {
    console.error('Bot error:', err);
    res.status(500).json({ error: 'Server error calling bot' });
  }
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, email, password) VALUES ($1, $2, $3)', [username, email || null, hash]);
    res.json({ message: 'Registered successfully' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, username, password } = req.body;
  const identifier = email || username;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1 OR username = $1', [identifier]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Invalid credentials' });
    const { accessToken, refreshToken } = makeTokens(user);
    await pool.query('INSERT INTO refresh_tokens (user_id, token) VALUES ($1, $2)', [user.id, refreshToken]);
    res.json({ accessToken, refreshToken, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'No refresh token' });
  try {
    const payload = jwt.verify(refreshToken, REFRESH_SECRET);
    const { rows } = await pool.query('SELECT * FROM refresh_tokens WHERE token = $1', [refreshToken]);
    if (!rows.length) return res.status(403).json({ error: 'Refresh token revoked' });
    const accessToken = jwt.sign({ id: payload.id, username: payload.username }, ACCESS_SECRET, { expiresIn: '7d' });
    res.json({ accessToken });
  } catch {
    res.status(403).json({ error: 'Invalid refresh token' });
  }
});

app.post('/api/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]).catch(() => {});
  res.json({ message: 'Logged out' });
});

// ── Profile routes ────────────────────────────────────────────────────────────

// GET /api/profile/:username — returns profile + friends list + friend_status relative to requester
app.get('/api/profile/:username', auth, async (req, res) => {
  const { username } = req.params;
  const me = req.user.username;
  try {
    const { rows } = await pool.query(
      'SELECT username, bio, avatar_url, is_public FROM users WHERE username = $1',
      [username]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];

    // Friends list
    const { rows: friendRows } = await pool.query(
      `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END as friend
       FROM friends WHERE user_a = $1 OR user_b = $1`,
      [username]
    );
    const friends = friendRows.map(r => r.friend);

    // Friend status between viewer (me) and target (username)
    let friend_status = 'none';
    if (me !== username) {
      // Are they already friends?
      const { rows: fRows } = await pool.query(
        `SELECT id FROM friends WHERE (user_a=$1 AND user_b=$2) OR (user_a=$2 AND user_b=$1)`,
        [me, username]
      );
      if (fRows.length) {
        friend_status = 'friends';
      } else {
        // Check pending requests
        const { rows: rRows } = await pool.query(
          `SELECT from_user, to_user FROM friend_requests
           WHERE ((from_user=$1 AND to_user=$2) OR (from_user=$2 AND to_user=$1))
             AND status='pending'`,
          [me, username]
        );
        if (rRows.length) {
          friend_status = rRows[0].from_user === me ? 'pending_sent' : 'pending_received';
        }
      }
    }

    res.json({ profile: { ...u, friends, friend_status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/profile — update own bio, avatar, is_public
app.put('/api/profile', auth, async (req, res) => {
  const { bio, avatar_url, is_public } = req.body;
  try {
    await pool.query(
      'UPDATE users SET bio=$1, avatar_url=$2, is_public=$3 WHERE id=$4',
      [bio ?? '', avatar_url ?? null, is_public ?? true, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Friend request routes ─────────────────────────────────────────────────────

// POST /api/friend-requests — send a request (only to public accounts or existing contacts)
app.post('/api/friend-requests', auth, async (req, res) => {
  const { to_user } = req.body;
  const from_user = req.user.username;
  if (!to_user) return res.status(400).json({ error: 'Missing to_user' });
  if (to_user === from_user) return res.status(400).json({ error: 'Cannot friend yourself' });

  try {
    // Check target exists and is public
    const { rows: userRows } = await pool.query('SELECT username, is_public FROM users WHERE username=$1', [to_user]);
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    if (!userRows[0].is_public) return res.status(403).json({ error: 'This account is private' });

    // Already friends?
    const { rows: fRows } = await pool.query(
      `SELECT id FROM friends WHERE (user_a=$1 AND user_b=$2) OR (user_a=$2 AND user_b=$1)`,
      [from_user, to_user]
    );
    if (fRows.length) return res.status(409).json({ error: 'Already friends' });

    // Already has a pending request?
    const { rows: existing } = await pool.query(
      `SELECT id FROM friend_requests WHERE from_user=$1 AND to_user=$2 AND status='pending'`,
      [from_user, to_user]
    );
    if (existing.length) return res.status(409).json({ error: 'Request already sent' });

    const { rows: inserted } = await pool.query(
      'INSERT INTO friend_requests (from_user, to_user) VALUES ($1, $2) RETURNING id',
      [from_user, to_user]
    );

    // Real-time notify via socket
    io.to(`user:${to_user}`).emit('friend_request', { from: from_user, id: inserted[0].id });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/friend-requests — get pending requests sent TO me
app.get('/api/friend-requests', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM friend_requests WHERE to_user=$1 AND status='pending' ORDER BY created_at DESC`,
      [req.user.username]
    );
    res.json({ requests: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/friend-requests/:id — accept or decline
app.put('/api/friend-requests/:id', auth, async (req, res) => {
  const { status } = req.body; // 'accepted' or 'declined'
  try {
    const { rows } = await pool.query('SELECT * FROM friend_requests WHERE id=$1', [req.params.id]);
    const req_ = rows[0];
    if (!req_) return res.status(404).json({ error: 'Request not found' });
    if (req_.to_user !== req.user.username) return res.status(403).json({ error: 'Forbidden' });

    await pool.query('UPDATE friend_requests SET status=$1 WHERE id=$2', [status, req.params.id]);

    if (status === 'accepted') {
      // Insert into friends (canonical order to avoid duplicates)
      const [a, b] = [req_.from_user, req_.to_user].sort();
      await pool.query(
        'INSERT INTO friends (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [a, b]
      );
      // Notify sender that request was accepted
      io.to(`user:${req_.from_user}`).emit('friend_request_accepted', { by: req.user.username });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/friends/:username — unfriend
app.delete('/api/friends/:username', auth, async (req, res) => {
  const me = req.user.username;
  const other = req.params.username;
  try {
    await pool.query(
      `DELETE FROM friends WHERE (user_a=$1 AND user_b=$2) OR (user_a=$2 AND user_b=$1)`,
      [me, other]
    );
    // Also clean up any friend_requests between the two
    await pool.query(
      `DELETE FROM friend_requests WHERE (from_user=$1 AND to_user=$2) OR (from_user=$2 AND to_user=$1)`,
      [me, other]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Rooms routes ──────────────────────────────────────────────────────────────
app.get('/api/rooms', auth, async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, created_by, CASE WHEN password IS NOT NULL THEN true ELSE false END as has_password FROM rooms ORDER BY id');
    res.json({ rooms: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/rooms', auth, async (req, res) => {
  const { name, password } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });
  try {
    const hash = password ? await bcrypt.hash(password, 10) : null;
    const { rows } = await pool.query(
      'INSERT INTO rooms (name, password, created_by) VALUES ($1, $2, $3) RETURNING *',
      [name, hash, req.user.username]
    );
    res.json({ room: { id: rows[0].id, name: rows[0].name, has_password: !!password, created_by: req.user.username } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Room already exists' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/rooms/:name/join', auth, async (req, res) => {
  const { password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM rooms WHERE name = $1', [req.params.name]);
    const room = rows[0];
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.password) {
      if (!password) return res.status(403).json({ error: 'Password required', needsPassword: true });
      const valid = await bcrypt.compare(password, room.password);
      if (!valid) return res.status(403).json({ error: 'Wrong password' });
    }
    res.json({ success: true, room: { id: room.id, name: room.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Invite routes ─────────────────────────────────────────────────────────────
app.post('/api/invites', auth, async (req, res) => {
  const { to_user, room } = req.body;
  if (!to_user || !room) return res.status(400).json({ error: 'Missing fields' });
  try {
    const { rows: userRows } = await pool.query('SELECT id FROM users WHERE username = $1', [to_user]);
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    await pool.query('INSERT INTO invites (room, from_user, to_user) VALUES ($1, $2, $3)', [room, req.user.username, to_user]);
    io.emit(`invite:${to_user}`, { room, from: req.user.username });
    res.json({ message: 'Invite sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/invites', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM invites WHERE to_user = $1 AND status = 'pending' ORDER BY created_at DESC",
      [req.user.username]
    );
    res.json({ invites: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/invites/:id', auth, async (req, res) => {
  const { status } = req.body;
  try {
    await pool.query('UPDATE invites SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Invite links ──────────────────────────────────────────────────────────────
app.post('/api/invite-links', auth, async (req, res) => {
  const { room } = req.body;
  try {
    const token = jwt.sign({ room }, ACCESS_SECRET, { expiresIn: '24h' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/invite-links/:token', async (req, res) => {
  try {
    const data = jwt.verify(req.params.token, ACCESS_SECRET);
    res.json({ room: data.room });
  } catch {
    res.status(400).json({ error: 'Invalid or expired link' });
  }
});

// ── Message routes ────────────────────────────────────────────────────────────
app.get('/api/messages/:room', auth, async (req, res) => {
  const { room } = req.params;
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;
  try {
    const { rows: [{ count }] } = await pool.query('SELECT COUNT(*) FROM messages WHERE room = $1', [room]);
    const { rows: msgs } = await pool.query(
      'SELECT * FROM messages WHERE room = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3',
      [room, limit, offset]
    );
    const { rows: reactions } = await pool.query(
      'SELECT message_id, emoji, username FROM reactions WHERE message_id = ANY($1::int[])',
      [msgs.map(m => m.id)]
    );
    const withReactions = msgs.map(m => ({ ...m, reactions: reactions.filter(r => r.message_id === m.id) }));
    res.json({ messages: withReactions, total: parseInt(count), page, limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/messages/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [req.params.id]);
    const msg = rows[0];
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.username !== req.user.username) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('UPDATE messages SET is_deleted = TRUE WHERE id = $1', [req.params.id]);
    io.to(msg.room).emit('message_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/messages/:id', auth, async (req, res) => {
  const { content } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [req.params.id]);
    const msg = rows[0];
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.username !== req.user.username) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('UPDATE messages SET content = $1, is_edited = TRUE WHERE id = $2', [content, req.params.id]);
    io.to(msg.room).emit('message_edited', { id: msg.id, content });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/messages/:id/react', auth, async (req, res) => {
  const { emoji } = req.body;
  const messageId = parseInt(req.params.id);
  const { username } = req.user;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM reactions WHERE message_id = $1 AND username = $2 AND emoji = $3',
      [messageId, username, emoji]
    );
    if (rows.length > 0) {
      await pool.query('DELETE FROM reactions WHERE id = $1', [rows[0].id]);
    } else {
      await pool.query('INSERT INTO reactions (message_id, username, emoji) VALUES ($1, $2, $3)', [messageId, username, emoji]);
    }
    const { rows: reactions } = await pool.query('SELECT emoji, username FROM reactions WHERE message_id = $1', [messageId]);
    const { rows: msgRows }   = await pool.query('SELECT room FROM messages WHERE id = $1', [messageId]);
    io.to(msgRows[0].room).emit('reactions_updated', { messageId, reactions });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
const onlineUsers = {};

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));
  try {
    socket.user = jwt.verify(token, ACCESS_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log('Connected:', socket.user.username);
  onlineUsers[socket.id] = socket.user.username;

  // Join personal room for targeted notifications (invites, friend requests)
  socket.join(`user:${socket.user.username}`);

  socket.on('join_room', (room) => {
    socket.join(room);
    socket.currentRoom = room;
    io.to(room).emit('user_joined', { username: socket.user.username, onlineUsers });
  });

  socket.on('send_message', async ({ room, message }) => {
    try {
      const { rows } = await pool.query(
        'INSERT INTO messages (room, user_id, username, content) VALUES ($1, $2, $3, $4) RETURNING *',
        [room, socket.user.id, socket.user.username, message]
      );
      const saved = rows[0];
      io.to(room).emit('receive_message', {
        id:         saved.id,
        username:   saved.username,
        message:    saved.content,
        time:       new Date(saved.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        is_edited:  false,
        is_deleted: false,
        reactions:  [],
      });
    } catch (err) {
      console.error('send_message error:', err);
    }
  });

  socket.on('typing', () => {
    if (socket.currentRoom)
      socket.to(socket.currentRoom).emit('user_typing', socket.user.username);
  });

  socket.on('disconnect', () => {
    delete onlineUsers[socket.id];
    if (socket.currentRoom)
      io.to(socket.currentRoom).emit('user_left', { username: socket.user.username, onlineUsers });
  });
});

http.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));