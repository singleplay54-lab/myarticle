const express=require('express'),cookieParser=require('cookie-parser'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),{Pool}=require('pg'),fs=require('fs'),path=require('path'),crypto=require('crypto');

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

const slugify=s=>
  String(s||'')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu,'')
    .replace(/\s+/g,'-')
    .replace(/-+/g,'-')
    .replace(/^-|-$/g,'')
    .slice(0,80)||'article';

function escapeHTML(value){
  return String(value??'').replace(/[&<>"']/g,m=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#039;'
  }[m]));
}

function plainText(value){
  return String(value||'')
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function seoDescription(article){
  const text=plainText(article.excerpt||article.content||'');
  return text.slice(0,155)+(text.length>155?'...':'');
}

function seoArticleHTML(html,article){

  const title=escapeHTML(
    (article.title||'Article')+' — GyanTech'
  );

  const description=escapeHTML(
    seoDescription(article) ||
    'Read this article on GyanTech Blog.'
  );

  const url=
    SITE_URL+'/article/'+
    encodeURIComponent(article.slug);

  const image=article.image_url
    ?escapeHTML(article.image_url)
    :'';

  const imageTags=image
    ?`
<meta property="og:image" content="${image}">
<meta name="twitter:image" content="${image}">
`
    :'';

  const jsonLD={
    '@context':'https://schema.org',
    '@type':'Article',
    headline:String(article.title||'Article'),
    description:
      seoDescription(article) ||
      'Read this article on GyanTech Blog.',
    url:url,
    datePublished:article.created_at,
    dateModified:article.updated_at||article.created_at,
    author:{
      '@type':'Person',
      name:String(article.author||'Admin')
    },
    publisher:{
      '@type':'Organization',
      name:'GyanTech Blog',
      url:SITE_URL
    }
  };

  if(article.image_url){
    jsonLD.image=[String(article.image_url)];
  }

  const seo=`
<title>${title}</title>

<meta name="description" content="${description}">

<link rel="canonical" href="${escapeHTML(url)}">

<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${escapeHTML(url)}">
${imageTags}

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">

<script type="application/ld+json">${JSON.stringify(jsonLD).replace(/</g,'\\u003c')}</script>
`;

  return html.replace(
    /<\/head>/i,
    seo+'</head>'
  );
}

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

  /* =========================
     COMMENTS TABLE
  ========================= */

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
    await pool.query(q);
  }

  await pool.query(`
    CREATE INDEX IF NOT EXISTS comments_article_idx
    ON comments(article_id,created_at DESC)
  `);

  /* =========================
     COMMENT LIKES
  ========================= */

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

  /* =========================
     COMMENT REPORTS
  ========================= */

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
   COMMENT SECURITY
========================= */

const commentRateLimit=new Map();

const COMMENT_WINDOW_MS=
  10*60*1000;

const COMMENT_MAX_REQUESTS=3;

function getClientIP(req){

  return (
    req.ip||
    req.headers['x-forwarded-for']
      ?.split(',')[0]
      ?.trim()||
    req.socket?.remoteAddress||
    'unknown'
  );

}

function isCommentRateLimited(req){

  const ip=getClientIP(req);
  const now=Date.now();

  const previous=
    commentRateLimit.get(ip)||[];

  const recent=
    previous.filter(
      t=>now-t<COMMENT_WINDOW_MS
    );

  recent.push(now);

  commentRateLimit.set(
    ip,
    recent
  );

  if(commentRateLimit.size>5000){

    for(
      const [savedIP,times]
      of commentRateLimit
    ){

      if(
        !times.some(
          t=>now-t<COMMENT_WINDOW_MS
        )
      ){
        commentRateLimit.delete(savedIP);
      }

    }

  }

  return recent.length>
    COMMENT_MAX_REQUESTS;

}

function normalizeComment(text){

  return String(text||'')
    .trim()
    .replace(/\s+/g,' ');

}

