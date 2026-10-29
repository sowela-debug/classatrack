
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ADMIN_PASSWORD || !SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error(
    "Set ADMIN_PASSWORD and a SESSION_SECRET of at least 32 characters in .env"
  );
  process.exit(1);
}

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "classtrack.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user'
      CHECK (role IN ('user', 'admin')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attended_date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    UNIQUE(user_id, attended_date)
  );
`);

const adminExists = db.prepare(
  "SELECT id FROM users WHERE username = ?"
).get(ADMIN_USERNAME);

if (!adminExists) {
  const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 12);

  db.prepare(`
    INSERT INTO users (username, password_hash, role)
    VALUES (?, ?, 'admin')
  `).run(ADMIN_USERNAME, passwordHash);

  console.log("Master admin account created.");
} else {
  db.prepare(
    "UPDATE users SET role = 'admin' WHERE username = ?"
  ).run(ADMIN_USERNAME);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));

app.use(session({
  name: "classtrack.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

function validDate(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Please log in first."
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user ||
      req.session.user.role !== "admin") {
    return res.status(403).json({
      error: "Administrator access required."
    });
  }
  next();
}

function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role
  };
}

app.get("/api/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post("/api/register", (req, res) => {
  const username = typeof req.body.username === "string"
    ? req.body.username.trim()
    : "";
  const password = typeof req.body.password === "string"
    ? req.body.password
    : "";

  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) {
    return res.status(400).json({
      error: "Username must be 3–24 characters using letters, numbers, dots, dashes or underscores."
    });
  }

  if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) {
    return res.status(400).json({
      error: "That username is reserved."
    });
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({
      error: "Password must be at least 8 characters."
    });
  }

  try {
    const hash = bcrypt.hashSync(password, 12);

    const result = db.prepare(`
      INSERT INTO users (username, password_hash, role)
      VALUES (?, ?, 'user')
    `).run(username, hash);

    const user = safeUser(
      db.prepare(
        "SELECT id, username, role FROM users WHERE id = ?"
      ).get(result.lastInsertRowid)
    );

    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({
          error: "Could not start your session."
        });
      }

      req.session.user = user;
      res.json({ user });
    });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({
        error: "That username is already taken."
      });
    }

    console.error(err);
    res.status(500).json({
      error: "Could not create account."
    });
  }
});

app.post("/api/login", (req, res) => {
  const username = typeof req.body.username === "string"
    ? req.body.username.trim()
    : "";
  const password = typeof req.body.password === "string"
    ? req.body.password
    : "";

  const user = db.prepare(
    "SELECT * FROM users WHERE username = ?"
  ).get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({
      error: "Incorrect username or password."
    });
  }

  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({
        error: "Could not start your session."
      });
    }

    req.session.user = safeUser(user);
    res.json({ user: req.session.user });
  });
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({
        error: "Could not log out."
      });
    }

    res.clearCookie("classtrack.sid");
    res.json({ ok: true });
  });
});

app.get("/api/attendance", requireAuth, (req, res) => {
  const records = db.prepare(`
    SELECT attended_date AS date, note
    FROM attendance
    WHERE user_id = ?
    ORDER BY attended_date
  `).all(req.session.user.id);

  res.json({ attendance: records });
});

app.post("/api/attendance", requireAuth, (req, res) => {
  const date = req.body.date;
  const note = typeof req.body.note === "string"
    ? req.body.note.trim()
    : "";

  if (!validDate(date)) {
    return res.status(400).json({
      error: "Choose a valid date."
    });
  }

  if (note.length > 200) {
    return res.status(400).json({
      error: "Note must be 200 characters or fewer."
    });
  }

  db.prepare(`
    INSERT INTO attendance (user_id, attended_date, note)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, attended_date)
    DO UPDATE SET note = excluded.note
  `).run(req.session.user.id, date, note);

  res.json({ ok: true });
});

app.delete("/api/attendance/:date", requireAuth, (req, res) => {
  if (!validDate(req.params.date)) {
    return res.status(400).json({
      error: "Choose a valid date."
    });
  }

  db.prepare(`
    DELETE FROM attendance
    WHERE user_id = ? AND attended_date = ?
  `).run(req.session.user.id, req.params.date);

  res.json({ ok: true });
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.role, u.created_at,
      COUNT(a.id) AS attendance_count
    FROM users u
    LEFT JOIN attendance a ON a.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();

  res.json({ users });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid user." });
  }

  const user = db.prepare(
    "SELECT id, role FROM users WHERE id = ?"
  ).get(id);

  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  if (user.role === "admin") {
    return res.status(400).json({
      error: "The master admin cannot be deleted here."
    });
  }

  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`ClassTrack is running on port ${PORT}`);
});
