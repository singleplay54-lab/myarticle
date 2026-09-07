const express=require('express');
const cookieParser=require('cookie-parser');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const {Pool}=require('pg');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

const app=express();
const PORT=process.env.PORT||10000;
const SITE_URL='https://gyantech-blog.onrender.com';

const pool=new Pool({
  connectionString:process.env.DATABASE_URL,
  ssl:process.env.NODE_ENV==='production'
    ?{rejectUnauthorized:false}
    :false
});

app.use(express.json({limit:'1mb'}));
app.use(cookieParser());
app.use(express.static(__dirname,{extensions:['html']}));

function esc(v){
  return String(v??'').replace(/[&<>"']/g,m=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#039;'
  }[m]));
}

function text(v){
  return String(v||'')
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function slugify(v){
  return String(v||'')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu,'')
    .replace(/\s+/g,'-')
    .replace(/-+/g,'-')
    .replace(/^-|-$/g,'')
    .slice(0,80)||'article';
}

function ip(req){
  return req.ip||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim()||
    req.socket?.remoteAddress||
    'unknown';
}

function ipHash(req){
  return crypto
    .createHash('sha256')
    .update(
      ip(req)+'|'+
      (process.env.JWT_SECRET||'gyantech')
    )
    .digest('hex');
}

/* =========================
   DATABASE
========================= */