function looksLikeCommentSpam(text){

  const value=
    String(text||'').trim();

  if(value.length>3000)
    return true;

  const links=
    value.match(/https?:\/\//gi)||[];

  if(links.length>2)
    return true;

  const www=
    value.match(/www\./gi)||[];

  if(www.length>2)
    return true;

  if(/(.)\1{12,}/.test(value))
    return true;

  return false;

}

function hashIP(ip){

  return crypto
    .createHash('sha256')
    .update(
      String(ip)+
      '|'+
      String(
        process.env.JWT_SECRET||
        'gyantech'
      )
    )
    .digest('hex');

}


/* =========================
   MAIN PAGES
========================= */

app.get('/',(q,r)=>
  r.sendFile(
    'index.html',
    {root:__dirname}
  )
);

app.get('/articles',(q,r)=>
  r.sendFile(
    'articles.html',
    {root:__dirname}
  )
);

app.get('/admin',(q,r)=>
  r.sendFile(
    'admin.html',
    {root:__dirname}
  )
);


/* =========================
   ARTICLE PAGE + SEO
========================= */

app.get('/article/:slug',async(req,res)=>{

  try{

    const result=
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

    if(!result.rows.length){

      return res
        .status(404)
        .sendFile(
          'article.html',
          {root:__dirname}
        );

    }

    const article=
      result.rows[0];

    const articlePath=
      path.join(
        __dirname,
        'article.html'
      );

    const html=
      fs.readFileSync(
        articlePath,
        'utf8'
      );

    const finalHTML=
      seoArticleHTML(
        html,
        article
      );

    res.send(finalHTML);

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

app.get('/sitemap.xml',async(q,r)=>{

  try{

    const result=
      await pool.query(`
        SELECT
          slug,
          created_at,
          updated_at
        FROM articles
        WHERE status='published'
        ORDER BY created_at DESC
      `);

    const urls=[
      `${SITE_URL}/`,
      `${SITE_URL}/articles`
    ];

    for(
      const article
      of result.rows
    ){

      urls.push(
        `${SITE_URL}/article/`+
        encodeURIComponent(
          article.slug
        )
      );

    }

    const articleURLs=
      result.rows.map(article=>{

        const url=
          `${SITE_URL}/article/`+
          encodeURIComponent(
            article.slug
          );

        const date=
          article.updated_at||
          article.created_at;

        return `
  <url>
    <loc>${escapeHTML(url)}</loc>
    <lastmod>${new Date(date).toISOString()}</lastmod>
  </url>`;

      }).join('\n');

    const sitemap=
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">

  <url>
    <loc>${escapeHTML(urls[0])}</loc>
  </url>

  <url>
    <loc>${escapeHTML(urls[1])}</loc>
  </url>

${articleURLs}

</urlset>`;

    r
      .type('application/xml')
      .send(sitemap);

  }catch(e){

    console.error(e);

    r
      .status(500)
      .type('text/plain')
      .send('Sitemap unavailable');

  }

});


/* =========================
   LOGIN
========================= */

app.post('/api/login',async(req,res)=>{

  try{

    const password=
      String(req.body.password||'');

    const validPassword=
      await bcrypt.compare(
        password,
        process.env.ADMIN_PASSWORD_HASH||''
      );

    if(!validPassword){

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
          process.env.NODE_ENV==='production',
        maxAge:604800000
      }
    );

    res.json({
      ok:true
    });

  }catch{

    res.status(500).json({
      error:'Login failed'
    });

  }

});


/* =========================
   LOGOUT
========================= */

app.post('/api/logout',(q,r)=>{

  r.clearCookie(
    'admin_token'
  );

  r.json({
    ok:true
  });

});


/* =========================
   ADMIN CHECK
========================= */

app.get('/api/admin/check',(q,r)=>{

  try{

    const d=
      jwt.verify(
        q.cookies.admin_token,
        process.env.JWT_SECRET
      );

    r.json({
      authenticated:
        d.role==='admin'
    });

  }catch{

    r.json({
      authenticated:false
    });

  }

});


/* =========================
   PUBLIC ARTICLES
========================= */

app.get('/api/articles',async(req,res)=>{

  try{

    const {
      q='',
      category='',
      page='1',
      limit='9'
    }=req.query;

    const p=
      Math.max(
        1,
        +page||1
      );

    const lim=
      Math.min(
        30,
        Math.max(
          1,
          +limit||9
        )
      );

    const params=[];

    const w=[
      `status='published'`
    ];

    if(q.trim()){

      params.push(
        '%'+q.trim()+'%'
      );

      w.push(`
        (
          title ILIKE $${params.length}
          OR content ILIKE $${params.length}
          OR tags ILIKE $${params.length}
          OR category ILIKE $${params.length}
        )
      `);

    }

    if(category.trim()){

      params.push(
        category.trim()
      );

      w.push(
        `category=$${params.length}`
      );

    }

    const where=
      w.join(' AND ');

    const count=
      await pool.query(
        `
        SELECT COUNT(*)::int total
        FROM articles
        WHERE ${where}
        `,
        params
      );

    params.push(
      lim,
      (p-1)*lim
    );

    const data=
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
        WHERE ${where}
        ORDER BY
          featured DESC,
          created_at DESC
        LIMIT $${params.length-1}
        OFFSET $${params.length}
        `,
        params
      );

    res.json({
      articles:data.rows,
      total:
        count.rows[0].total,
      page:p,
      limit:lim
    });

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:'Could not load articles'
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

      const x=
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

      if(!x.rows.length){

        return res.status(404).json({
          error:'Article not found'
        });

      }

      const article=
        x.rows[0];

      const commentCount=
        await pool.query(
          `
          SELECT COUNT(*)::int AS count
          FROM comments
          WHERE article_id=$1
          AND status='approved'
          `,
          [article.id]
        );

      article.comment_count=
        commentCount.rows[0].count;

      res.json(article);

    }catch{

      res.status(500).json({
        error:'Could not load article'
      });

    }

  }
);


/* =========================
   CATEGORIES
========================= */

app.get('/api/categories',async(q,r)=>{

  try{

    r.json(
      (
        await pool.query(`
          SELECT
            category,
            COUNT(*)::int count
          FROM articles
          WHERE status='published'
          GROUP BY category
          ORDER BY count DESC,category
        `)
      ).rows
    );

  }catch{

    r.status(500).json({
      error:'Failed'
    });

  }

});


/* =========================
   PUBLIC COMMENTS
========================= */

app.get(
  '/api/articles/:slug/comments',
  async(req,res)=>{
    try{

      const article=
        await pool.query(`
          SELECT id
          FROM articles
          WHERE slug=$1
          AND status='published'
          LIMIT 1
        `,[req.params.slug]);

      if(!article.rows.length){

        return res.status(404).json({
          error:'Article not found'
        });

      }

      const comments=
        await pool.query(`
          SELECT
            c.id,
            c.name,
            c.comment,
            c.created_at,
            c.parent_id,
            COALESCE(
              l.likes,
              0
            )::int AS likes
          FROM comments c
          LEFT JOIN (
            SELECT
              comment_id,
              COUNT(*)::int AS likes
            FROM comment_likes
            GROUP BY comment_id
          ) l
          ON l.comment_id=c.id
          WHERE c.article_id=$1
          AND c.status='approved'
          ORDER BY c.created_at ASC
        `,[article.rows[0].id]);

      res.json({
        comments:comments.rows,
        total:comments.rows.length
      });

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Could not load comments'
      });

    }
  }
);


/* =========================
   SUBMIT COMMENT / REPLY
========================= */

app.post(
  '/api/articles/:slug/comments',
  async(req,res)=>{
    try{

      if(isCommentRateLimited(req)){

        return res.status(429).json({
          error:
            'Too many comments. Please try again later.'
        });

      }

      /* Honeypot */

      const website=
        String(
          req.body.website||''
        ).trim();

      if(website){

        return res.status(400).json({
          error:'Spam detected'
        });

      }

      const name=
        normalizeComment(
          req.body.name
        );

      const email=
        normalizeComment(
          req.body.email
        ).toLowerCase();

      const comment=
        normalizeComment(
          req.body.comment
        );

      if(
        name.length<2||
        name.length>80
      ){

        return res.status(400).json({
          error:'Please enter a valid name'
        });

      }

      if(
        email &&
        (
          email.length>160||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/
            .test(email)
        )
      ){

        return res.status(400).json({
          error:'Please enter a valid email'
        });

      }

      if(
        comment.length<2||
        comment.length>3000
      ){

        return res.status(400).json({
          error:
            'Comment must be between 2 and 3000 characters'
        });

      }

      if(
        looksLikeCommentSpam(
          comment
        )
      ){

        return res.status(400).json({
          error:'Comment looks like spam'
        });

      }

      const article=
        await pool.query(`
          SELECT id
          FROM articles
          WHERE slug=$1
          AND status='published'
          LIMIT 1
        `,[req.params.slug]);

      if(!article.rows.length){

        return res.status(404).json({
          error:'Article not found'
        });

      }

      const articleId=
        article.rows[0].id;

      const ipHash=
        hashIP(
          getClientIP(req)
        );

      const parentId=
        req.body.parent_id
          ?Number(req.body.parent_id)
          :null;

      /* Reply validation */

      if(parentId!==null){

        if(
          !Number.isInteger(parentId)||
          parentId<1
        ){

          return res.status(400).json({
            error:'Invalid reply target'
          });

        }

        const parent=
          await pool.query(`
            SELECT id
            FROM comments
            WHERE id=$1
            AND article_id=$2
            AND status='approved'
            LIMIT 1
          `,[
            parentId,
            articleId
          ]);

        if(!parent.rows.length){

          return res.status(400).json({
            error:'Reply target not found'
          });

        }

      }

      /* Duplicate protection */

      const duplicate=
        await pool.query(`
          SELECT id
          FROM comments
          WHERE article_id=$1
          AND ip_hash=$2
          AND LOWER(comment)=LOWER($3)
          AND created_at>
            NOW()-INTERVAL '10 minutes'
          LIMIT 1
        `,[
          articleId,
          ipHash,
          comment
        ]);

      if(duplicate.rows.length){

        return res.status(409).json({
          error:
            'This comment was already submitted'
        });

      }

      const result=
        await pool.query(`
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
            $1,$2,$3,$4,
            'pending',
            $5,$6
          )
          RETURNING
            id,
            name,
            comment,
            status,
            created_at,
            parent_id
        `,[
          articleId,
          name,
          email,
          comment,
          ipHash,
          parentId
        ]);

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
        error:'Could not submit comment'
      });

    }
  }
);


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
          error:'Invalid comment id'
        });

      }

      const ipHash=
        hashIP(
          getClientIP(req)
        );

      const exists=
        await pool.query(`
          SELECT id
          FROM comments
          WHERE id=$1
          AND status='approved'
          LIMIT 1
        `,[id]);

      if(!exists.rows.length){

        return res.status(404).json({
          error:'Comment not found'
        });

      }

      await pool.query(`
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
      `,[
        id,
        ipHash
      ]);

      const count=
        await pool.query(`
          SELECT COUNT(*)::int AS likes
          FROM comment_likes
          WHERE comment_id=$1
        `,[id]);

      res.json({
        ok:true,
        likes:
          count.rows[0].likes
      });

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Could not like comment'
      });

    }
  }
);


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
        .slice(0,40)||
        'other';

      if(
        !Number.isInteger(id)||
        id<1
      ){

        return res.status(400).json({
          error:'Invalid comment id'
        });

      }

      const exists=
        await pool.query(`
          SELECT id
          FROM comments
          WHERE id=$1
          AND status='approved'
          LIMIT 1
        `,[id]);

      if(!exists.rows.length){

        return res.status(404).json({
          error:'Comment not found'
        });

      }

      const ipHash=
        hashIP(
          getClientIP(req)
        );

      const prior=
        await pool.query(`
          SELECT id
          FROM comment_reports
          WHERE comment_id=$1
          AND ip_hash=$2
          LIMIT 1
        `,[
          id,
          ipHash
        ]);

      if(!prior.rows.length){

        await pool.query(`
          INSERT INTO comment_reports(
            comment_id,
            reason,
            ip_hash
          )
          VALUES($1,$2,$3)
        `,[
          id,
          reason,
          ipHash
        ]);

      }

      res.json({
        ok:true,
        message:
          'Thanks. Your report was sent to the admin.'
      });

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Could not report comment'
      });

    }
  }
);


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
            c.id,
            c.name,
            c.email,
            c.comment,
            c.status,
            c.created_at,
            c.article_id,
            a.title AS article_title,
            a.slug AS article_slug
          FROM comments c
          JOIN articles a
          ON a.id=c.article_id
          ORDER BY c.created_at DESC
        `);

      res.json({
        comments:result.rows,
        total:result.rows.length
      });

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Could not load comments'
      });

    }
  }
);


/* =========================
   ADMIN COMMENT STATUS
========================= */

app.patch(
  '/api/admin/comments/:id',
  auth,
  async(req,res)=>{
    try{

      const id=
        Number(req.params.id);

      const status=
        String(
          req.body.status||''
        )
        .trim()
        .toLowerCase();

      if(
        !Number.isInteger(id)||
        id<1
      ){

        return res.status(400).json({
          error:'Invalid comment id'
        });

      }

      if(
        ![
          'pending',
          'approved',
          'rejected'
        ].includes(status)
      ){

        return res.status(400).json({
          error:'Invalid status'
        });

      }

      const result=
        await pool.query(`
          UPDATE comments
          SET status=$1
          WHERE id=$2
          RETURNING *
        `,[
          status,
          id
        ]);

      if(!result.rows.length){

        return res.status(404).json({
          error:'Comment not found'
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
        error:'Could not update comment'
      });

    }
  }
);


/* =========================
   ADMIN COMMENT STATS
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
            COUNT(*)
              FILTER(
                WHERE status='pending'
              )::int pending,
            COUNT(*)
              FILTER(
                WHERE status='approved'
              )::int approved,
            COUNT(*)
              FILTER(
                WHERE status='rejected'
              )::int rejected
          FROM comments
        `);

      const reports=
        await pool.query(`
          SELECT COUNT(*)::int open
          FROM comment_reports
          WHERE status='open'
        `);

      res.json({
        ...r.rows[0],
        openReports:
          reports.rows[0].open
      });

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Could not load comment stats'
      });

    }
  }
);


