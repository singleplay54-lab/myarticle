require("dotenv").config();

const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is missing.");
  process.exit(1);
}
if (!process.env.ADMIN_PASSWORD_HASH) {
  console.error("ADMIN_PASSWORD_HASH is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const publicDir = __dirname;
app.use(express.static(publicDir));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS articles (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'Admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log("Database ready.");
}

function requireAdmin(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) return res.status(401).json({ error: "Login required." });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== "admin") throw new Error("Invalid role");
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Login again." });
  }
}

app.get("/api/articles", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, title, content, author, created_at FROM articles ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load articles." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const password = String(req.body.password || "");
    const ok = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
    if (!ok) return res.status(401).json({ error: "Wrong password." });

    const token = jwt.sign({ role: "admin" }, process.env.JWT_SECRET, { expiresIn: "2h" });

    res.cookie("admin_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 2 * 60 * 60 * 1000
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed." });
  }
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("admin_token");
  res.json({ success: true });
});

app.get("/api/admin/check", requireAdmin, (req, res) => {
  res.json({ loggedIn: true });
});

app.post("/api/articles", requireAdmin, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const content = String(req.body.content || "").trim();
  const author = String(req.body.author || "Admin").trim() || "Admin";

  if (!title || !content) {
    return res.status(400).json({ error: "Title and content are required." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO articles (title, content, author)
       VALUES ($1, $2, $3)
       RETURNING id, title, content, author, created_at`,
      [title, content, author]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not publish article." });
  }
});

app.put("/api/articles/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = String(req.body.title || "").trim();
  const content = String(req.body.content || "").trim();
  const author = String(req.body.author || "Admin").trim() || "Admin";

  if (!Number.isInteger(id) || !title || !content) {
    return res.status(400).json({ error: "Valid id, title and content are required." });
  }

  try {
    const result = await pool.query(
      `UPDATE articles
       SET title=$1, content=$2, author=$3
       WHERE id=$4
       RETURNING id, title, content, author, created_at`,
      [title, content, author, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Article not found." });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update article." });
  }
});

app.delete("/api/articles/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id." });

  try {
    const result = await pool.query("DELETE FROM articles WHERE id=$1", [id]);
    if (!result.rowCount) return res.status(404).json({ error: "Article not found." });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete article." });
  }
});

app.get("/articles", (req, res) => {
  res.sendFile(path.join(publicDir, "articles.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`GyanTech running on port ${PORT}`)))
  .catch(err => {
    console.error("Startup failed:", err);
    process.exit(1);
  });