async function init(){

  await pool.query(`
    CREATE TABLE IF NOT EXISTS articles(
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'Admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for(const q of [

    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS slug TEXT`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS excerpt TEXT DEFAULT ''`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Technology'`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT ''`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT ''`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'published'`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS views INTEGER DEFAULT 0`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`

  ]){
    await pool.query(q);
  }

  await pool.query(`
    UPDATE articles
    SET slug=CONCAT(
      REGEXP_REPLACE(
        LOWER(title),
        '[^a-z0-9]+',
        '-',
        'g'
      ),
      '-',
      id
    )
    WHERE slug IS NULL OR slug=''
  `);

  await pool.query(`
    UPDATE articles
    SET status='published'
    WHERE status IS NULL
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS articles_slug_unique
    ON articles(slug)
  `);

  /* NEWSLETTER */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS newsletter_subscribers(
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /* COMMENTS */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments(
      id SERIAL PRIMARY KEY,
      article_id INTEGER NOT NULL
        REFERENCES articles(id)
        ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      comment TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      ip_hash TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for(const q of [

    `ALTER TABLE comments ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`,
    `ALTER TABLE comments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`,
    `ALTER TABLE comments ADD COLUMN IF NOT EXISTS ip_hash TEXT DEFAULT ''`,
    `ALTER TABLE comments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE`

  ]){
    try{
      await pool.query(q);
    }catch(e){
      console.error('Comment migration:',e.message);
    }
  }

  await pool.query(`
    CREATE INDEX IF NOT EXISTS comments_article_idx
    ON comments(article_id,created_at DESC)
  `);

  /* LIKES */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comment_likes(
      id SERIAL PRIMARY KEY,
      comment_id INTEGER NOT NULL
        REFERENCES comments(id)
        ON DELETE CASCADE,
      ip_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(comment_id,ip_hash)
    )
  `);

  /* REPORTS */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comment_reports(
      id SERIAL PRIMARY KEY,
      comment_id INTEGER NOT NULL
        REFERENCES comments(id)
        ON DELETE CASCADE,
      reason TEXT NOT NULL DEFAULT 'other',
      ip_hash TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS comment_reports_status_idx
    ON comment_reports(status,created_at DESC)
  `);

  console.log('Database initialization completed.');
}

/* =========================
   AUTH
========================= */

function auth(req,res,next){

  try{

    const d=jwt.verify(
      req.cookies.admin_token,
      process.env.JWT_SECRET
    );

    if(d.role!=='admin') throw 0;

    next();

  }catch{

    res.status(401).json({
      error:'Unauthorized'
    });

  }
}

/* =========================
   SEO
========================= */

function articleSEO(html,a){

  const description=esc(
    (
      text(a.excerpt||a.content)||
      'Read this article on GyanTech Blog.'
    ).slice(0,155)
  );

  const url=
    SITE_URL+
    '/article/'+
    encodeURIComponent(a.slug);

  const title=esc(
    (a.title||'Article')+
    ' — GyanTech'
  );

  const ld={
    '@context':'https://schema.org',
    '@type':'Article',
    headline:a.title,
    description:text(
      a.excerpt||a.content
    ).slice(0,155),
    url:url,
    datePublished:a.created_at,
    dateModified:a.updated_at||a.created_at,
    author:{
      '@type':'Person',
      name:a.author||'Admin'
    },
    publisher:{
      '@type':'Organization',
      name:'GyanTech Blog',
      url:SITE_URL
    }
  };

  if(a.image_url){
    ld.image=[a.image_url];
  }

  return html.replace(
    /<\/head>/i,
`
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${esc(url)}">

<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${esc(url)}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">

<script type="application/ld+json">${
  JSON.stringify(ld).replace(/</g,'\\u003c')
}</script>

</head>`
  );
}

/* =========================
   PAGES
========================= */

app.get('/',(req,res)=>
  res.sendFile(
    'index.html',
    {root:__dirname}
  )
);

app.get('/articles',(req,res)=>
  res.sendFile(
    'articles.html',
    {root:__dirname}
  )
);

app.get('/admin',(req,res)=>
  res.sendFile(
    'admin.html',
    {root:__dirname}
  )
);

app.get('/category/:category',(req,res)=>
  res.sendFile(
    'category.html',
    {root:__dirname}
  )
);

/* =========================
   LOGIN
========================= */

app.post('/api/login',async(req,res)=>{

  try{

    const password=
      String(req.body.password||'');

    const valid=
      await bcrypt.compare(
        password,
        process.env.ADMIN_PASSWORD_HASH||''
      );

    if(!valid){

      return res.status(401).json({
        error:'Invalid password'
      });

    }

    const token=
      jwt.sign(
        {role:'admin'},
        process.env.JWT_SECRET,
        {expiresIn:'7d'}
      );

    res.cookie(
      'admin_token',
      token,
      {
        httpOnly:true,
        sameSite:'lax',
        secure:
          process.env.NODE_ENV===
          'production',
        maxAge:604800000
      }
    );

    res.json({
      ok:true
    });

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:'Login failed'
    });

  }

});

app.post('/api/logout',(req,res)=>{

  res.clearCookie(
    'admin_token'
  );

  res.json({
    ok:true
  });

});

app.get('/api/admin/check',(req,res)=>{

  try{

    const d=
      jwt.verify(
        req.cookies.admin_token,
        process.env.JWT_SECRET
      );

    res.json({
      authenticated:
        d.role==='admin'
    });

  }catch{

    res.json({
      authenticated:false
    });

  }

});

/* =========================
   NEWSLETTER
========================= */

app.post(
  '/api/newsletter/subscribe',
  async(req,res)=>{

  try{

    const email=
      String(
        req.body.email||''
      )
      .trim()
      .toLowerCase();

    if(
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/
      .test(email)
    ){

      return res.status(400).json({
        error:
          'Please enter a valid email address.'
      });

    }

    const r=
      await pool.query(
`
INSERT INTO newsletter_subscribers(email)
VALUES($1)
ON CONFLICT(email)
DO NOTHING
RETURNING id
`,
        [email]
      );

    res.status(201).json({
      ok:true,
      message:
        r.rows.length
          ?'You’re subscribed! Thanks for joining GyanTech Blog.'
          :'This email is already subscribed.'
    });

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:
        'Could not subscribe right now.'
    });

  }

});

/* =========================
   ARTICLE + SEO
========================= */

app.get(
  '/article/:slug',
  async(req,res)=>{

  try{

    const r=
      await pool.query(
`
SELECT *
FROM articles
WHERE slug=$1
AND status='published'
LIMIT 1
`,
        [req.params.slug]
      );

    if(!r.rows.length){

      return res
        .status(404)
        .sendFile(
          'article.html',
          {root:__dirname}
        );

    }

    const html=
      fs.readFileSync(
        path.join(
          __dirname,
          'article.html'
        ),
        'utf8'
      );

    res.send(
      articleSEO(
        html,
        r.rows[0]
      )
    );

  }catch(e){

    console.error(e);

    res
      .status(500)
      .sendFile(
        'article.html',
        {root:__dirname}
      );

  }

});

/* =========================
   SITEMAP
========================= */

app.get(
  '/sitemap.xml',
  async(req,res)=>{

  try{

    const r=
      await pool.query(`
        SELECT
          slug,
          created_at,
          updated_at
        FROM articles
        WHERE status='published'
        ORDER BY created_at DESC
      `);

    let xml=
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">

<url>
  <loc>${SITE_URL}/</loc>
</url>

<url>
  <loc>${SITE_URL}/articles</loc>
</url>
`;

    for(const a of r.rows){

      xml+=`
<url>
  <loc>${esc(
    SITE_URL+
    '/article/'+
    encodeURIComponent(a.slug)
  )}</loc>
  <lastmod>${
    new Date(
      a.updated_at||
      a.created_at
    ).toISOString()
  }</lastmod>
</url>
`;

    }

    xml+=
      '</urlset>';

    res
      .type('application/xml')
      .send(xml);

  }catch(e){

    console.error(e);

    res
      .status(500)
      .send(
        'Sitemap unavailable'
      );

  }

});