/* =========================
   COMMENT ANALYTICS
========================= */

app.get(
  '/api/admin/comments/analytics',
  auth,
  async(req,res)=>{
    try{

      const [
        top,
        days
      ]=await Promise.all([

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
        top:top.rows,
        days:days.rows
      });

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Could not load analytics'
      });

    }
  }
);


/* =========================
   ADMIN COMMENT REPORTS
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
        reports:r.rows,
        total:r.rows.length
      });

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Could not load reports'
      });

    }
  }
);


/* =========================
   UPDATE REPORT
========================= */

app.patch(
  '/api/admin/comment-reports/:id',
  auth,
  async(req,res)=>{
    try{

      const id=
        Number(req.params.id);

      const status=
        req.body.status==='resolved'
          ?'resolved'
          :'open';

      const r=
        await pool.query(`
          UPDATE comment_reports
          SET status=$1
          WHERE id=$2
          RETURNING *
        `,[
          status,
          id
        ]);

      if(!r.rows.length){

        return res.status(404).json({
          error:'Report not found'
        });

      }

      res.json({
        ok:true,
        report:r.rows[0]
      });

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Could not update report'
      });

    }
  }
);


/* =========================
   DELETE REPORT
========================= */

app.delete(
  '/api/admin/comment-reports/:id',
  auth,
  async(req,res)=>{
    try{

      const id=
        Number(req.params.id);

      await pool.query(
        `
        DELETE FROM comment_reports
        WHERE id=$1
        `,
        [id]
      );

      res.json({
        ok:true
      });

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Could not delete report'
      });

    }
  }
);


