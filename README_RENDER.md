# GyanTech Blog - Render + PostgreSQL

## 1. Files
Upload these files to your GitHub repository:
- server.js
- package.json
- index_updated.html (rename to index.html)
- articles.html
- admin.html

## 2. Render Web Service
Create a Web Service from the GitHub repository.
- Build Command: npm install
- Start Command: npm start

## 3. Render PostgreSQL
Create a PostgreSQL database in Render.

Copy its Internal Database URL into the Web Service Environment Variables:
- DATABASE_URL = <Render Internal Database URL>
- NODE_ENV = production
- JWT_SECRET = make-a-long-random-secret
- ADMIN_PASSWORD_HASH = <bcrypt hash of your chosen admin password>

## 4. Create password hash locally
Run:
node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD', 12))"

Copy the printed hash into ADMIN_PASSWORD_HASH.
Do NOT put your real password in server.js or GitHub.

## 5. Routes
- /           Home
- /articles   Public articles
- /admin      Admin login + add/edit/delete

The database table is created automatically when the server starts.