/* =========================
   PUBLIC ARTICLES
========================= */

app.get(
  '/api/articles',
  async(req,res)=>{

  try{

    const q=
      String(
        req.query.q||''
      ).trim();

    const category=
      String(
        req.query.category||''
      ).trim();

    const page=
      Math.max(
        1,
        Number(req.query.page)||1
      );

    const limit=
      Math.min(
        30,
        Math.max(
          1,
          Number(req.query.limit)||9
        )
      );

    let params=[];

    let where=[
      `status='published'`
    ];

    if(q){

      params.push(
        '%'+q+'%'
      );

      where.push(`
        (
          title ILIKE $${params.length}
          OR content ILIKE $${params.length}
          OR tags ILIKE $${params.length}
          OR category ILIKE $${params.length}
        )
      `);

    }

    if(category){

      params.push(category);

      where.push(
        `category=$${params.length}`
      );

    }

    const condition=
      where.join(' AND ');

    const count=
      await pool.query(
`
SELECT COUNT(*)::int total
FROM articles
WHERE ${condition}
`,
        params
      );

    params.push(
      limit,
      (page-1)*limit
    );

    const result=
      await pool.query(
`
SELECT
  id,
  title,
  slug,
  excerpt,
  author,
  category,
  tags,
  image_url,
  featured,
  views,
  created_at
FROM articles
WHERE ${condition}
ORDER BY
  featured DESC,
  created_at DESC
LIMIT $${params.length-1}
OFFSET $${params.length}
`,
        params
      );

    res.json({
      articles:
        result.rows,
      total:
        count.rows[0].total,
      page,
      limit
    });

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:
        'Could not load articles'
    });

  }

});

/* =========================
   SINGLE ARTICLE API
========================= */

app.get(
  '/api/articles/:slug',
  async(req,res)=>{

  try{

    const r=
      await pool.query(
`
UPDATE articles
SET views=views+1
WHERE slug=$1
AND status='published'
RETURNING *
`,
        [req.params.slug]
      );

    if(!r.rows.length){

      return res.status(404).json({
        error:
          'Article not found'
      });

    }

    const article=
      r.rows[0];

    const c=
      await pool.query(
`
SELECT COUNT(*)::int count
FROM comments
WHERE article_id=$1
AND status='approved'
`,
        [article.id]
      );

    article.comment_count=
      c.rows[0].count;

    res.json(article);

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:
        'Could not load article'
    });

  }

});

/* =========================
   CATEGORIES
========================= */

