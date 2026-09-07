const express=require('express'),
cookieParser=require('cookie-parser'),
bcrypt=require('bcryptjs'),
jwt=require('jsonwebtoken'),
{Pool}=require('pg'),
fs=require('fs'),
path=require('path');

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
     NEWSLETTER TABLE
  ========================= */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS newsletter_subscribers(
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

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
   MAIN PAGES
========================= */

app.get('/',(q,r)=>
  r.sendFile('index.html',{root:__dirname})
);

app.get('/articles',(q,r)=>
  r.sendFile('articles.html',{root:__dirname})
);

app.get('/admin',(q,r)=>
  r.sendFile('admin.html',{root:__dirname})
);


/* =========================
   ARTICLE PAGE + SEO
========================= */

app.get('/article/:slug',async(req,res)=>{

  try{

    const result=await pool.query(
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
        .sendFile('article.html',{root:__dirname});

    }

    const article=result.rows[0];

    const articlePath=
      path.join(__dirname,'article.html');

    const html=
      fs.readFileSync(articlePath,'utf8');

    const finalHTML=
      seoArticleHTML(html,article);

    res.send(finalHTML);

  }catch(e){

    console.error(e);

    res
      .status(500)
      .sendFile('article.html',{root:__dirname});

  }

});


/* =========================
   SITEMAP
========================= */

app.get('/sitemap.xml',async(q,r)=>{

  try{

    const result=await pool.query(`
      SELECT slug,created_at,updated_at
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
        `${SITE_URL}/article/${encodeURIComponent(article.slug)}`
      );

    }

    const articleURLs=result.rows.map(article=>{

      const url=
        `${SITE_URL}/article/`+
        encodeURIComponent(article.slug);

      const date=
        article.updated_at||
        article.created_at;

      return `
  <url>
    <loc>${escapeHTML(url)}</loc>
    <lastmod>${new Date(date).toISOString()}</lastmod>
  </url>`;

    }).join('\n');

    const sitemap=`<?xml version="1.0" encoding="UTF-8"?>
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
        secure:process.env.NODE_ENV==='production',
        maxAge:604800000
      }
    );

    res.json({ok:true});

  }catch{

    res.status(500).json({
      error:'Login failed'
    });

  }

});


app.post('/api/logout',(q,r)=>{

  r.clearCookie('admin_token');

  r.json({ok:true});

});


app.get('/api/admin/check',(q,r)=>{

  try{

    const d=
      jwt.verify(
        q.cookies.admin_token,
        process.env.JWT_SECRET
      );

    r.json({
      authenticated:d.role==='admin'
    });

  }catch{

    r.json({
      authenticated:false
    });

  }

});


/* =========================
   NEWSLETTER
========================= */

app.post('/api/newsletter/subscribe',async(req,res)=>{

  try{

    const email=
      String(req.body.email||'')
        .trim()
        .toLowerCase();

    if(
      !email ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ){

      return res.status(400).json({
        error:'Please enter a valid email address.'
      });

    }

    const result=
      await pool.query(
        `
        INSERT INTO newsletter_subscribers(email)
        VALUES($1)
        ON CONFLICT(email) DO NOTHING
        RETURNING id
        `,
        [email]
      );

    if(!result.rows.length){

      return res.json({
        message:'This email is already subscribed.'
      });

    }

    res.json({
      message:
        "You're subscribed! Thanks for joining GyanTech Blog."
    });

  }catch(e){

    console.error(e);

    res.status(500).json({
      error:'Could not subscribe right now.'
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
      Math.max(1,+page||1);

    const lim=
      Math.min(
        30,
        Math.max(1,+limit||9)
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
      total:count.rows[0].total,
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

app.get('/api/articles/:slug',async(req,res)=>{

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

    res.json(x.rows[0]);

  }catch{

    res.status(500).json({
      error:'Could not load article'
    });

  }

});


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
   ADMIN ARTICLES
========================= */

app.get('/api/admin/articles',auth,async(q,r)=>{

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

});


/* =========================
   ADMIN STATS
========================= */

app.get('/api/admin/stats',auth,async(q,r)=>{

  try{

    r.json(
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

  }catch{

    r.status(500).json({
      error:'Failed'
    });

  }

});


/* =========================
   VALIDATION
========================= */

function valid(b){

  const a={

    title:
      String(b.title||'').trim(),

    content:
      String(b.content||'').trim(),

    author:
      String(
        b.author||'Admin'
      ).trim()||'Admin',

    category:
      String(
        b.category||'Technology'
      ).trim()||'Technology',

    excerpt:
      String(b.excerpt||'').trim(),

    tags:
      String(b.tags||'').trim(),

    image_url:
      String(b.image_url||'').trim(),

    status:
      b.status==='draft'
        ?'draft'
        :'published',

    featured:
      !!b.featured

  };

  if(!a.title||!a.content){

    throw Error(
      'Title and content are required'
    );

  }

  return a;
}


/* =========================
   CREATE ARTICLE
========================= */

app.post('/api/articles',auth,async(req,res)=>{

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
      .json(x.rows[0]);

  }catch(e){

    res.status(400).json({
      error:e.message
    });

  }

});


/* =========================
   UPDATE ARTICLE
========================= */

app.put('/api/articles/:id',auth,async(req,res)=>{

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

});


/* =========================
   DELETE ARTICLE
========================= */

app.delete('/api/articles/:id',auth,async(req,res)=>{

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

});


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