/* =========================
   DELETE COMMENT
========================= */

app.delete(
  '/api/admin/comments/:id',
  auth,
  async(req,res)=>{
    try{

      const id=
        Number(req.params.id);

      if(
        !Number.isInteger(id)||
        id<1
      ){

        return res.status(400).json({
          error:'Invalid comment id'
        });

      }

      const result=
        await pool.query(`
          DELETE FROM comments
          WHERE id=$1
          RETURNING id
        `,[id]);

      if(!result.rows.length){

        return res.status(404).json({
          error:'Comment not found'
        });

      }

      res.json({
        ok:true
      });

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Could not delete comment'
      });

    }
  }
);


/* =========================
   ADMIN COMMENT-STATS
========================= */

app.get(
  '/api/admin/comment-stats',
  auth,
  async(req,res)=>{
    try{

      const result=
        await pool.query(`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*)
              FILTER(
                WHERE status='pending'
              )::int AS pending,
            COUNT(*)
              FILTER(
                WHERE status='approved'
              )::int AS approved,
            COUNT(*)
              FILTER(
                WHERE status='rejected'
              )::int AS rejected
          FROM comments
        `);

      res.json(
        result.rows[0]
      );

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Could not load comment stats'
      });

    }
  }
);


/* =========================
   ADMIN ARTICLES
========================= */