app.get(
  '/api/categories',
  async(req,res)=>{

  try{

    res.json(
      (
        await pool.query(`
          SELECT
            category,
            COUNT(*)::int count
          FROM articles
          WHERE status='published'
          GROUP BY category
          ORDER BY
            count DESC,
            category
        `)
      ).rows
    );

  }catch(e){

    res.status(500).json({
      error:'Failed'
    });

  }

});

/* =========================
   COMMENT SECURITY
========================= */

const rate=new Map();

function limited(req){

  const key=
    ip(req);

  const now=
    Date.now();

  const old=
    rate.get(key)||[];

  const recent=
    old.filter(
      t=>now-t<600000
    );

  recent.push(now);

  rate.set(
    key,
    recent
  );

  return recent.length>3;
}

function spam(s){

  const links=
    s.match(/https?:\/\//gi)||[];

  const www=
    s.match(/www\./gi)||[];

  return (
    links.length>2||
    www.length>2||
    /(.)\1{12,}/.test(s)
  );

}

/* =========================
   PUBLIC COMMENTS
========================= */

app.get(
  '/api/articles/:slug/comments',
  async(req,res)=>{

  try{

    const article=
      await pool.query(
`
SELECT id
FROM articles
WHERE slug=$1
AND status='published'
`,
        [req.params.slug]
      );

    if(!article.rows.length){

      return res.status(404).json({
        error:
          'Article not found'
      });

    }

    const result=
      await pool.query(
`
SELECT
  c.id,
  c.name,
  c.comment,
  c.created_at,
  c.parent_id,
  COALESCE(
    l.likes,
    0
  )::int likes

FROM comments c

LEFT JOIN(
  SELECT
    comment_id,
    COUNT(*)::int likes
  FROM comment_likes
  GROUP BY comment_id
) l
ON l.comment_id=c.id

WHERE
  c.article_id=$1
  AND c.status='approved'

ORDER BY
  c.created_at ASC
`,
        [article.rows[0].id]
      );

    res.json({
      comments:
        result.rows,
      total:
        result.rows.length
    });

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:
        'Could not load comments'
    });

  }

});

/* =========================
   POST COMMENT / REPLY
========================= */

app.post(
  '/api/articles/:slug/comments',
  async(req,res)=>{

  try{

    if(limited(req)){

      return res.status(429).json({
        error:
          'Too many comments. Please try again later.'
      });

    }

    if(
      String(
        req.body.website||''
      ).trim()
    ){

      return res.status(400).json({
        error:'Spam detected'
      });

    }

    const name=
      String(
        req.body.name||''
      )
      .trim()
      .replace(/\s+/g,' ');

    const email=
      String(
        req.body.email||''
      )
      .trim()
      .toLowerCase();

    const comment=
      String(
        req.body.comment||''
      )
      .trim()
      .replace(/\s+/g,' ');

    if(
      name.length<2||
      name.length>80
    ){

      return res.status(400).json({
        error:
          'Please enter a valid name'
      });

    }

    if(
      email &&
      (
        email.length>160||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      )
    ){

      return res.status(400).json({
        error:
          'Please enter a valid email'
      });

    }

    if(
      comment.length<2||
      comment.length>3000||
      spam(comment)
    ){

      return res.status(400).json({
        error:
          'Invalid or spam comment'
      });

    }

    const article=
      await pool.query(
`
SELECT id
FROM articles
WHERE slug=$1
AND status='published'
`,
        [req.params.slug]
      );

    if(!article.rows.length){

      return res.status(404).json({
        error:
          'Article not found'
      });

    }

    const articleId=
      article.rows[0].id;

    const parent=
      req.body.parent_id
        ?Number(req.body.parent_id)
        :null;

    if(parent){

      const p=
        await pool.query(
`
SELECT id
FROM comments
WHERE
  id=$1
  AND article_id=$2
  AND status='approved'
`,
          [
            parent,
            articleId
          ]
        );

      if(!p.rows.length){

        return res.status(400).json({
          error:
            'Reply target not found'
        });

      }

    }

    const hash=
      ipHash(req);

    const duplicate=
      await pool.query(
`
SELECT id
FROM comments
WHERE
  article_id=$1
  AND ip_hash=$2
  AND LOWER(comment)=LOWER($3)
  AND created_at>
    NOW()-INTERVAL '10 minutes'
LIMIT 1
`,
        [
          articleId,
          hash,
          comment
        ]
      );

    if(duplicate.rows.length){

      return res.status(409).json({
        error:
          'This comment was already submitted'
      });

    }

    const result=
      await pool.query(
`
INSERT INTO comments(
  article_id,
  name,
  email,
  comment,
  status,
  ip_hash,
  parent_id
)
VALUES(
  $1,
  $2,
  $3,
  $4,
  'pending',
  $5,
  $6
)
RETURNING
  id,
  name,
  comment,
  status,
  created_at,
  parent_id
`,
        [
          articleId,
          name,
          email,
          comment,
          hash,
          parent
        ]
      );

    res.status(201).json({
      ok:true,
      message:
        'Comment submitted and waiting for approval.',
      comment:
        result.rows[0]
    });

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:
        'Could not submit comment'
    });

  }

});

