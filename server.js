const express=require('express');
const cookieParser=require('cookie-parser');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const {Pool}=require('pg');
const fs=require('fs');
const path=require('path');

const app=express();

const PORT=process.env.PORT||10000;
const SITE_URL='https://gyantech-blog.onrender.com';


/* =========================
   DATABASE
========================= */

const pool=new Pool({
  connectionString:process.env.DATABASE_URL,
  ssl:process.env.NODE_ENV==='production'
    ?{rejectUnauthorized:false}
    :false
});


/* =========================
   MIDDLEWARE
========================= */

app.use(express.json({limit:'1mb'}));
app.use(cookieParser());

app.use(
  express.static(__dirname,{
    extensions:['html']
  })
);


/* =========================
   HELPERS
========================= */

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

  return String(value??'')
    .replace(/[&<>"']/g,m=>({
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

  const text=
    plainText(
      article.excerpt||
      article.content||
      ''
    );

  return text.slice(0,155)+
    (text.length>155?'...':'');

}


/* =========================
   SEO
========================= */

function seoArticleHTML(html,article){

  const title=escapeHTML(
    (article.title||'Article')+
    ' — GyanTech'
  );

  const description=escapeHTML(
    seoDescription(article)||
    'Read this article on GyanTech Blog.'
  );

  const url=
    SITE_URL+
    '/article/'+
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
      seoDescription(article)||
      'Read this article on GyanTech Blog.',
    url:url,
    datePublished:article.created_at,
    dateModified:
      article.updated_at||
      article.created_at,
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
    jsonLD.image=[
      String(article.image_url)
    ];
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


/* =========================
   COMMENT SECURITY
========================= */

const commentRateLimit=new Map();

const COMMENT_WINDOW_MS=
  10*60*1000;

const COMMENT_MAX_REQUESTS=3;


function getClientIP(req){

  return(
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
      time=>
        now-time<
        COMMENT_WINDOW_MS
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

      const active=
        times.some(
          time=>
            now-time<
            COMMENT_WINDOW_MS
        );

      if(!active){
        commentRateLimit.delete(
          savedIP
        );
      }

    }

  }

  return(
    recent.length>
    COMMENT_MAX_REQUESTS
  );

}


function looksLikeCommentSpam(text){

  const value=
    String(text||'').trim();

  const links=
    value.match(
      /https?:\/\//gi
    )||[];

  const wwwLinks=
    value.match(
      /www\./gi
    )||[];

  if(
    links.length>2||
    wwwLinks.length>2
  ){
    return true;
  }

  if(
    /(.)\1{12,}/.test(value)
  ){
    return true;
  }

  if(value.length>3000){
    return true;
  }

  return false;

}


function normalizeComment(text){

  return String(text||'')
    .trim()
    .replace(/\s+/g,' ');

}


/* =========================
   DATABASE INIT
========================= */

async function init(){

  await pool.query(`
    CREATE TABLE IF NOT EXISTS articles(
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL
        DEFAULT 'Admin',
      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    )
  `);


  /* Article columns */

  for(const q of [

    `ALTER TABLE articles
     ADD COLUMN IF NOT EXISTS slug TEXT`,

    `ALTER TABLE articles
     ADD COLUMN IF NOT EXISTS excerpt TEXT
     DEFAULT ''`,

    `ALTER TABLE articles
     ADD COLUMN IF NOT EXISTS category TEXT
     DEFAULT 'Technology'`,

    `ALTER TABLE articles
     ADD COLUMN IF NOT EXISTS tags TEXT
     DEFAULT ''`,

    `ALTER TABLE articles
     ADD COLUMN IF NOT EXISTS image_url TEXT
     DEFAULT ''`,

    `ALTER TABLE articles
     ADD COLUMN IF NOT EXISTS status TEXT
     DEFAULT 'published'`,

    `ALTER TABLE articles
     ADD COLUMN IF NOT EXISTS featured BOOLEAN
     DEFAULT FALSE`,

    `ALTER TABLE articles
     ADD COLUMN IF NOT EXISTS views INTEGER
     DEFAULT 0`,

    `ALTER TABLE articles
     ADD COLUMN IF NOT EXISTS updated_at
     TIMESTAMPTZ DEFAULT NOW()`

  ]){

    await pool.query(q);

  }


  /* Create missing slugs */

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
    WHERE slug IS NULL
    OR slug=''
  `);


  await pool.query(`
    UPDATE articles
    SET status='published'
    WHERE status IS NULL
  `);


  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    articles_slug_unique
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

      status TEXT NOT NULL
        DEFAULT 'pending',

      ip_hash TEXT DEFAULT '',

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        DEFAULT NOW()

    )
  `);


  for(const q of [

    `ALTER TABLE comments
     ADD COLUMN IF NOT EXISTS email TEXT
     DEFAULT ''`,

    `ALTER TABLE comments
     ADD COLUMN IF NOT EXISTS status TEXT
     DEFAULT 'pending'`,

    `ALTER TABLE comments
     ADD COLUMN IF NOT EXISTS ip_hash TEXT
     DEFAULT ''`,

    `ALTER TABLE comments
     ADD COLUMN IF NOT EXISTS updated_at
     TIMESTAMPTZ DEFAULT NOW()`

  ]){

    await pool.query(q);

  }


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    comments_article_id_idx
    ON comments(article_id)
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    comments_status_idx
    ON comments(status)
  `);

}


/* =========================
   ADMIN AUTH
========================= */

function auth(req,res,next){

  try{

    const d=
      jwt.verify(
        req.cookies.admin_token,
        process.env.JWT_SECRET
      );

    if(d.role!=='admin'){
      throw new Error();
    }

    next();

  }catch{

    res.status(401).json({
      error:'Unauthorized'
    });

  }

}


/* =========================
   MAIN PAGES
========================= */

app.get('/',(req,res)=>{

  res.sendFile(
    'index.html',
    {root:__dirname}
  );

});


app.get('/articles',(req,res)=>{

  res.sendFile(
    'articles.html',
    {root:__dirname}
  );

});


app.get('/admin',(req,res)=>{

  res.sendFile(
    'admin.html',
    {root:__dirname}
  );

});


/* =========================
   ARTICLE PAGE
========================= */

app.get('/article/:slug',async(req,res)=>{

  try{

    const result=
      await pool.query(`
        SELECT *
        FROM articles
        WHERE slug=$1
        AND status='published'
        LIMIT 1
      `,[req.params.slug]);


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


    res.send(
      seoArticleHTML(
        html,
        article
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

app.get('/sitemap.xml',async(req,res)=>{

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


    for(const article of result.rows){

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


    res
      .type('application/xml')
      .send(sitemap);

  }catch(e){

    console.error(e);

    res
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
      String(
        req.body.password||''
      );


    const validPassword=
      await bcrypt.compare(
        password,
        process.env.ADMIN_PASSWORD_HASH||''
      );


    if(!validPassword){

      return res
        .status(401)
        .json({
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


/* =========================
   LOGOUT
========================= */

app.post('/api/logout',(req,res)=>{

  res.clearCookie(
    'admin_token'
  );

  res.json({
    ok:true
  });

});


/* =========================
   ADMIN CHECK
========================= */

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
   PUBLIC ARTICLES
========================= */

app.get('/api/articles',async(req,res)=>{

  try{

    const{
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

        return res
          .status(404)
          .json({
            error:'Article not found'
          });

      }


      res.json(
        x.rows[0]
      );

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Could not load article'
      });

    }

  }
);


/* =========================
   CATEGORIES
========================= */

app.get('/api/categories',async(req,res)=>{

  try{

    const result=
      await pool.query(`
        SELECT
          category,
          COUNT(*)::int count
        FROM articles
        WHERE status='published'
        GROUP BY category
        ORDER BY count DESC,category
      `);


    res.json(
      result.rows
    );

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:'Failed'
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

      const result=
        await pool.query(`
          SELECT *
          FROM articles
          ORDER BY created_at DESC
        `);


      res.json(
        result.rows
      );

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Failed'
      });

    }

  }
);


/*