app.get(
  '/api/admin/articles',
  auth,
  async(q,r)=>{

    try{

      r.json(
        (
          await pool.query(`
            SELECT *
            FROM articles
            ORDER BY created_at DESC
          `)
        ).rows
      );

    }catch{

      r.status(500).json({
        error:'Failed'
      });

    }

  }
);


/* =========================
   ADMIN STATS
========================= */

app.get(
  '/api/admin/stats',
  auth,
  async(q,r)=>{

    try{

      r.json(
        (
          await pool.query(`
            SELECT
              COUNT(*)::int total,

              COUNT(*)
                FILTER(
                  WHERE status='published'
                )::int published,

              COUNT(*)
                FILTER(
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

    }catch{

      r.status(500).json({
        error:'Failed'
      });

    }

  }
);


/* =========================
   VALIDATION
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
      ).trim()||
      'Admin',

    category:
      String(
        b.category||'Technology'
      ).trim()||
      'Technology',

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

      const base=
        slugify(a.title);

      const slug=
        base+'-'+
        Date.now().toString(36);

      const x=
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
          x.rows[0]
        );

    }catch(e){

      res.status(400).json({
        error:e.message
      });

    }

  }
);


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
        +req.params.id;

      const x=
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

      if(!x.rows.length){

        return res.status(404).json({
          error:'Not found'
        });

      }

      res.json(
        x.rows[0]
      );

    }catch(e){

      res.status(400).json({
        error:e.message
      });

    }

  }
);


/* =========================
   DELETE ARTICLE
========================= */

app.delete(
  '/api/articles/:id',
  auth,
  async(req,res)=>{
    try{

      const x=
        await pool.query(
          `
          DELETE FROM articles
          WHERE id=$1
          RETURNING id
          `,
          [+req.params.id]
        );

      if(!x.rows.length){

        return res.status(404).json({
          error:'Not found'
        });

      }

      res.json({
        ok:true
      });

    }catch{

      res.status(500).json({
        error:'Delete failed'
      });

    }

  }
);


/* =========================
   START SERVER
========================= */

init()
  .then(()=>{
    app.listen(
      PORT,
      ()=>{
        console.log(
          'GyanTech Advanced running on '+PORT
        );
      }
    );
  })
  .catch(e=>{
    console.error(e);
    process.exit(1);
  });