/* =========================
   COMMENT LIKE
========================= */

app.post(
  '/api/comments/:id/like',
  async(req,res)=>{

  try{

    const id=
      Number(req.params.id);

    if(
      !Number.isInteger(id)||
      id<1
    ){

      return res.status(400).json({
        error:
          'Invalid comment id'
      });

    }

    const exists=
      await pool.query(
`
SELECT id
FROM comments
WHERE
  id=$1
  AND status='approved'
`,
        [id]
      );

    if(!exists.rows.length){

      return res.status(404).json({
        error:
          'Comment not found'
      });

    }

    await pool.query(
`
INSERT INTO comment_likes(
  comment_id,
  ip_hash
)
VALUES($1,$2)
ON CONFLICT(
  comment_id,
  ip_hash
)
DO NOTHING
`,
      [
        id,
        ipHash(req)
      ]
    );

    const count=
      await pool.query(
`
SELECT COUNT(*)::int likes
FROM comment_likes
WHERE comment_id=$1
`,
      [id]
    );

    res.json({
      ok:true,
      likes:
        count.rows[0].likes
    });

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:
        'Could not like comment'
    });

  }

});

/* =========================
   COMMENT REPORT
========================= */

app.post(
  '/api/comments/:id/report',
  async(req,res)=>{

  try{

    const id=
      Number(req.params.id);

    const reason=
      String(
        req.body.reason||'other'
      )
      .trim()
      .slice(0,40);

    const exists=
      await pool.query(
`
SELECT id
FROM comments
WHERE
  id=$1
  AND status='approved'
`,
        [id]
      );

    if(!exists.rows.length){

      return res.status(404).json({
        error:
          'Comment not found'
      });

    }

    const hash=
      ipHash(req);

    const previous=
      await pool.query(
`
SELECT id
FROM comment_reports
WHERE
  comment_id=$1
  AND ip_hash=$2
`,
        [
          id,
          hash
        ]
      );

    if(!previous.rows.length){

      await pool.query(
`
INSERT INTO comment_reports(
  comment_id,
  reason,
  ip_hash
)
VALUES($1,$2,$3)
`,
        [
          id,
          reason||'other',
          hash
        ]
      );

    }

    res.json({
      ok:true,
      message:
        'Thanks. Your report was sent to the admin.'
    });

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:
        'Could not report comment'
    });

  }

});

/* =========================
   ADMIN ARTICLES
========================= */

app.get(
  '/api/admin/articles',
  auth,
  async(req,res)=>{

  try{

    res.json(
      (
        await pool.query(`
          SELECT *
          FROM articles
          ORDER BY created_at DESC
        `)
      ).rows
    );

  }catch(e){

    res.status(500).json({
      error:'Failed'
    });

  }

});

/* =========================
   ADMIN STATS
========================= */

app.get(
  '/api/admin/stats',
  auth,
  async(req,res)=>{

  try{

    res.json(
      (
        await pool.query(`
          SELECT
            COUNT(*)::int total,

            COUNT(*) FILTER(
              WHERE status='published'
            )::int published,

            COUNT(*) FILTER(
              WHERE status='draft'
            )::int drafts,

            COALESCE(
              SUM(views),
              0
            )::int views,

            COUNT(
              DISTINCT category
            )::int categories

          FROM articles
        `)
      ).rows[0]
    );

  }catch(e){

    res.status(500).json({
      error:'Failed'
    });

  }

});

/* =========================
   ARTICLE VALIDATION
========================= */

function valid(b){

  const a={

    title:
      String(
        b.title||''
      ).trim(),

    content:
      String(
        b.content||''
      ).trim(),

    author:
      String(
        b.author||'Admin'
      ).trim()||'Admin',

    category:
      String(
        b.category||'Technology'
      ).trim()||'Technology',

    excerpt:
      String(
        b.excerpt||''
      ).trim(),

    tags:
      String(
        b.tags||''
      ).trim(),

    image_url:
      String(
        b.image_url||''
      ).trim(),

    status:
      b.status==='draft'
        ?'draft'
        :'published',

    featured:
      !!b.featured

  };

  if(
    !a.title||
    !a.content
  ){

    throw Error(
      'Title and content are required'
    );

  }

  return a;
}

/* =========================
   CREATE ARTICLE
========================= */

app.post(
  '/api/articles',
  auth,
  async(req,res)=>{

  try{

    const a=
      valid(req.body);

    const slug=
      slugify(a.title)+
      '-'+
      Date.now().toString(36);

    const result=
      await pool.query(
`
INSERT INTO articles(
  title,
  content,
  author,
  category,
  excerpt,
  tags,
  image_url,
  status,
  featured,
  slug,
  updated_at
)
VALUES(
  $1,$2,$3,$4,$5,
  $6,$7,$8,$9,$10,
  NOW()
)
RETURNING *
`,
        [
          a.title,
          a.content,
          a.author,
          a.category,
          a.excerpt,
          a.tags,
          a.image_url,
          a.status,
          a.featured,
          slug
        ]
      );

    res
      .status(201)
      .json(
        result.rows[0]
      );

  }catch(e){

    res.status(400).json({
      error:e.message
    });

  }

});

/* =========================
   UPDATE ARTICLE
========================= */

app.put(
  '/api/articles/:id',
  auth,
  async(req,res)=>{

  try{

    const a=
      valid(req.body);

    const id=
      Number(req.params.id);

    const result=
      await pool.query(
`
UPDATE articles
SET
  title=$1,
  content=$2,
  author=$3,
  category=$4,
  excerpt=$5,
  tags=$6,
  image_url=$7,
  status=$8,
  featured=$9,
  updated_at=NOW()
WHERE id=$10
RETURNING *
`,
        [
          a.title,
          a.content,
          a.author,
          a.category,
          a.excerpt,
          a.tags,
          a.image_url,
          a.status,
          a.featured,
          id
        ]
      );

    if(!result.rows.length){

      return res.status(404).json({
        error:'Not found'
      });

    }

    res.json(
      result.rows[0]
    );

  }catch(e){

    res.status(400).json({
      error:e.message
    });

  }

});

/* =========================
   DELETE ARTICLE
========================= */

app.delete(
  '/api/articles/:id',
  auth,
  async(req,res)=>{

  try{

    const result=
      await pool.query(
`
DELETE FROM articles
WHERE id=$1
RETURNING id
`,
        [
          Number(
            req.params.id
          )
        ]
      );

    if(!result.rows.length){

      return res.status(404).json({
        error:'Not found'
      });

    }

    res.json({
      ok:true
    });

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:
        'Delete failed'
    });

  }

});

/* =========================
   ADMIN COMMENTS
========================= */

app.get(
  '/api/admin/comments',
  auth,
  async(req,res)=>{

  try{

    const result=
      await pool.query(`
        SELECT
          c.*,
          a.title AS article_title,
          a.slug AS article_slug
        FROM comments c
        JOIN articles a
          ON a.id=c.article_id
        ORDER BY
          c.created_at DESC
      `);

    res.json({
      comments:
        result.rows,
      total:
        result.rows.length
    });

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:
        'Could not load comments'
    });

  }

});

/* =========================
   ADMIN COMMENT STATUS
========================= */

app.patch(
  '/api/admin/comments/:id',
  auth,
  async(req,res)=>{

  try{

    const status=
      String(
        req.body.status||''
      )
      .toLowerCase();

    if(
      ![
        'pending',
        'approved',
        'rejected'
      ].includes(status)
    ){

      return res.status(400).json({
        error:
          'Invalid status'
      });

    }

    const result=
      await pool.query(
`
UPDATE comments
SET status=$1
WHERE id=$2
RETURNING *
`,
      [
        status,
        Number(req.params.id)
      ]
    );

    if(!result.rows.length){

      return res.status(404).json({
        error:
          'Comment not found'
      });

    }

    res.json({
      ok:true,
      comment:
        result.rows[0]
    });

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:
        'Could not update comment'
    });

  }

});

/* =========================
   OLD ADMIN APPROVE SUPPORT
========================= */

app.put(
  '/api/admin/comments/:id/approve',
  auth,
  async(req,res)=>{

  try{

    const result=
      await pool.query(
`
UPDATE comments
SET status='approved'
WHERE id=$1
RETURNING *
`,
        [Number(req.params.id)]
      );

    if(!result.rows.length){

      return res.status(404).json({
        error:
          'Comment not found'
      });

    }

    res.json({
      ok:true,
      comment:
        result.rows[0]
    });

  }catch(e){

    res.status(500).json({
      error:
        'Could not approve comment'
    });

  }

});

/* =========================
   OLD ADMIN REJECT SUPPORT
========================= */

app.put(
  '/api/admin/comments/:id/reject',
  auth,
  async(req,res)=>{

  try{

    const result=
      await pool.query(
`
UPDATE comments
SET status='rejected'
WHERE id=$1
RETURNING *
`,
        [Number(req.params.id)]
      );

    if(!result.rows.length){

      return res.status(404).json({
        error:
          'Comment not found'
      });

    }

    res.json({
      ok:true,
      comment:
        result.rows[0]
    });

  }catch(e){

    res.status(500).json({
      error:
        'Could not reject comment'
    });

  }

});

/* =========================
   DELETE COMMENT
========================= */

app.delete(
  '/api/admin/comments/:id',
  auth,
  async(req,res)=>{

  try{

    await pool.query(
`
DELETE FROM comments
WHERE id=$1
`,
      [Number(req.params.id)]
    );

    res.json({
      ok:true
    });

  }catch(e){

    res.status(500).json({
      error:
        'Could not delete comment'
    });

  }

});

/* =========================
   COMMENT STATS
========================= */

app.get(
  '/api/admin/comments/stats',
  auth,
  async(req,res)=>{

  try{

    const r=
      await pool.query(`
        SELECT
          COUNT(*)::int total,

          COUNT(*) FILTER(
            WHERE status='pending'
          )::int pending,

          COUNT(*) FILTER(
            WHERE status='approved'
          )::int approved,

          COUNT(*) FILTER(
            WHERE status='rejected'
          )::int rejected

        FROM comments
      `);

    const reports=
      await pool.query(`
        SELECT
          COUNT(*)::int open
        FROM comment_reports
        WHERE status='open'
      `);

    res.json({
      ...r.rows[0],
      openReports:
        reports.rows[0].open
    });

  }catch(e){

    res.status(500).json({
      error:
        'Could not load comment stats'
    });

  }

});

/* =========================
   OLD COMMENT STATS
========================= */

app.get(
  '/api/admin/comment-stats',
  auth,
  async(req,res)=>{

  try{

    const r=
      await pool.query(`
        SELECT
          COUNT(*)::int total,
          COUNT(*) FILTER(
            WHERE status='pending'
          )::int pending,
          COUNT(*) FILTER(
            WHERE status='approved'
          )::int approved,
          COUNT(*) FILTER(
            WHERE status='rejected'
          )::int rejected
        FROM comments
      `);

    res.json(
      r.rows[0]
    );

  }catch(e){

    res.status(500).json({
      error:
        'Could not load comment stats'
    });

  }

});

/* =========================
   COMMENT ANALYTICS
========================= */

app.get(
  '/api/admin/comments/analytics',
  auth,
  async(req,res)=>{

  try{

    const [top,days]=
      await Promise.all([

        pool.query(`
          SELECT
            c.id,
            c.name,
            c.comment,
            a.title,
            COUNT(l.id)::int likes
          FROM comments c
          JOIN articles a
            ON a.id=c.article_id
          LEFT JOIN comment_likes l
            ON l.comment_id=c.id
          WHERE c.status='approved'
          GROUP BY
            c.id,
            a.title
          ORDER BY
            likes DESC,
            c.created_at DESC
          LIMIT 10
        `),

        pool.query(`
          SELECT
            TO_CHAR(
              d.day,
              'Mon DD'
            ) label,
            COUNT(c.id)::int comments
          FROM generate_series(
            CURRENT_DATE-6,
            CURRENT_DATE,
            INTERVAL '1 day'
          ) d(day)
          LEFT JOIN comments c
            ON c.created_at::date=d.day
          GROUP BY d.day
          ORDER BY d.day
        `)

      ]);

    res.json({
      top:
        top.rows,
      days:
        days.rows
    });

  }catch(e){

    res.status(500).json({
      error:
        'Could not load analytics'
    });

  }

});

/* =========================
   REPORTS
========================= */

app.get(
  '/api/admin/comment-reports',
  auth,
  async(req,res)=>{

  try{

    const r=
      await pool.query(`
        SELECT
          r.id,
          r.comment_id,
          r.reason,
          r.status,
          r.created_at,
          c.name,
          c.comment,
          a.title AS article_title
        FROM comment_reports r
        JOIN comments c
          ON c.id=r.comment_id
        JOIN articles a
          ON a.id=c.article_id
        ORDER BY
          CASE
            WHEN r.status='open'
            THEN 0
            ELSE 1
          END,
          r.created_at DESC
      `);

    res.json({
      reports:
        r.rows,
      total:
        r.rows.length
    });

  }catch(e){

    res.status(500).json({
      error:
        'Could not load reports'
    });

  }

});

app.patch(
  '/api/admin/comment-reports/:id',
  auth,
  async(req,res)=>{

  try{

    const status=
      req.body.status==='resolved'
        ?'resolved'
        :'open';

    const r=
      await pool.query(
`
UPDATE comment_reports
SET status=$1
WHERE id=$2
RETURNING *
`,
      [
        status,
        Number(req.params.id)
      ]
    );

    if(!r.rows.length){

      return res.status(404).json({
        error:
          'Report not found'
      });

    }

    res.json({
      ok:true,
      report:
        r.rows[0]
    });

  }catch(e){

    res.status(500).json({
      error:
        'Could not update report'
    });

  }

});

app.delete(
  '/api/admin/comment-reports/:id',
  auth,
  async(req,res)=>{

  try{

    await pool.query(
`
DELETE FROM comment_reports
WHERE id=$1
`,
      [Number(req.params.id)]
    );

    res.json({
      ok:true
    });

  }catch(e){

    res.status(500).json({
      error:
        'Could not delete report'
    });

  }

});

/* =========================
   START SERVER
========================= */

/*
  IMPORTANT:
  Render ko port immediately milna chahiye.
  Database initialization server start hone ke
  baad background mein hoti hai.
*/

const server=
  app.listen(
    PORT,
    ()=>{
      console.log(
        'GyanTech Blog running on port '+
        PORT
      );

      init()
        .then(()=>{
          console.log(
            'Database initialization completed.'
          );
        })
        .catch(e=>{
          console.error(
            'Database initialization failed:',
            e
          );
        });
    }
  );

server.on(
  'error',
  e=>{
    console.error(
      'Server error:',
      e
    );
  }
);
